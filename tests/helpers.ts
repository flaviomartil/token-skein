import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config.ts";
import type { TokenSkeinConfig } from "../src/types.ts";

export async function testConfig(): Promise<TokenSkeinConfig> {
  const directory = await mkdtemp(join(tmpdir(), "token-skein-test-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.storeDirectory = join(directory, "store");
  config.eventsPath = join(directory, "events.jsonl");
  config.economics.usagePath = join(directory, "usage.jsonl");
  config.compression.minimumBytes = 100;
  config.compression.recentInputItems = 1;
  config.compression.maximumSummaryLines = 24;
  config.compression.ttlSeconds = 3600;
  config.routing.overrideExisting = true;
  config.shell.enabled = true;
  config.shell.preferRtk = false;
  return config;
}
