import assert from "node:assert/strict";
import test from "node:test";

// The module reads and validates process.env at import time.
process.env.DATABASE_URL ??= "postgresql://clinic:clinic@localhost:5432/soap_ehr";
process.env.API_DRY_RUN = "true";

const { getFhirStore } = await import("./store.server");

function patientResource() {
  return {
    resourceType: "Patient",
    active: true,
    identifier: [{ system: "urn:test", value: "local-fhir-delete-test" }],
    name: [{ text: "Paciente Local de Teste" }],
    gender: "unknown",
  };
}

function appointmentResource(patientId: string) {
  return {
    resourceType: "Appointment",
    status: "booked",
    start: "2030-01-08T13:00:00.000Z",
    end: "2030-01-08T13:30:00.000Z",
    appointmentType: { text: "Teste local" },
    participant: [{ actor: { reference: `Patient/${patientId}` }, status: "accepted" }],
  };
}

test("dry-run store deletes Appointment before deleting its Patient", async () => {
  const store = getFhirStore();
  const patient = await store.savePatient(patientResource(), 1);
  const appointment = await store.saveAppointment(appointmentResource(patient.id), 1);

  await assert.rejects(store.deletePatient(patient.id), /Appointment resources still reference/);
  assert.equal(await store.deleteAppointment(appointment.id), true);
  assert.equal(await store.getAppointment(appointment.id), null);
  assert.equal(await store.deletePatient(patient.id), true);
  assert.equal(await store.getPatient(patient.id), null);
});
