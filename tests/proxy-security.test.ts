import { describe, expect, test } from "bun:test";

import { loopbackEnforcement, startProxy } from "../src/proxy.ts";
import { testConfig } from "./helpers.ts";

describe("loopback enforcement", () => {
  test("allows loopback hosts and blocks remote binds without explicit opt-in", () => {
    for (const host of ["127.0.0.1", "127.5.9.9", "::1", "localhost"]) {
      expect(loopbackEnforcement(host, false).allowed).toBeTrue();
    }
    for (const host of ["0.0.0.0", "192.168.1.10", "::"]) {
      expect(loopbackEnforcement(host, false).allowed).toBeFalse();
    }
    expect(loopbackEnforcement("0.0.0.0", true).allowed).toBeTrue();
    const blocked = loopbackEnforcement("0.0.0.0", false);
    expect(blocked.allowed).toBeFalse();
    if (!blocked.allowed) expect(blocked.reason).toContain("TOKEN_SKEIN_ALLOW_REMOTE");
  });
});

describe("request size guard", () => {
  test("rejects an oversized chunked body with no content-length before forwarding", async () => {
    let upstreamCalls = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        upstreamCalls += 1;
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    const config = await testConfig();
    config.port = 0;
    config.upstream = `http://127.0.0.1:${upstream.port}`;
    config.limits.maxRequestBytes = 100;
    const proxy = await startProxy(config);

    try {
      const encoder = new TextEncoder();
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 40) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode("x".repeat(80)));
        },
      });
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      expect(response.status).toBe(413);
      expect(upstreamCalls).toBe(0);
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });
});
