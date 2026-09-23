// OpenAPI coverage gate for k6 load tests.
//
// Shared by every API and BFF repo of the org. Mount it next to the spec in the
// k6 container and import it from `load-test.js`:
//
//   k6-perf-test:
//     image: grafana/k6:latest
//     volumes:
//       - ./load-test.js:/load-test.js:ro
//       - ./openapi.json:/openapi.json:ro
//       - ./cicd-repo/tests/k6/coverage.js:/coverage.js:ro
//     environment:
//       BASE_URL: http://my-service:4000
//     command: ["run", "/load-test.js"]
//
//   // load-test.js
//   import { createCoverage } from '/coverage.js';
//   const coverage = createCoverage({
//     'GET /health': ({ request }) => check(request(), { 'health 200': (r) => r.status === 200 }),
//     'GET /user/{userId}/about': ({ request }) => request({ path: { userId: USER_ID } }),
//     ...one handler per operation of openapi.json...
//   });
//   export const options = { stages: [...], thresholds: { ...coverage.thresholds, ... } };
//   export default function (data) {
//     coverage.run({ headers: { Authorization: `Bearer ${data.token}` } });
//   }
//
// Guarantees:
//
// 1. Init-time check: every operation (method + path) of the spec must have a
//    handler, and every handler must name an operation of the spec. Otherwise
//    `createCoverage` throws, k6 aborts before sending a single request and
//    exits non-zero.
// 2. Every request sent through `request()` is tagged `op: "METHOD /path"`,
//    so thresholds can target one operation (`http_req_duration{op:GET /me}`).
// 3. Runtime check: `run()` calls every handler once per iteration. A handler
//    that ends without sending its operation's request increments the
//    `operations_uncovered` counter (threshold `count==0`), and a handler that
//    throws increments `operation_handler_errors` (threshold `count==0`).
//
// Environment variables read by the module:
//   BASE_URL      root of the service under test (default http://localhost:3000)
//   OPENAPI_SPEC  path of the spec inside the container (default /openapi.json)

import http from 'k6/http';
import { Counter } from 'k6/metrics';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const OPERATION_KEY = /^(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE) \/\S*$/;

export const operationsUncovered = new Counter('operations_uncovered');
export const operationHandlerErrors = new Counter('operation_handler_errors');

/** Thresholds to spread into `options.thresholds`. */
export const coverageThresholds = {
  operations_uncovered: ['count==0'],
  operation_handler_errors: ['count==0'],
};

/** Read and parse the spec (init context only, `open()` is not available later). */
export function loadSpec(path = __ENV.OPENAPI_SPEC || '/openapi.json') {
  return JSON.parse(open(path));
}

/** One `{ op, method, path }` per operation of the spec, in spec order. */
export function listOperations(spec) {
  const operations = [];
  const paths = spec.paths || {};
  for (const path of Object.keys(paths)) {
    const item = paths[path];
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      if (!item[method] || typeof item[method] !== 'object') continue;
      operations.push({ op: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path });
    }
  }
  return operations;
}

/** Path prefix declared by `servers[0].url`, if any (e.g. "/api"). */
export function serverBasePath(spec) {
  const servers = spec.servers || [];
  const url = servers.length && servers[0] && servers[0].url ? String(servers[0].url) : '';
  if (!url) return '';
  const path = url.includes('://') ? url.replace(/^[a-z]+:\/\/[^/]*/i, '') : url;
  return path.replace(/\/+$/, '');
}

/**
 * Build the coverage runner.
 *
 * @param {Object<string, function>} handlers  `{ 'GET /path': ({ request, op, method, path, url }) => ... }`
 * @param {Object} [options]
 * @param {Object} [options.spec]       parsed spec (default: `loadSpec()`)
 * @param {string} [options.baseUrl]    service root (default: `__ENV.BASE_URL` or http://localhost:3000)
 * @param {string} [options.basePath]   prefix in front of every path (default: from `servers[0].url`)
 */
export function createCoverage(handlers, options = {}) {
  const spec = options.spec || loadSpec();
  const operations = listOperations(spec);
  const baseUrl = (options.baseUrl || __ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const basePath = options.basePath !== undefined ? options.basePath : serverBasePath(spec);

  if (operations.length === 0) {
    throw new Error('openapi coverage: the spec declares no operation under `paths`');
  }
  const problems = [];
  const handlerKeys = Object.keys(handlers || {});
  const known = new Set(operations.map((o) => o.op));
  for (const key of handlerKeys) {
    if (!OPERATION_KEY.test(key)) {
      problems.push(`handler "${key}" is not of the form "METHOD /path"`);
    } else if (!known.has(key)) {
      problems.push(`handler "${key}" matches no operation of the spec`);
    } else if (typeof handlers[key] !== 'function') {
      problems.push(`handler "${key}" is not a function`);
    }
  }
  for (const operation of operations) {
    if (!(operation.op in (handlers || {}))) {
      problems.push(`operation "${operation.op}" has no handler`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `openapi coverage: ${problems.length} problem(s) between the spec and load-test.js:\n  - ${problems.join('\n  - ')}\n` +
        'Add one handler per operation (see mairie360/CICD README, "OpenAPI coverage gate").',
    );
  }

  function buildUrl(operation, pathParams = {}, query) {
    const rendered = operation.path.replace(/\{([^}]+)\}/g, (_, name) => {
      if (pathParams[name] === undefined || pathParams[name] === null) {
        throw new Error(`openapi coverage: ${operation.op} needs path parameter "${name}"`);
      }
      return encodeURIComponent(String(pathParams[name]));
    });
    let url = `${baseUrl}${basePath}${rendered}`;
    if (query && Object.keys(query).length > 0) {
      const pairs = [];
      for (const key of Object.keys(query)) {
        const values = Array.isArray(query[key]) ? query[key] : [query[key]];
        for (const value of values) {
          if (value === undefined || value === null) continue;
          pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
      }
      if (pairs.length > 0) url += `?${pairs.join('&')}`;
    }
    return url;
  }

  function mergeHeaders(...sources) {
    const headers = {};
    for (const source of sources) {
      if (!source) continue;
      for (const key of Object.keys(source)) headers[key] = source[key];
    }
    return headers;
  }

  function makeRequester(operation, defaults, sent) {
    /**
     * Send the operation's request.
     * @param {Object} [call]
     * @param {Object} [call.path]     path parameters (`{ userId: 2 }`)
     * @param {Object} [call.query]    query parameters
     * @param {*}      [call.body]     request body; plain objects are JSON-encoded
     * @param {Object} [call.headers]  extra headers (merged over `run()` defaults)
     * @param {Object} [call.params]   extra k6 params (merged, tags are kept)
     */
    return function request(call = {}) {
      const url = buildUrl(operation, call.path, call.query);
      let body = call.body === undefined ? null : call.body;
      const headers = mergeHeaders(defaults.headers, call.headers);
      if (body !== null && typeof body === 'object' && !(body instanceof ArrayBuffer)) {
        body = JSON.stringify(body);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
      const params = Object.assign({}, defaults.params, call.params);
      params.headers = mergeHeaders(headers, call.params && call.params.headers);
      params.tags = Object.assign({}, defaults.params && defaults.params.tags, call.params && call.params.tags, {
        op: operation.op,
      });
      sent.count += 1;
      return http.request(operation.method, url, body, params);
    };
  }

  return {
    operations,
    baseUrl,
    basePath,
    thresholds: coverageThresholds,
    /** Absolute URL of an operation, for handlers that need it (redirect checks, etc.). */
    url: (op, pathParams, query) => {
      const operation = operations.find((o) => o.op === op);
      if (!operation) throw new Error(`openapi coverage: unknown operation "${op}"`);
      return buildUrl(operation, pathParams, query);
    },
    /**
     * Run every handler once.
     * @param {Object} [defaults]
     * @param {Object} [defaults.headers]  headers added to every request (e.g. Authorization)
     * @param {Object} [defaults.params]   k6 params added to every request
     * @param {*}      [defaults.data]     anything the handlers need (setup() data, ids...)
     */
    run(defaults = {}) {
      for (const operation of operations) {
        const sent = { count: 0 };
        const api = {
          op: operation.op,
          method: operation.method,
          path: operation.path,
          data: defaults.data,
          request: makeRequester(operation, defaults, sent),
          url: (pathParams, query) => buildUrl(operation, pathParams, query),
        };
        try {
          handlers[operation.op](api);
        } catch (error) {
          operationHandlerErrors.add(1, { op: operation.op });
          console.error(`openapi coverage: handler for ${operation.op} threw: ${error}`);
        }
        if (sent.count === 0) {
          operationsUncovered.add(1, { op: operation.op });
        }
      }
    },
  };
}
