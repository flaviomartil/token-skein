import { describe, expect, test } from "bun:test";

import { renderTextPages, visionIsProfitable } from "../src/compact/image.ts";
import { compactRecoverably } from "../src/compact/text.ts";
import { compactToolSchemas } from "../src/compact/tools.ts";
import { ContextStore } from "../src/store.ts";
import { countTextTokens } from "../src/tokenizer.ts";
import { testConfig } from "./helpers.ts";

describe("context compaction", () => {
  test("compacts verbose tool schemas without changing required fields", () => {
    const source = [
      {
        type: "function",
        name: "search",
        description: "Search   many\nrecords",
        parameters: {
          type: "object",
          title: "Search input",
          examples: [{ query: "x" }],
          properties: { query: { type: "string", title: "Query" } },
          required: ["query"],
        },
      },
    ];
    const result = compactToolSchemas(source);
    const serialized = JSON.stringify(result.tools);

    expect(result.compactedBytes).toBeLessThan(result.originalBytes);
    expect(serialized).not.toContain("Search input");
    expect(serialized).not.toContain("examples");
    expect(serialized).toContain('"required":["query"]');
    expect(serialized).toContain("Search many records");
  });

  test("creates a recoverable compact representation", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const rows = Array.from({ length: 300 }, (_, index) => ({
      id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`,
      status: index === 211 ? "ERR_TIMEOUT" : "ok",
      payload: "x".repeat(80),
    }));
    const original = JSON.stringify(rows);
    const result = await compactRecoverably(original, store, {
      kind: "test_json",
      maximumLines: 30,
      ttlSeconds: 60,
    });

    expect(result.reference).toMatch(/^skein:/);
    expect(countTextTokens(result.text)).toBeLessThan(countTextTokens(original));
    expect(await store.retrieve(result.reference!)).toBe(original);
    expect(result.text).toContain("JSON structural summary");
  });

  test("renders dense text into PNG data URLs behind a profitability gate", async () => {
    const config = await testConfig();
    config.vision.estimatedTokensPerPage = 100;
    config.vision.minimumSavingsRatio = 1.1;
    const text = Array.from({ length: 120 }, (_, index) => `${index}: ${"dense-json-value ".repeat(12)}`).join("\n");
    const pages = renderTextPages(text, 2);

    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]?.dataUrl).toStartWith("data:image/png;base64,");
    expect(visionIsProfitable(text, pages.length, config.vision)).toBeTrue();
  });
});
