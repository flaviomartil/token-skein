import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { TokenSkeinConfig, JsonObject } from "./types.ts";

const home = homedir();

export const DEFAULT_CONFIG: TokenSkeinConfig = {
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
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function environmentOverride(): JsonObject {
  const override: JsonObject = {};
  if (process.env.TOKEN_SKEIN_HOST) override.host = process.env.TOKEN_SKEIN_HOST;
  if (process.env.TOKEN_SKEIN_PORT) override.port = Number(process.env.TOKEN_SKEIN_PORT);
  if (process.env.TOKEN_SKEIN_UPSTREAM) override.upstream = process.env.TOKEN_SKEIN_UPSTREAM;
  if (process.env.TOKEN_SKEIN_STORE_DIR) {
    override.storeDirectory = resolve(process.env.TOKEN_SKEIN_STORE_DIR);
  }
  if (process.env.TOKEN_SKEIN_EVENTS_PATH) {
    override.eventsPath = resolve(process.env.TOKEN_SKEIN_EVENTS_PATH);
  }
  return override;
}

export function configPath(): string {
  return resolve(
    process.env.TOKEN_SKEIN_CONFIG ?? join(home, ".config", "token-skein", "config.json"),
  );
}

export async function loadConfig(overrides?: Partial<TokenSkeinConfig>): Promise<TokenSkeinConfig> {
  let fileConfig: unknown = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath(), "utf8"));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }

  return merge(
    merge(merge(DEFAULT_CONFIG, fileConfig), environmentOverride()),
    overrides ?? {},
  );
}
