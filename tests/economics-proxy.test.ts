import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { baselineId, configHash } from "../src/economics.ts";
import { startProxy } from "../src/proxy.ts";
import type { TokenSkeinConfig, UsageRecord } from "../src/types.ts";
import { testConfig } from "./helpers.ts";

const usagePayload = {
  input_tokens: 900,
  input_tokens_details: { cached_tokens: 300, image_tokens: 40 },
  output_tokens: 250,
  output_tokens_details: { reasoning_tokens: 90 },
  total_tokens: 1150,
};

function completedBody(): string {
  return JSON.stringify({ type: "response.completed", response: { usage: usagePayload } });
}

function streamingBody(): string {
  return [
    "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    "event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n",
    `event: response.completed\ndata: {"type":"response.completed","response":{"usage":${JSON.stringify(usagePayload)}}}\n\n`,
  ].join("");
}

async function readUsage(path: string, minCount = 1, timeoutMs = 2000): Promise<UsageRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch {
      raw = "";
    }
    const records = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UsageRecord);
    if (records.length >= minCount || Date.now() > deadline) return records;
    await Bun.sleep(20);
  }
}

async function proxyWith(
  responder: (request: Request) => Response,
  mutate?: (config: TokenSkeinConfig) => void,
): Promise<{ config: TokenSkeinConfig; proxy: Awaited<ReturnType<typeof startProxy>>; upstream: ReturnType<typeof Bun.serve> }> {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: responder });
  const config = await testConfig();
  config.port = 0;
  config.upstream = `http://127.0.0.1:${upstream.port}`;
  mutate?.(config);
  const proxy = await startProxy(config);
  return { config, proxy, upstream };
}

describe("economics proxy capture", () => {
  test("captures usage from a completed Responses body", async () => {
    const { config, proxy, upstream } = await proxyWith(
      () => new Response(completedBody(), { headers: { "content-type": "application/json" } }),
    );
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-token-skein-fixture": "fx-completed" },
        body: JSON.stringify({ model: "gpt-4o", input: [] }),
      });
      expect(response.headers.get("x-token-skein-baseline-id")).toBe(
        baselineId("fx-completed", "gpt-4o", configHash(config)),
      );
      await response.json();

      const records = await readUsage(config.economics.usagePath);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.mode).toBe("optimized");
      expect(record.reported).toBeTrue();
      expect(record.usage.inputTokens).toBe(900);
      expect(record.usage.cachedInputTokens).toBe(300);
      expect(record.usage.reasoningTokens).toBe(90);
      expect(record.cost.priced).toBeTrue();
      expect(record.baselineId).toBe(baselineId("fx-completed", "gpt-4o", configHash(config)));
      expect(record.firstByteMs).toBeGreaterThanOrEqual(0);
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });

  test("captures usage from a streaming SSE terminal event", async () => {
    const { config, proxy, upstream } = await proxyWith(
      () => new Response(streamingBody(), { headers: { "content-type": "text/event-stream" } }),
    );
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-token-skein-fixture": "fx-stream" },
        body: JSON.stringify({ model: "gpt-4o", input: [] }),
      });
      expect(await response.text()).toContain("response.completed");

      const records = await readUsage(config.economics.usagePath);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.streaming).toBeTrue();
      expect(record.reported).toBeTrue();
      expect(record.usage.outputTokens).toBe(250);
      expect(record.usage.cachedInputTokens).toBe(300);
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });

  test("correlates baseline and optimized runs by the same baseline id", async () => {
    const { config, proxy, upstream } = await proxyWith(
      () => new Response(completedBody(), { headers: { "content-type": "application/json" } }),
    );
    try {
      const send = (bypass: boolean) =>
        fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-token-skein-fixture": "fx-pair",
            ...(bypass ? { "x-token-skein-bypass": "1" } : {}),
          },
          body: JSON.stringify({ model: "gpt-4o", input: [] }),
        }).then((response) => response.json());

      await send(true);
      await send(false);

      const records = await readUsage(config.economics.usagePath, 2);
      expect(records).toHaveLength(2);
      const ids = new Set(records.map((row) => row.baselineId));
      const modes = new Set(records.map((row) => row.mode));
      expect(ids.size).toBe(1);
      expect(modes).toEqual(new Set(["baseline", "optimized"]));
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });

  test("rejects a request that exceeds the size limit", async () => {
    const { config, proxy, upstream } = await proxyWith(
      () => new Response(completedBody(), { headers: { "content-type": "application/json" } }),
      (cfg) => {
        cfg.limits.maxRequestBytes = 50;
      },
    );
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: [{ type: "message", role: "user", content: "x".repeat(200) }] }),
      });
      expect(response.status).toBe(413);
      const records = await readUsage(config.economics.usagePath, 1, 300);
      expect(records).toHaveLength(0);
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });
});
