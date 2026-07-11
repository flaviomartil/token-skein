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

  test("does not abort a slow streaming body after upstream headers arrive", async () => {
    const encoder = new TextEncoder();
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"));
            await Bun.sleep(90);
            controller.enqueue(encoder.encode("event: response.output_text.delta\ndata: {\"delta\":\"x\"}\n\n"));
            await Bun.sleep(90);
            controller.enqueue(
              encoder.encode(
                'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":6}}}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const config = await testConfig();
    config.port = 0;
    config.upstream = `http://127.0.0.1:${upstream.port}`;
    config.limits.upstreamTimeoutMs = 120;
    const proxy = await startProxy(config);

    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: [] }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.completed");
      expect(text).toContain('"input_tokens":5');
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });
});
