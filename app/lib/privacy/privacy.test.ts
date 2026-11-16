import assert from "node:assert/strict";
import test from "node:test";

import { agentAge, agentInitials, agentMention } from "./agent-identity";
import { buildAnonymizedSoapText } from "../soap-plugins/anonymize";
import { scrubClinicalText } from "./scrub";

const NOW = new Date("2026-11-12T15:00:00Z");

test("scrub removes CPF, CNS, phone and e-mail", () => {
  const out = scrubClinicalText(
    "CPF 123.456.789-09, CNS 898 0000 1234 5678, outro CNS 700123456789012, tel (11) 91234-5678, a@b.com.br",
  );
  assert.equal(
    out,
    "CPF [REMOVIDO], CNS [REMOVIDO], outro CNS [REMOVIDO], tel [REMOVIDO], [REMOVIDO]",
  );
});

test("scrub keeps clinical numbers that are not identifiers", () => {
  const text = "PA 130x85 mmHg, glicemia 142 mg/dL, HbA1c 7,4%, FC 76 bpm, peso 72,5 kg";
  assert.equal(scrubClinicalText(text), text);
});

test("scrub replaces the patient's and contacts' names and keeps the rest", () => {
  const out = scrubClinicalText("Marina veio com a mãe Rosa. Sra. Almeida refere dor. Rosa nega febre.", {
    patientName: "Marina Almeida",
    contactNames: ["Rosa Prates"],
  });
  assert.equal(out, "[PACIENTE] veio com a mãe [CONTATO]. Sra. [PACIENTE] refere dor. [CONTATO] nega febre.");
});

test("scrub collapses a full name into one placeholder", () => {
  const out = scrubClinicalText("Paciente Marina Almeida, 42 anos.", { patientName: "Marina Almeida" });
  assert.equal(out, "Paciente [PACIENTE], 42 anos.");
});

test("scrub matches names ignoring case, accents, NBSP and invisible characters", () => {
  const out = scrubClinicalText("JOÃO e Joao e Jo\u200Bão e joão\u00A0silva", {
    patientName: "João da Silva",
  });
  assert.equal(out, "[PACIENTE] e [PACIENTE] e [PACIENTE] e [PACIENTE]");
});

test("scrub only replaces whole words and skips particles and short words", () => {
  const out = scrubClinicalText("Mariana e Ana de Souza, Lima fruta, limão", {
    patientName: "Ana de Lima",
    contactNames: ["Jo"],
  });
  assert.equal(out, "Mariana e [PACIENTE] de Souza, [PACIENTE] fruta, limão");
});

test("scrub gives the patient precedence when a word is in both names", () => {
  const out = scrubClinicalText("Prates e Rosa", { patientName: "Marina Prates", contactNames: ["Rosa Prates"] });
  assert.equal(out, "[PACIENTE] e [CONTATO]");
});

test("scrub without names only applies the patterns", () => {
  assert.equal(scrubClinicalText("  Marina  "), "Marina");
});

test("agent age: years from 1 year on, completed months below", () => {
  const at = (birth: string) => agentAge(birth, { now: NOW });
  assert.equal(at("1984-08-14"), "42 anos");
  assert.equal(at("1984-11-12"), "42 anos");
  assert.equal(at("1984-11-13"), "41 anos");
  assert.equal(at("2024-12-01"), "1 ano");
  assert.equal(at("2026-11-12"), "0 meses");
  assert.equal(at("2026-10-22"), "0 meses");
  assert.equal(at("2026-10-12"), "1 mês");
  assert.equal(at("2025-11-13"), "11 meses");
  assert.equal(at("2025-11-12"), "1 ano");
});

test("agent age is null without a usable birth date", () => {
  assert.equal(agentAge(null, { now: NOW }), null);
  assert.equal(agentAge(undefined, { now: NOW }), null);
  assert.equal(agentAge("2027-01-01", { now: NOW }), null);
});

test("agent initials skip particles and accents", () => {
  assert.equal(agentInitials("Marina Almeida"), "MA");
  assert.equal(agentInitials("João da Silva e Souza"), "JSS");
  assert.equal(agentInitials("  álvaro   de  Campos "), "AC");
  assert.equal(agentInitials(""), "");
});

test("agent mention uses the database id", () => {
  assert.equal(agentMention(42), "@P42");
});

test("summary plugin text removes CNS and the record's names, in the current note and the history", () => {
  const result = buildAnonymizedSoapText({
    patient: { birthDate: "1984-08-14", gender: "female" },
    names: { patientName: "Marina Almeida", contactNames: ["Rosa Prates"] },
    current: { subjective: "CNS 898 0000 1234 5678. Veio com a mãe Rosa.", objective: "", assessment: "", plan: "" },
    history: [
      {
        subjective: "Marina refere insônia, CPF 123.456.789-09.",
        objective: "",
        assessment: "",
        plan: "",
        encounteredAt: "2026-10-01",
      },
    ],
    now: NOW,
  });

  assert.ok(result);
  assert.match(result.text, /CNS \[REMOVIDO\]\. Veio com a mãe \[CONTATO\]\./);
  assert.match(result.text, /\[PACIENTE\] refere insônia, CPF \[REMOVIDO\]\./);
  assert.doesNotMatch(result.text, /898|Marina|Rosa|123\.456/);
});

test("scrub leaves words shorter than three letters alone", () => {
  const out = scrubClinicalText("Jo veio com Ana", { patientName: "Ana Souza", contactNames: ["Jo"] });
  assert.equal(out, "Jo veio com [PACIENTE]");
});

test("scrub removes a decomposed accent that ends the name", () => {
  const out = scrubClinicalText("Jose\u0301 chegou", { patientName: "José" });
  assert.equal(out, "[PACIENTE] chegou");
});
