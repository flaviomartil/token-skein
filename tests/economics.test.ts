import { describe, expect, test } from "bun:test";

import {
  SseUsageExtractor,
  baselineId,
  configHash,
  parseCompletedUsage,
} from "../src/economics.ts";
import { testConfig } from "./helpers.ts";

const completedResponse = {
  type: "response.completed",
  response: {
    usage: {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 400, image_tokens: 90 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 1500,
    },
  },
};

function streamingEvents(): string {
  return [
    "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
    `event: response.completed\ndata: ${JSON.stringify(completedResponse)}\n\n`,
  ].join("");
}

describe("provider usage parsing", () => {
  test("parses a completed Responses usage object", () => {
    const usage = parseCompletedUsage(completedResponse);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(1200);
    expect(usage?.cachedInputTokens).toBe(400);
    expect(usage?.imageInputTokens).toBe(90);
    expect(usage?.outputTokens).toBe(300);
    expect(usage?.reasoningTokens).toBe(120);
    expect(usage?.totalTokens).toBe(1500);
  });

  test("returns null when no usage is present", () => {
    expect(parseCompletedUsage({ type: "response.created" })).toBeNull();
    expect(parseCompletedUsage("not-an-object")).toBeNull();
  });

  test("extracts usage from the SSE terminal event only", () => {
    const extractor = new SseUsageExtractor();
    const full = streamingEvents();
    const midpoint = Math.floor(full.length / 2);
    extractor.push(full.slice(0, midpoint));
    extractor.push(full.slice(midpoint));
    const usage = extractor.usage;
    expect(usage?.inputTokens).toBe(1200);
    expect(usage?.cachedInputTokens).toBe(400);
    expect(usage?.reasoningTokens).toBe(120);
  });

  test("ignores non-terminal events until usage arrives", () => {
    const extractor = new SseUsageExtractor();
    extractor.push("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
    expect(extractor.usage).toBeNull();
    extractor.push("event: response.output_text.delta\ndata: {\"delta\":\"x\"}\n\n");
    expect(extractor.usage).toBeNull();
  });
});

describe("baseline correlation", () => {
  test("baselineId is deterministic for the same tuple", () => {
    const first = baselineId("fixture-a", "gpt-4o", "cfg123");
    const second = baselineId("fixture-a", "gpt-4o", "cfg123");
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
  });

  test("baselineId changes with fixture, model, or config", () => {
    const base = baselineId("fixture-a", "gpt-4o", "cfg123");
    expect(baselineId("fixture-b", "gpt-4o", "cfg123")).not.toBe(base);
    expect(baselineId("fixture-a", "gpt-4o-mini", "cfg123")).not.toBe(base);
    expect(baselineId("fixture-a", "gpt-4o", "cfg999")).not.toBe(base);
  });

  test("null fixture is handled", () => {
    expect(baselineId(null, "gpt-4o", "cfg123")).toMatch(/^[a-f0-9]{16}$/);
  });

  test("configHash is stable and reflects config changes", async () => {
    const config = await testConfig();
    const hash = configHash(config);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    expect(configHash(structuredClone(config))).toBe(hash);
    const changed = structuredClone(config);
    changed.style.enabled = !changed.style.enabled;
    expect(configHash(changed)).not.toBe(hash);
  });
});
