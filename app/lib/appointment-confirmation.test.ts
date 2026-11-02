import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfirmationInputError,
  decideConfirmation,
  parsePatientResponse,
} from "./appointment-confirmation";

const booked = (confirmationStatus: string) => ({ status: "booked", confirmationStatus });

test("parses the three patient responses and nothing else", () => {
  for (const ok of ["confirmed", "declined", "no_response"]) {
    assert.equal(parsePatientResponse(ok), ok);
  }
  for (const bad of ["", "yes", "no", "CONFIRMED", "pending", null, undefined, 1, {}]) {
    assert.throws(() => parsePatientResponse(bad), ConfirmationInputError, JSON.stringify(bad));
  }
});

test("confirming a booked appointment records it; repeating is a no-op", () => {
  for (const from of ["pending", "no_response"]) {
    assert.deepEqual(decideConfirmation(booked(from), "confirmed"), { kind: "apply", confirmationStatus: "confirmed" });
  }
  assert.deepEqual(decideConfirmation(booked("confirmed"), "confirmed"), { kind: "noop" });
});

test("declining cancels the appointment, from any booked state", () => {
  for (const from of ["pending", "confirmed", "no_response"]) {
    assert.deepEqual(decideConfirmation(booked(from), "declined"), {
      kind: "apply",
      confirmationStatus: "declined",
      appointmentStatus: "cancelled",
    });
  }
});

test("declining twice is idempotent: the second call changes nothing", () => {
  assert.deepEqual(decideConfirmation({ status: "cancelled", confirmationStatus: "declined" }, "declined"), { kind: "noop" });
});

test("silence is recorded once and never overrides a real answer", () => {
  assert.deepEqual(decideConfirmation(booked("pending"), "no_response"), { kind: "apply", confirmationStatus: "no_response" });
  assert.deepEqual(decideConfirmation(booked("no_response"), "no_response"), { kind: "noop" });
  assert.deepEqual(decideConfirmation(booked("confirmed"), "no_response"), { kind: "noop" });
  assert.deepEqual(decideConfirmation({ status: "cancelled", confirmationStatus: "declined" }, "no_response"), { kind: "noop" });
});

test("a patient who declined cannot silently re-confirm: the slot may be gone, a human decides", () => {
  assert.deepEqual(decideConfirmation({ status: "cancelled", confirmationStatus: "declined" }, "confirmed"), {
    kind: "conflict",
    reason: "already_cancelled",
  });
});

test("only booked appointments take a response", () => {
  for (const status of ["pending", "proposed", "fulfilled", "arrived", "noshow", "entered-in-error", "cancelled"]) {
    for (const response of ["confirmed", "declined"] as const) {
      const decision = decideConfirmation({ status, confirmationStatus: "pending" }, response);
      assert.deepEqual(decision, { kind: "conflict", reason: "not_booked" }, `${status}/${response}`);
    }
  }
});

test("a late silence mark on a non-booked appointment is ignored, not an error", () => {
  assert.deepEqual(decideConfirmation({ status: "fulfilled", confirmationStatus: "pending" }, "no_response"), { kind: "noop" });
  assert.deepEqual(decideConfirmation({ status: "cancelled", confirmationStatus: "pending" }, "no_response"), { kind: "noop" });
});
