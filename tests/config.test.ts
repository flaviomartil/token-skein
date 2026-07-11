import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { CURRENT_CONFIG_SCHEMA_VERSION, loadConfig, migrateConfigSchema } from "../src/config.ts";

const ENV_KEYS = [
  "TOKEN_SKEIN_CONFIG",
  "TOKEN_SKEIN_PORT",
  "TOKEN_SKEIN_HOST",
  "TOKEN_SKEIN_MAX_REQUEST_BYTES",
  "TOKEN_SKEIN_UPSTREAM_TIMEOUT_MS",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function writeConfigFile(contents: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "token-skein-config-test-"));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(contents), "utf8");
  return path;
}

describe("migrateConfigSchema", () => {
  test("migrates a schema_version 1 config to the current version", () => {
    const migrated = migrateConfigSchema({ schemaVersion: 1, host: "0.0.0.0" });
    expect(migrated.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(migrated.archive).toEqual({ maxBytes: 200 * 1024 * 1024 });
    expect(migrated.host).toBe("0.0.0.0");
  });

  test("treats a config without schema_version as version 1", () => {
    const migrated = migrateConfigSchema({ host: "0.0.0.0" });
    expect(migrated.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
  });

  test("throws a clear error for an unsupported future schema_version", () => {
    expect(() => migrateConfigSchema({ schemaVersion: 99 })).toThrow(
      /Unsupported token-skein config schema_version 99/,
    );
  });

  test("passes through a config already on the current schema_version", () => {
    const migrated = migrateConfigSchema({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, host: "10.0.0.1" });
    expect(migrated).toEqual({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, host: "10.0.0.1" });
  });
});

describe("loadConfig", () => {
  test("migrates a legacy config file on load", async () => {
    process.env.TOKEN_SKEIN_CONFIG = await writeConfigFile({ schemaVersion: 1, host: "legacy-host" });
    const config = await loadConfig();
    expect(config.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(config.host).toBe("legacy-host");
    expect(config.archive.maxBytes).toBe(200 * 1024 * 1024);
  });

  test("rejects a config file on an unsupported future schema_version", async () => {
    process.env.TOKEN_SKEIN_CONFIG = await writeConfigFile({ schemaVersion: 99 });
    await expect(loadConfig()).rejects.toThrow(/Unsupported token-skein config schema_version 99/);
  });

  test("ignores a non-numeric TOKEN_SKEIN_PORT instead of producing NaN", async () => {
    delete process.env.TOKEN_SKEIN_CONFIG;
    process.env.TOKEN_SKEIN_PORT = "not-a-number";
    const config = await loadConfig();
    expect(Number.isFinite(config.port)).toBe(true);
    expect(config.port).not.toBeNaN();
  });

  test("applies a valid TOKEN_SKEIN_PORT override", async () => {
    delete process.env.TOKEN_SKEIN_CONFIG;
    process.env.TOKEN_SKEIN_PORT = "9999";
    const config = await loadConfig();
    expect(config.port).toBe(9999);
  });

  test("ignores non-numeric limits env overrides instead of producing NaN", async () => {
    delete process.env.TOKEN_SKEIN_CONFIG;
    process.env.TOKEN_SKEIN_MAX_REQUEST_BYTES = "lots";
    process.env.TOKEN_SKEIN_UPSTREAM_TIMEOUT_MS = "soon";
    const config = await loadConfig();
    expect(Number.isFinite(config.limits.maxRequestBytes)).toBe(true);
    expect(Number.isFinite(config.limits.upstreamTimeoutMs)).toBe(true);
  });

  test("applies valid limits env overrides", async () => {
    delete process.env.TOKEN_SKEIN_CONFIG;
    process.env.TOKEN_SKEIN_MAX_REQUEST_BYTES = "1048576";
    process.env.TOKEN_SKEIN_UPSTREAM_TIMEOUT_MS = "45000";
    const config = await loadConfig();
    expect(config.limits.maxRequestBytes).toBe(1048576);
    expect(config.limits.upstreamTimeoutMs).toBe(45000);
  });
});
