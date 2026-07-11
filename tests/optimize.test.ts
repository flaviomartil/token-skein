import { describe, expect, test } from "bun:test";

import { optimizeResponsesRequest } from "../src/optimize.ts";
import { ContextStore } from "../src/store.ts";
import type { JsonObject } from "../src/types.ts";
import { testConfig } from "./helpers.ts";

function requestBody(output: string): JsonObject {
  return {
    model: "gpt-5.6-test",
    instructions: "Follow repository rules.",
    tools: [
      {
        type: "function",
        name: "read_logs",
        description: "Read   logs with a verbose description.",
        parameters: {
          type: "object",
          title: "Read logs",
          properties: { path: { type: "string", examples: ["/tmp/a.log"] } },
          required: ["path"],
        },
      },
    ],
    input: [
      { type: "function_call_output", call_id: "call_1", output },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the root cause across the production system." }] },
    ],
  };
}

describe("Responses request optimization", () => {
  test("combines schema, style, routing, and recoverable compression", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const output = JSON.stringify(
      Array.from({ length: 240 }, (_, index) => ({ index, status: index === 80 ? "failed" : "ok", payload: "x".repeat(80) })),
    );
    const result = await optimizeResponsesRequest(requestBody(output), config, store);
    const first = Array.isArray(result.body.input) ? result.body.input[0] : null;

    expect(result.transformed).toBeTrue();
    expect(result.events.map((row) => row.kind)).toContainAllValues([
      "tool-schema",
      "style",
      "effort-routing",
      "recoverable-text",
    ]);
    expect(result.body.instructions).toContain("TokenSkein output policy");
    expect(result.body.reasoning).toEqual({ effort: "high" });
    expect(first && typeof first === "object" && !Array.isArray(first) ? first.output : "").toContain("reference=skein:");
  });

  test("adds visual archive pages only when explicitly enabled and profitable", async () => {
    const config = await testConfig();
    config.vision.enabled = true;
    config.vision.minimumBytes = 100;
    config.vision.maximumPages = 1;
    config.vision.estimatedTokensPerPage = 50;
    config.vision.minimumSavingsRatio = 1;
    config.vision.models = ["gpt-5.6"];
    const store = new ContextStore(config.storeDirectory);
    const output = Array.from({ length: 300 }, (_, index) => `${index} ${"token-dense-value ".repeat(10)}`).join("\n");
    const result = await optimizeResponsesRequest(requestBody(output), config, store);

    expect(result.events.some((row) => row.kind === "vision")).toBeTrue();
    expect(Array.isArray(result.body.input) ? result.body.input.length : 0).toBe(3);
    expect(JSON.stringify(result.body.input)).toContain("input_image");
  });

  test("removes the archived blob when compaction is rejected", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const output = "a".repeat(4000);
    const result = await optimizeResponsesRequest(requestBody(output), config, store);
    const kinds = result.events.map((row) => row.kind);

    expect(kinds).not.toContain("recoverable-text");
    expect(kinds).not.toContain("vision");
    expect((await store.stats()).entries).toBe(0);
  });
});
