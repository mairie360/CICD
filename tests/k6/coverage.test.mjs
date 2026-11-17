// Unit tests of the OpenAPI coverage helper of the k6 load tests (MAIR-542).
// coverage.js imports k6 modules and uses the k6 globals: it is loaded here with those stubbed.
// Run: node --test tests/k6
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sent = [];
const metrics = { operations_uncovered: [], operation_handler_errors: [] };
globalThis.__k6 = {
  request: (method, url, body, params) => {
    sent.push({ method, url, body, params });
    return { status: 200 };
  },
  counter: (name) => ({ add: (value, tags) => metrics[name].push({ value, tags }) }),
};
globalThis.__ENV = {};

let dir;
let cov;
before(async () => {
  const source = readFileSync(join(here, 'coverage.js'), 'utf8')
    .replace("import http from 'k6/http';", 'const http = globalThis.__k6;')
    .replace("import { Counter } from 'k6/metrics';", 'const Counter = function (name) { return globalThis.__k6.counter(name); };');
  assert.ok(!/^import .* from 'k6\//m.test(source), 'every k6 import must be stubbed');
  dir = mkdtempSync(join(tmpdir(), 'k6-coverage-'));
  const file = join(dir, 'coverage.mjs');
  writeFileSync(file, source);
  cov = await import(pathToFileURL(file).href);
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

const spec = {
  servers: [{ url: 'https://svc.example/api/' }],
  paths: {
    '/health': { get: {} },
    '/users/{id}': { get: {}, delete: {}, parameters: [] },
  },
};
const handlers = (overrides = {}) => ({
  'GET /health': ({ request }) => request(),
  'GET /users/{id}': ({ request }) => request({ path: { id: 'a b' }, query: { q: ['x', 'y'], skip: undefined } }),
  'DELETE /users/{id}': ({ request }) => request({ path: { id: 1 } }),
  ...overrides,
});

describe('listOperations / serverBasePath', () => {
  it('lists one operation per method, in spec order, ignoring non-operation keys', () => {
    assert.deepEqual(
      cov.listOperations(spec).map((o) => o.op),
      ['GET /health', 'GET /users/{id}', 'DELETE /users/{id}'],
    );
  });
  it('reads the path prefix of the first server, without trailing slash', () => {
    assert.equal(cov.serverBasePath(spec), '/api');
    assert.equal(cov.serverBasePath({ servers: [{ url: '/v1' }] }), '/v1');
    assert.equal(cov.serverBasePath({}), '');
  });
});

describe('createCoverage init-time check', () => {
  it('throws when an operation has no handler', () => {
    const h = handlers();
    delete h['DELETE /users/{id}'];
    assert.throws(() => cov.createCoverage(h, { spec }), /operation "DELETE \/users\/\{id\}" has no handler/);
  });
  it('throws when a handler names no operation of the spec', () => {
    assert.throws(() => cov.createCoverage(handlers({ 'GET /ghost': () => {} }), { spec }), /matches no operation/);
  });
  it('throws on a malformed handler key and on a non-function handler', () => {
    assert.throws(() => cov.createCoverage(handlers({ health: () => {} }), { spec }), /not of the form/);
    assert.throws(() => cov.createCoverage(handlers({ 'GET /health': 'nope' }), { spec }), /not a function/);
  });
  it('throws on a spec without operation', () => {
    assert.throws(() => cov.createCoverage({}, { spec: { paths: {} } }), /declares no operation/);
  });
});

describe('createCoverage.run', () => {
  it('sends every request under the base path with tags and encoded parameters', () => {
    sent.length = 0;
    const c = cov.createCoverage(handlers(), { spec, baseUrl: 'http://svc:3000/' });
    c.run({ headers: { Authorization: 'Bearer t' } });
    assert.equal(sent.length, 3);
    assert.equal(sent[1].url, 'http://svc:3000/api/users/a%20b?q=x&q=y');
    assert.equal(sent[1].params.tags.op, 'GET /users/{id}');
    assert.equal(sent[1].params.headers.Authorization, 'Bearer t');
    assert.equal(sent[2].method, 'DELETE');
  });
  it('JSON-encodes plain object bodies and sets the content type', () => {
    sent.length = 0;
    const c = cov.createCoverage(
      handlers({ 'GET /health': ({ request }) => request({ body: { a: 1 } }) }),
      { spec, baseUrl: 'http://svc' },
    );
    c.run();
    assert.equal(sent[0].body, '{"a":1}');
    assert.equal(sent[0].params.headers['Content-Type'], 'application/json');
  });
  it('counts a handler that sends nothing as uncovered, and a throwing handler as an error', () => {
    metrics.operations_uncovered.length = 0;
    metrics.operation_handler_errors.length = 0;
    const c = cov.createCoverage(
      handlers({ 'GET /health': () => {}, 'DELETE /users/{id}': () => { throw new Error('boom'); } }),
      { spec, baseUrl: 'http://svc' },
    );
    const log = console.error;
    console.error = () => {};
    try {
      c.run();
    } finally {
      console.error = log;
    }
    assert.deepEqual(metrics.operations_uncovered.map((m) => m.tags.op), ['GET /health', 'DELETE /users/{id}']);
    assert.deepEqual(metrics.operation_handler_errors.map((m) => m.tags.op), ['DELETE /users/{id}']);
  });
  it('refuses a request that misses a path parameter', () => {
    const c = cov.createCoverage(handlers({ 'GET /users/{id}': ({ request }) => request() }), { spec, baseUrl: 'http://svc' });
    const log = console.error;
    console.error = () => {};
    metrics.operation_handler_errors.length = 0;
    try {
      c.run();
    } finally {
      console.error = log;
    }
    assert.equal(metrics.operation_handler_errors.length, 1);
  });
  it('exposes thresholds that require zero uncovered operations and handler errors', () => {
    assert.deepEqual(cov.coverageThresholds, {
      operations_uncovered: ['count==0'],
      operation_handler_errors: ['count==0'],
    });
  });
});
