#!/usr/bin/env node
// Validates the rgaa.yaml of a front or of lib-components (MAIR-316).
//
//   node validate.mjs path/to/rgaa.yaml [...]
//
// Exits 1 with one GitHub annotation per problem. The engine (MAIR-318) imports
// loadScope() so that it only ever plays a scope that passed these checks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const schema = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "rgaa.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, useDefaults: true, verbose: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

// A wrong step fails every branch of the step `oneOf`, which buries the actual problem
// under one error per action: steps are reported here instead, against their own action.
const STEP_PATH = /^\/states\/\d+\/steps\/\d+(\/|$)/;
const stepValidators = Object.fromEntries(
  schema.$defs.step.oneOf.map((branch, i) => {
    const [action] = branch.required;
    return [action, ajv.compile({ $ref: `${schema.$id}#/$defs/step/oneOf/${i}/properties/${action}` })];
  }),
);
const LOCATOR_KEYS = schema.$defs.locator.oneOf.map((branch) => branch.required[0]);
const STATE_PATH = /^\/states\/\d+$/;

function format(error, prefix = "") {
  const value =
    error.keyword === "enum"
      ? ` (got ${JSON.stringify(error.data)})`
      : error.keyword === "additionalProperties"
        ? ` ("${error.params.additionalProperty}")`
        : "";
  return `${prefix}${error.instancePath}: ${error.message}${value}`.replace(/^:/, "/:");
}

// Same idea for the route-vs-story `oneOf` of a state.
function checkStates(scope) {
  const errors = [];
  (Array.isArray(scope?.states) ? scope.states : []).forEach((state, s) => {
    if (!state || typeof state !== "object") return;
    if (Boolean(state.route) === Boolean(state.story)) {
      errors.push(`/states/${s}: a state has either a route (front) or a story (lib-components)`);
    } else if (state.story && state.as) {
      errors.push(`/states/${s}: a story state cannot log in with "as"`);
    }
  });
  return errors;
}

function checkSteps(scope) {
  const errors = [];
  (Array.isArray(scope?.states) ? scope.states : []).forEach((state, s) => {
    (Array.isArray(state?.steps) ? state.steps : []).forEach((step, i) => {
      const path = `/states/${s}/steps/${i}`;
      const actions = step && typeof step === "object" ? Object.keys(step) : [];
      if (actions.length !== 1 || !(actions[0] in stepValidators)) {
        errors.push(`${path}: a step is exactly one action among ${Object.keys(stepValidators).join(", ")}`);
        return;
      }
      const validate = stepValidators[actions[0]];
      if (!validate(step[actions[0]])) {
        const missingLocator = validate.errors.some(
          (e) => e.instancePath === "" && e.keyword === "required" && LOCATOR_KEYS.includes(e.params.missingProperty),
        );
        const own = validate.errors.filter(
          (e) => e.keyword !== "oneOf" && !(missingLocator && e.keyword === "required" && LOCATOR_KEYS.includes(e.params.missingProperty)),
        );
        if (missingLocator) errors.push(`${path}/${actions[0]}: needs a locator: one of ${LOCATOR_KEYS.join(", ")}`);
        errors.push(...own.map((e) => format(e, `${path}/${actions[0]}`)));
      }
    });
  });
  return errors;
}

// Rules the JSON Schema cannot express: references between states and users.
function crossCheck(scope) {
  const errors = [];
  const seen = new Set();
  for (const state of scope.states) {
    if (seen.has(state.id)) errors.push(`/states: duplicate state id "${state.id}"`);
    seen.add(state.id);
  }

  const routes = scope.states.filter((s) => s.route);
  if (routes.length > 0 && routes.length < scope.states.length) {
    errors.push("/states: mix of route and story states; a front uses routes, lib-components uses stories");
  }

  const users = scope.users ?? {};
  const logged = scope.states.filter((s) => s.as);
  for (const state of logged) {
    if (!(state.as in users)) errors.push(`/states/${state.id}: unknown user "${state.as}" in "as"`);
  }
  if (logged.length > 0 && !scope.session) {
    errors.push("/session: required when a state logs in with \"as\"");
  }
  return errors;
}

export function checkScope(scope) {
  if (!validateSchema(scope)) {
    const others = validateSchema.errors.filter(
      (e) => !STEP_PATH.test(e.instancePath) && !(STATE_PATH.test(e.instancePath) && ["oneOf", "not", "required"].includes(e.keyword) && e.params.missingProperty !== "id"),
    );
    return [...new Set([...others.map((e) => format(e)), ...checkStates(scope), ...checkSteps(scope)])];
  }
  return crossCheck(scope);
}

export function loadScope(file) {
  const scope = parse(readFileSync(file, "utf8"));
  const errors = checkScope(scope);
  if (errors.length > 0) {
    const error = new Error(`${file}: invalid rgaa.yaml`);
    error.details = errors;
    throw error;
  }
  return scope;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node validate.mjs path/to/rgaa.yaml [...]");
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    try {
      loadScope(file);
      console.log(`${file}: valid`);
    } catch (error) {
      failed = true;
      for (const detail of error.details ?? [error.message]) {
        console.log(`::error file=${file}::${detail}`);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}
