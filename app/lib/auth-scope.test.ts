import assert from "node:assert/strict";
import test from "node:test";

import { TOKEN_SCOPES, scopeAllows } from "./auth-scope";

test("a full token reaches everything", () => {
  for (const required of TOKEN_SCOPES) {
    assert.equal(scopeAllows("full", required), true, required);
  }
});

test("a reminders token reaches only the reminders endpoints", () => {
  assert.equal(scopeAllows("reminders", "reminders"), true);
  assert.equal(scopeAllows("reminders", "full"), false);
});

test("anything unknown is denied, including odd types and casing", () => {
  for (const scope of ["", "FULL", "Full", "admin", "reminders ", " reminders", "*", null, undefined, 1, {}, ["full"]]) {
    for (const required of TOKEN_SCOPES) {
      assert.equal(scopeAllows(scope, required), false, `${JSON.stringify(scope)} -> ${required}`);
    }
  }
});

test("the scope list is exactly full and reminders", () => {
  assert.deepEqual([...TOKEN_SCOPES], ["full", "reminders"]);
});
