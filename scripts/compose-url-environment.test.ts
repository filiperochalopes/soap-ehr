import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url).pathname;

const databaseUrl = "postgresql://clinic%40example%3Ateam%2Fservice:pass%3Awith%2Fslash%40sign@soap-ehr-db:5432/soap_ehr";
const omopDatabaseUrl = "postgresql://clinic%40example%3Ateam%2Fservice:pass%3Awith%2Fslash%40sign@soap-ehr-db:5432/soap_ehr";
const v1DatabaseUrl = "mysql://clinic%40example%3Ateam%2Fservice:pass%3Awith%2Fslash%40sign@soap-ehr-db-legacy:3306/fhir_soap_record";

function assertServiceUrls(
  config: { services: Record<string, { environment: Record<string, string> }> },
  services: readonly string[],
) {
  for (const service of services) {
    assert.equal(config.services[service]?.environment.DATABASE_URL, databaseUrl);
    assert.equal(config.services[service]?.environment.OMOP_DATABASE_URL, omopDatabaseUrl);
    assert.equal(config.services[service]?.environment.V1_DATABASE_URL, v1DatabaseUrl);
  }
}

function readEnvironmentValue(name: string) {
  const line = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
    .split("\n")
    .find((item) => item.startsWith(`${name}=`));
  return line?.slice(name.length + 1).replace(/^"|"$/g, "");
}

test("encoded URL fixture covers reserved characters in username and password", () => {
  for (const url of [databaseUrl, omopDatabaseUrl, v1DatabaseUrl]) {
    assert.match(url, /clinic%40example%3Ateam%2Fservice/);
    assert.match(url, /pass%3Awith%2Fslash%40sign/);
  }
});

test("documented Docker URLs target database service DNS names", () => {
  assert.equal(
    readEnvironmentValue("DATABASE_URL"),
    "postgresql://clinic:clinic@soap-ehr-db:5432/soap_ehr",
  );
  assert.equal(
    readEnvironmentValue("OMOP_DATABASE_URL"),
    "postgresql://clinic:clinic@soap-ehr-db:5432/soap_ehr",
  );
  assert.equal(
    readEnvironmentValue("V1_DATABASE_URL"),
    "mysql://clinic:clinic@soap-ehr-db-legacy:3306/fhir_soap_record",
  );
});

test("Compose preserves explicitly encoded migration URLs", (t) => {
  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    OMOP_DATABASE_URL: omopDatabaseUrl,
    V1_DATABASE_URL: v1DatabaseUrl,
  };

  for (const [composeFile, services] of [
    ["compose.yml", ["soap-ehr", "soap-ehr-migration"]],
    ["compose.dev.yml", ["soap-ehr", "soap-ehr-migration"]],
  ] as const) {
    const result = spawnSync(
      "docker",
      ["compose", "-f", composeFile, "--profile", "migration", "config", "--format", "json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
    });

    if (result.error && "code" in result.error && result.error.code === "ENOENT") {
      t.skip("Docker CLI is unavailable in this runtime; run this contract on the host.");
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assertServiceUrls(JSON.parse(result.stdout), services);
  }
});
