import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { MetricsRecorder, UsageRecorder } from "../src/metrics.ts";

async function tmpFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "token-skein-metrics-"));
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

function usageLine(overrides: {
  mode: string;
  baselineId: string;
  fixture: string | null;
  input: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  priced?: boolean;
  totalCost?: number;
  model?: string;
}): string {
  return JSON.stringify({
    timestamp: "2026-07-01T10:00:00.000Z",
    model: overrides.model ?? "gpt-4o",
    mode: overrides.mode,
    streaming: false,
    reported: true,
    fixture: overrides.fixture,
    configHash: "cfg",
    baselineId: overrides.baselineId,
    firstByteMs: 1,
    usage: {
      inputTokens: overrides.input,
      cachedInputTokens: overrides.cached ?? 0,
      imageInputTokens: 0,
      outputTokens: overrides.output ?? 0,
      reasoningTokens: overrides.reasoning ?? 0,
      totalTokens: overrides.input + (overrides.output ?? 0),
    },
    cost: {
      priced: overrides.priced ?? false,
      currency: "usd",
      pricingSource: overrides.priced ? "2026-01-15" : null,
      uncachedInputCost: 0,
      cachedInputCost: 0,
      outputCost: 0,
      totalCost: overrides.totalCost ?? 0,
      unknownReason: overrides.priced ? null : "unpriced",
    },
  });
}

describe("MetricsRecorder.summary validation", () => {
  test("skips malformed and non-numeric lines instead of producing NaN", async () => {
    const good = JSON.stringify({
      timestamp: "t",
      kind: "tool-schema",
      source: "proxy",
      originalBytes: 100,
      optimizedBytes: 40,
      estimatedTokensBefore: 300,
      estimatedTokensAfter: 120,
    });
    const torn = JSON.stringify({
      timestamp: "t",
      kind: "tool-schema",
      source: "proxy",
      estimatedTokensBefore: "lots",
      estimatedTokensAfter: 120,
    });
    const path = await tmpFile("events.jsonl", [good, torn, "not json at all {{{", ""].join("\n"));

    const summary = await new MetricsRecorder(path).summary();

    expect(summary.skippedLines).toBe(2);
    expect(summary.events).toBe(1);
    expect(Number.isFinite(summary.estimatedTokensBefore)).toBeTrue();
    expect(summary.estimatedTokensBefore).toBe(300);
    expect(summary.estimatedTokensSaved).toBe(180);
  });
});

describe("MetricsRecorder.summary token split", () => {
  test("keeps saved and added tokens separate instead of netting them", async () => {
    const saving = JSON.stringify({
      timestamp: "t",
      kind: "tool-schema",
      source: "proxy",
      originalBytes: 1000,
      optimizedBytes: 400,
      estimatedTokensBefore: 300,
      estimatedTokensAfter: 120,
    });
    const adding = JSON.stringify({
      timestamp: "t",
      kind: "style",
      source: "proxy",
      originalBytes: 200,
      optimizedBytes: 520,
      estimatedTokensBefore: 100,
      estimatedTokensAfter: 260,
    });
    const path = await tmpFile("events.jsonl", [saving, adding].join("\n"));

    const summary = await new MetricsRecorder(path).summary();

    expect(summary.estimatedTokensSaved).toBe(180);
    expect(summary.estimatedTokensAdded).toBe(160);
    expect(summary.byKind["tool-schema"]?.estimatedTokensSaved).toBe(180);
    expect(summary.byKind["tool-schema"]?.estimatedTokensAdded).toBe(0);
    expect(summary.byKind.style?.estimatedTokensAdded).toBe(160);
    expect(summary.byKind.style?.estimatedTokensSaved).toBe(0);
  });
});

describe("UsageRecorder.summary validation", () => {
  test("skips records missing usage or with an unknown mode without crashing", async () => {
    const valid = usageLine({ mode: "optimized", baselineId: "b1", fixture: "fx", input: 900, cached: 300, output: 250, reasoning: 90 });
    const path = await tmpFile(
      "usage.jsonl",
      [valid, JSON.stringify({ mode: "optimized" }), JSON.stringify({ mode: "weird", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 } }), "}{"].join("\n"),
    );

    const summary = await new UsageRecorder(path).summary();

    expect(summary.records).toBe(1);
    expect(summary.skippedLines).toBe(3);
    expect(Number.isFinite(summary.byMode.optimized.inputTokens)).toBeTrue();
    expect(summary.byMode.optimized.inputTokens).toBe(900);
    expect(summary.byMode.optimized.cachedInputTokens).toBe(300);
    expect(Number.isFinite(summary.byMode.optimized.billableTokens)).toBeTrue();
  });
});

describe("UsageRecorder.summary pairing", () => {
  test("normalizes savings per request and flags non-comparable groups", async () => {
    const path = await tmpFile(
      "usage.jsonl",
      [
        usageLine({ mode: "baseline", baselineId: "pair1", fixture: "fx", input: 1000 }),
        usageLine({ mode: "optimized", baselineId: "pair1", fixture: "fx", input: 100 }),
        usageLine({ mode: "optimized", baselineId: "pair1", fixture: "fx", input: 100 }),
        usageLine({ mode: "optimized", baselineId: "pair1", fixture: "fx", input: 100 }),
        usageLine({ mode: "optimized", baselineId: "pair2", fixture: null, input: 200 }),
      ].join("\n"),
    );

    const summary = await new UsageRecorder(path).summary();

    const withFixture = summary.pairs.find((pair) => pair.baselineId === "pair1")!;
    expect(withFixture.baselineRecords).toBe(1);
    expect(withFixture.optimizedRecords).toBe(3);
    expect(withFixture.comparable).toBeTrue();
    expect(withFixture.billableTokensSavedPerRequest).toBe(900);

    const nullFixture = summary.pairs.find((pair) => pair.baselineId === "pair2")!;
    expect(nullFixture.comparable).toBeFalse();
    expect(nullFixture.baselineRecords).toBe(0);
    expect(nullFixture.optimizedRecords).toBe(1);
    expect(nullFixture.billableTokensSavedPerRequest).toBeNull();
  });
});
