import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const databaseUrl = "postgresql://clinic%40example%3Ateam%2Fservice:pass%3Awith%2Fslash%40sign@soap-ehr-db:5432/soap_ehr";

function readEnvironmentValue(name: string) {
  const line = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
    .split("\n")
    .find((item) => item.startsWith(`${name}=`));
  return line?.slice(name.length + 1).replace(/^"|"$/g, "");
}

test("documented Docker URLs target the PostgreSQL service", () => {
  for (const name of ["DATABASE_URL", "OMOP_DATABASE_URL"]) {
    assert.equal(new URL(readEnvironmentValue(name)!).hostname, "soap-ehr-db");
  }
  assert.equal(readEnvironmentValue("V1_DATABASE_URL"), undefined);
});

test("Compose preserves encoded PostgreSQL URLs without legacy services", (t) => {
  const omopDatabaseUrl = `${databaseUrl}?application_name=omop`;
  for (const composeFiles of [["compose.yml"], ["compose.dev.yml"], ["compose.yml", "compose.dev.yml"]]) {
    const fileArgs = composeFiles.flatMap((file) => ["-f", file]);
    const result = spawnSync("docker", ["compose", ...fileArgs, "--profile", "*", "config", "--format", "json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl, OMOP_DATABASE_URL: omopDatabaseUrl },
    });
    if (result.error && "code" in result.error && result.error.code === "ENOENT") {
      t.skip("Docker CLI is unavailable in this runtime; run this contract on the host.");
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.services["soap-ehr"].environment.DATABASE_URL, databaseUrl);
    assert.equal(config.services["soap-ehr"].environment.OMOP_DATABASE_URL, omopDatabaseUrl);
    assert.equal(config.services["soap-ehr-db"].image, "postgres:17-alpine");
    assert.equal(config.services["soap-ehr-db-legacy"], undefined);
    assert.equal(config.services["soap-ehr-db-legacy-init"], undefined);
    assert.equal(config.services["soap-ehr-migration"], undefined);
  }
});
