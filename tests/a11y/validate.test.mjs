import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScope, loadScope } from "./validate.mjs";

const front = () => ({
  version: 1,
  target: "http://settings-front:5000",
  session: { login_url: "http://core-api:3000/auth/login" },
  users: { agent: { email: "agent@mairie360.test", password: "x" } },
  criteria: ["1.1", "11.1"],
  states: [{ id: "profile", route: "/", as: "agent", steps: [{ click: { role: "tab", name: "Profil" } }] }],
});

test("the examples are valid", () => {
  loadScope(new URL("./examples/front.rgaa.yaml", import.meta.url).pathname);
  loadScope(new URL("./examples/lib.rgaa.yaml", import.meta.url).pathname);
});

test("a minimal front is valid and gets the default cookie name", () => {
  const scope = front();
  assert.deepEqual(checkScope(scope), []);
  assert.equal(scope.session.cookie, "accessToken");
});

test("an unknown criterion is reported with its value", () => {
  const scope = front();
  scope.criteria.push("4.14");
  assert.deepEqual(checkScope(scope), ['/criteria/2: must be equal to one of the allowed values (got "4.14")']);
});

test("a state needs exactly one of route or story", () => {
  const message = "/states/0: a state has either a route (front) or a story (lib-components)";
  const both = front();
  both.states[0].story = "components-button--primary";
  assert.ok(checkScope(both).includes(message));
  const none = front();
  delete none.states[0].route;
  assert.ok(checkScope(none).includes(message));
});

test("a wrong step gets one readable message", () => {
  const steps = (...list) => {
    const scope = front();
    scope.states[0].steps = list;
    return checkScope(scope);
  };
  assert.deepEqual(steps({ click: { role: "button" }, press: "Enter" }), [
    "/states/0/steps/0: a step is exactly one action among click, hover, fill, select, press, wait_for, wait_for_hidden, goto",
  ]);
  assert.deepEqual(steps({ click: {} }), [
    "/states/0/steps/0/click: needs a locator: one of role, label, text, test_id, selector",
  ]);
  assert.deepEqual(steps({ fill: { label: "Nom" } }), ["/states/0/steps/0/fill: must have required property 'value'"]);
});

test("cross references are checked", () => {
  const unknownUser = front();
  unknownUser.states[0].as = "admin";
  assert.deepEqual(checkScope(unknownUser), ['/states/profile: unknown user "admin" in "as"']);

  const noSession = front();
  delete noSession.session;
  assert.deepEqual(checkScope(noSession), ['/session: required when a state logs in with "as"']);

  const duplicate = front();
  duplicate.states.push({ id: "profile", route: "/profile" });
  assert.deepEqual(checkScope(duplicate), ['/states: duplicate state id "profile"']);

  const mixed = front();
  mixed.states.push({ id: "button", story: "components-button--primary" });
  assert.equal(checkScope(mixed).length, 1);
});
