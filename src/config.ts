import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { TokenSkeinConfig, JsonObject } from "./types.ts";

const home = homedir();

export const CURRENT_CONFIG_SCHEMA_VERSION = 2;

export const DEFAULT_CONFIG: TokenSkeinConfig = {
  schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
  host: "127.0.0.1",
  port: 8788,
  upstream: "https://api.openai.com",
  storeDirectory: join(home, ".token-skein", "store"),
  eventsPath: join(home, ".token-skein", "events.jsonl"),
  compression: {
    enabled: true,
    minimumBytes: 6000,
    recentInputItems: 4,
    maximumSummaryLines: 120,
    ttlSeconds: 21_600,
  },
  vision: {
    enabled: false,
    models: ["gpt-5.6"],
    minimumBytes: 24_000,
    maximumPages: 4,
    estimatedTokensPerPage: 1600,
    minimumSavingsRatio: 1.5,
  },
  style: {
    enabled: true,
    instruction:
      "[TokenSkein output policy] Be concise and direct. Preserve technical details, exact commands, paths, errors, identifiers, security warnings, and irreversible-action confirmations. Avoid filler and repeated summaries.",
  },
  routing: {
    enabled: true,
    overrideExisting: false,
  },
  shell: {
    enabled: false,
    preferRtk: true,
    minimumBytes: 3000,
    maximumLines: 160,
  },
  economics: {
    enabled: true,
    usagePath: join(home, ".token-skein", "usage.jsonl"),
  },
  limits: {
    maxRequestBytes: 8_388_608,
    upstreamTimeoutMs: 120_000,
  },
  archive: {
    maxBytes: 200 * 1024 * 1024,
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ConfigMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

const CONFIG_MIGRATIONS: Record<number, ConfigMigration> = {
  1: (raw) => ({
    ...raw,
    schemaVersion: 2,
    archive: isObject(raw.archive) ? raw.archive : { maxBytes: DEFAULT_CONFIG.archive.maxBytes },
  }),
};

export function migrateConfigSchema(raw: unknown): JsonObject {
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    throw new Error("Invalid token-skein config file: expected a JSON object.");
  }

  let value: Record<string, unknown> = raw;
  let version = typeof value.schemaVersion === "number" ? value.schemaVersion : 1;
  while (version < CURRENT_CONFIG_SCHEMA_VERSION) {
    const migrate = CONFIG_MIGRATIONS[version];
    if (!migrate) {
      throw new Error(`No migration path from token-skein config schema_version ${version}.`);
    }
    value = migrate(value);
    version = typeof value.schemaVersion === "number" ? value.schemaVersion : version + 1;
  }
  if (version > CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported token-skein config schema_version ${version}; this build supports up to ${CURRENT_CONFIG_SCHEMA_VERSION}.`,
    );
  }
  return value as JsonObject;
}

function merge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) {
    return (override === undefined ? base : override) as T;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = result[key];
    result[key] = isObject(previous) && isObject(value) ? merge(previous, value) : value;
  }
  return result as T;
}

function numericEnvOverride(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`token-skein: ignoring invalid ${name}=${raw} (not a finite number)`);
    return undefined;
  }
  return value;
}

function environmentOverride(): JsonObject {
  const override: JsonObject = {};
  if (process.env.TOKEN_SKEIN_HOST) override.host = process.env.TOKEN_SKEIN_HOST;
  const port = numericEnvOverride("TOKEN_SKEIN_PORT");
  if (port !== undefined) override.port = port;
  if (process.env.TOKEN_SKEIN_UPSTREAM) override.upstream = process.env.TOKEN_SKEIN_UPSTREAM;
  if (process.env.TOKEN_SKEIN_STORE_DIR) {
    override.storeDirectory = resolve(process.env.TOKEN_SKEIN_STORE_DIR);
  }
  if (process.env.TOKEN_SKEIN_EVENTS_PATH) {
    override.eventsPath = resolve(process.env.TOKEN_SKEIN_EVENTS_PATH);
  }
  if (process.env.TOKEN_SKEIN_USAGE_PATH) {
    override.economics = { usagePath: resolve(process.env.TOKEN_SKEIN_USAGE_PATH) };
  }
  const limits: JsonObject = {};
  if (process.env.TOKEN_SKEIN_MAX_REQUEST_BYTES) {
    limits.maxRequestBytes = Number(process.env.TOKEN_SKEIN_MAX_REQUEST_BYTES);
  }
  if (process.env.TOKEN_SKEIN_UPSTREAM_TIMEOUT_MS) {
    limits.upstreamTimeoutMs = Number(process.env.TOKEN_SKEIN_UPSTREAM_TIMEOUT_MS);
  }
  if (Object.keys(limits).length > 0) override.limits = limits;
  return override;
}

export function configPath(): string {
  return resolve(
    process.env.TOKEN_SKEIN_CONFIG ?? join(home, ".config", "token-skein", "config.json"),
  );
}

export async function loadConfig(overrides?: Partial<TokenSkeinConfig>): Promise<TokenSkeinConfig> {
  let fileConfig: unknown;
  try {
    fileConfig = JSON.parse(await readFile(configPath(), "utf8"));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }

  return merge(
    merge(merge(DEFAULT_CONFIG, migrateConfigSchema(fileConfig)), environmentOverride()),
    overrides ?? {},
  );
}
