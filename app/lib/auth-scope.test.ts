import assert from "node:assert/strict";
import test from "node:test";

import { TOKEN_SCOPES, scopeAllows } from "./auth-scope";

/** Who may reach what, one row per token scope. A required scope is the name an endpoint asks for. */
const MATRIX: Record<string, Record<string, boolean>> = {
  full: { full: true, reminders: true, report: true, agent: false },
  reminders: { full: false, reminders: true, report: false, agent: false },
  report: { full: false, reminders: true, report: true, agent: false },
  agent: { full: false, reminders: false, report: false, agent: true },
};

test("each token scope reaches exactly what the matrix says", () => {
  for (const [tokenScope, row] of Object.entries(MATRIX)) {
    for (const required of TOKEN_SCOPES) {
      assert.equal(scopeAllows(tokenScope, required), row[required], `${tokenScope} -> ${required}`);
    }
  }
});

test("a full token cannot reach the agent endpoint, so a leaked agent URL needs an agent token", () => {
  assert.equal(scopeAllows("full", "agent"), false);
});

test("a report token reaches the reminder endpoints but not patient records", () => {
  assert.equal(scopeAllows("report", "reminders"), true);
  assert.equal(scopeAllows("report", "full"), false);
});

test("an agent token reaches nothing but the agent endpoint", () => {
  for (const required of TOKEN_SCOPES) {
    assert.equal(scopeAllows("agent", required), required === "agent", required);
  }
});

test("anything unknown is denied, including odd types and casing", () => {
  const unknown = ["", "FULL", "Full", "admin", "reminders ", " reminders", "Agent", "report ", "*", null, undefined, 1, {}, ["full"]];
  for (const scope of unknown) {
    for (const required of TOKEN_SCOPES) {
      assert.equal(scopeAllows(scope, required), false, `${JSON.stringify(scope)} -> ${required}`);
    }
  }
});

test("the scope list is exactly full, reminders, report and agent", () => {
  assert.deepEqual([...TOKEN_SCOPES], ["full", "reminders", "report", "agent"]);
});
