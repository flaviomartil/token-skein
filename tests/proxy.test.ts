import { describe, expect, test } from "bun:test";

import { startProxy } from "../src/proxy.ts";
import type { JsonObject } from "../src/types.ts";
import { testConfig } from "./helpers.ts";

describe("Responses proxy", () => {
  test("optimizes and forwards a request while preserving the upstream response", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        return new Response(await request.text(), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const config = await testConfig();
    config.port = 0;
    config.upstream = `http://127.0.0.1:${upstream.port}`;
    const proxy = await startProxy(config);
    const output = JSON.stringify(
      Array.from({ length: 180 }, (_, index) => ({ index, message: "dense-value".repeat(12) })),
    );
    const body: JsonObject = {
      model: "gpt-5.6-test",
      tools: [
        {
          type: "function",
          name: "logs",
          description: "Read   logs",
          parameters: { type: "object", title: "Input", properties: {} },
        },
      ],
      input: [
        { type: "function_call_output", call_id: "call_1", output },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Investigate root cause" }] },
      ],
    };

    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const forwarded = (await response.json()) as JsonObject;

      expect(response.status).toBe(200);
      expect(Number(response.headers.get("x-token-skein-estimated-tokens-saved"))).toBeGreaterThan(0);
      expect(forwarded.instructions).toContain("TokenSkein output policy");
      expect(JSON.stringify(forwarded.input)).toContain("reference=skein:");
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });
});
