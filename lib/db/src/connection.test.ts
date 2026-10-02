import assert from "node:assert/strict";
import test from "node:test";
import { getDatabaseConnectionString } from "./connection";

test("defaults to the existing Replit DATABASE_URL", () => {
  assert.equal(
    getDatabaseConnectionString({ DATABASE_URL: "postgres://replit-db" } as NodeJS.ProcessEnv),
    "postgres://replit-db",
  );
});

test("selects a separate external URL without replacing DATABASE_URL", () => {
  assert.equal(
    getDatabaseConnectionString({
      DATABASE_SOURCE: "external",
      DATABASE_URL: "postgres://replit-db",
      EXTERNAL_DATABASE_URL: "postgres://external-db",
    } as NodeJS.ProcessEnv),
    "postgres://external-db",
  );
});

test("fails explicitly for an external source without its own connection string", () => {
  assert.throws(
    () => getDatabaseConnectionString({ DATABASE_SOURCE: "external", DATABASE_URL: "postgres://replit-db" } as NodeJS.ProcessEnv),
    /EXTERNAL_DATABASE_URL must be set/,
  );
});