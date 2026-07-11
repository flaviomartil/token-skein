import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { aggregate, parseEventLine } from "../src/dashboard/aggregate.ts";
import { buildSummary } from "../src/dashboard.ts";

const fixtureLines = [
  JSON.stringify({
    timestamp: "2026-07-01T10:00:00.000Z",
    kind: "tool-schema",
    source: "proxy",
    originalBytes: 1000,
    optimizedBytes: 400,
    estimatedTokensBefore: 300,
    estimatedTokensAfter: 120,
    model: "gpt-5.6",
    metadata: { costUsd: 0.002, latencyMs: 120, cacheHit: true },
  }),
  JSON.stringify({
    timestamp: "2026-07-01T10:30:00.000Z",
    kind: "recoverable-text",
    source: "mcp",
    originalBytes: 5000,
    optimizedBytes: 800,
    estimatedTokensBefore: 1500,
    estimatedTokensAfter: 240,
    reference: "skein:abc123",
    metadata: { strategy: "summary", latencyMs: 200, cache: "miss" },
  }),
  "not json at all {{{",
  JSON.stringify({
    timestamp: "2026-07-01T11:00:00.000Z",
    kind: "some-future-kind-nobody-recognizes",
    source: "proxy",
    originalBytes: 10,
    optimizedBytes: 5,
    estimatedTokensBefore: 3,
    estimatedTokensAfter: 1,
  }),
  JSON.stringify({
    timestamp: "2026-07-01T11:15:00.000Z",
    kind: "effort-routing",
    source: "proxy",
    originalBytes: 0,
    optimizedBytes: 0,
    estimatedTokensBefore: 0,
    estimatedTokensAfter: 0,
    model: "gpt-5.6",
  }),
  "",
];

describe("dashboard aggregate", () => {
  test("parseEventLine rejects malformed and structurally-invalid lines", () => {
    expect(parseEventLine("not json")).toBeNull();
    expect(parseEventLine(JSON.stringify({ kind: "tool-schema" }))).toBeNull();
    expect(parseEventLine(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  test("parseEventLine accepts a well-formed event", () => {
    const parsed = parseEventLine(fixtureLines[0] as string);
    expect(parsed?.kind).toBe("tool-schema");
    expect(parsed?.model).toBe("gpt-5.6");
  });

  test("aggregate skips corrupted lines and unknown-kind events without crashing", () => {
    const summary = aggregate(fixtureLines);
    expect(summary.skippedLines).toBe(2);
    expect(summary.totalEvents).toBe(3);
  });

  test("aggregate sums token savings by kind and by model", () => {
    const summary = aggregate(fixtureLines);
    expect(summary.tokens.total.tokensBefore).toBe(1800);
    expect(summary.tokens.total.tokensAfter).toBe(360);
    expect(summary.tokens.total.tokensSaved).toBe(1440);
    expect(summary.tokens.byKind["tool-schema"]?.tokensSaved).toBe(180);
    expect(summary.tokens.byModel["gpt-5.6"]?.events).toBe(2);
    expect(summary.tokens.byModel.unknown?.events).toBe(1);
  });

  test("aggregate propagates unknown cost when no metadata carries it", () => {
    const withoutCost = aggregate([
      JSON.stringify({
        timestamp: "2026-07-01T10:00:00.000Z",
        kind: "shell",
        source: "shell",
        originalBytes: 10,
        optimizedBytes: 5,
        estimatedTokensBefore: 5,
        estimatedTokensAfter: 2,
      }),
    ]);
    expect(withoutCost.cost.totalUsd).toBe("unknown");
    expect(withoutCost.cost.unknownEvents).toBe(1);
  });

  test("aggregate computes known cost and latency from metadata", () => {
    const summary = aggregate(fixtureLines);
    expect(summary.cost.totalUsd).toBe(0.002);
    expect(summary.cost.knownEvents).toBe(1);
    expect(summary.latency).not.toBe("unknown");
    if (summary.latency !== "unknown") {
      expect(summary.latency.samples).toBe(2);
      expect(summary.latency.averageMs).toBe(160);
    }
  });

  test("aggregate tracks cache hit/miss/unknown from metadata", () => {
    const summary = aggregate(fixtureLines);
    expect(summary.cache.hits).toBe(1);
    expect(summary.cache.misses).toBe(1);
    expect(summary.cache.unknownStatus).toBe(1);
  });

  test("aggregate builds an hourly time series and a window", () => {
    const summary = aggregate(fixtureLines);
    expect(summary.windowStart).toBe("2026-07-01T10:00:00.000Z");
    expect(summary.windowEnd).toBe("2026-07-01T11:15:00.000Z");
    expect(summary.series.length).toBe(2);
  });

  test("aggregate returns a clean empty summary for no events", () => {
    const summary = aggregate([]);
    expect(summary.totalEvents).toBe(0);
    expect(summary.skippedLines).toBe(0);
    expect(summary.windowStart).toBeNull();
    expect(summary.cost.totalUsd).toBe("unknown");
    expect(summary.latency).toBe("unknown");
    expect(summary.series).toEqual([]);
  });
});

describe("dashboard buildSummary reads usage.jsonl", () => {
  function usageRecord(firstByteMs: number, totalCost: number): string {
    return JSON.stringify({
      timestamp: "2026-07-01T10:00:00.000Z",
      model: "gpt-5.6",
      mode: "optimized",
      streaming: false,
      reported: true,
      fixture: null,
      configHash: "cfg",
      baselineId: "b1",
      firstByteMs,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        imageInputTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
        totalTokens: 150,
      },
      cost: {
        priced: true,
        currency: "usd",
        pricingSource: "2026-01-15",
        uncachedInputCost: 0,
        cachedInputCost: 0,
        outputCost: 0,
        totalCost,
        unknownReason: null,
      },
    });
  }

  test("populates real cost and latency and splits saved vs added tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "token-skein-dashboard-"));
    const eventsPath = join(dir, "events.jsonl");
    const usagePath = join(dir, "usage.jsonl");

    await writeFile(
      usagePath,
      [usageRecord(100, 0.01), usageRecord(300, 0.03), "totally not json }{"].join("\n"),
      "utf8",
    );

    const savingEvent = JSON.stringify({
      timestamp: "2026-07-01T10:00:00.000Z",
      kind: "tool-schema",
      source: "proxy",
      originalBytes: 1000,
      optimizedBytes: 400,
      estimatedTokensBefore: 300,
      estimatedTokensAfter: 120,
    });
    const addingEvent = JSON.stringify({
      timestamp: "2026-07-01T10:05:00.000Z",
      kind: "style",
      source: "proxy",
      originalBytes: 200,
      optimizedBytes: 520,
      estimatedTokensBefore: 100,
      estimatedTokensAfter: 260,
    });
    await writeFile(eventsPath, [savingEvent, addingEvent, "broken line {{{"].join("\n"), "utf8");

    const summary = await buildSummary(eventsPath, usagePath);

    expect(summary.cost.totalUsd).toBe(0.04);
    expect(summary.cost.pricedRecords).toBe(2);
    expect(summary.latency).not.toBe("unknown");
    if (summary.latency !== "unknown") {
      expect(summary.latency.samples).toBe(2);
      expect(summary.latency.averageMs).toBe(200);
      expect(summary.latency.p50Ms).toBe(100);
      expect(summary.latency.p95Ms).toBe(300);
    }
    expect(summary.tokens.total.tokensSaved).toBe(180);
    expect(summary.tokens.total.tokensAdded).toBe(160);
    expect(summary.usageSkippedLines).toBe(1);
  });
});
