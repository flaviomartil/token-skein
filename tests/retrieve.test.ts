import { afterEach, describe, expect, test } from "bun:test";

import { createStore, startProxy } from "../src/proxy.ts";
import { testConfig } from "./helpers.ts";

const AUTH_ENV = "TOKEN_SKEIN_AUTH_TOKEN";
const TOKEN = "s3cret-token-value";
const ABSENT_REFERENCE = `skein:${"a".repeat(24)}`;

afterEach(() => {
  delete process.env[AUTH_ENV];
});

async function withProxy(
  mutate: (config: Awaited<ReturnType<typeof testConfig>>) => void,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const config = await testConfig();
  config.port = 0;
  mutate(config);
  const proxy = await startProxy(config);
  try {
    await run(`http://127.0.0.1:${proxy.port}`);
  } finally {
    proxy.stop(true);
  }
}

function retrieve(base: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/token-skein/retrieve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("retrieve auth", () => {
  test("serves retrieve without auth when the token env is unset", async () => {
    await withProxy(
      () => {},
      async (base) => {
        const response = await retrieve(base, {}, { reference: ABSENT_REFERENCE });
        expect(response.status).toBe(404);
      },
    );
  });

  test("rejects retrieve with no bearer header when auth is enabled", async () => {
    process.env[AUTH_ENV] = TOKEN;
    await withProxy(
      () => {},
      async (base) => {
        const response = await retrieve(base, {}, { reference: ABSENT_REFERENCE });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Unauthorized." });
      },
    );
  });

  test("rejects retrieve with the wrong bearer token", async () => {
    process.env[AUTH_ENV] = TOKEN;
    await withProxy(
      () => {},
      async (base) => {
        const response = await retrieve(base, { authorization: "Bearer wrong-token" }, { reference: ABSENT_REFERENCE });
        expect(response.status).toBe(401);
      },
    );
  });

  test("accepts retrieve with the correct bearer token", async () => {
    process.env[AUTH_ENV] = TOKEN;
    await withProxy(
      () => {},
      async (base) => {
        const response = await retrieve(base, { authorization: `Bearer ${TOKEN}` }, { reference: ABSENT_REFERENCE });
        expect(response.status).toBe(404);
      },
    );
  });

  test("fails closed when the token env is set but empty", async () => {
    process.env[AUTH_ENV] = "";
    await withProxy(
      () => {},
      async (base) => {
        const bare = await retrieve(base, {}, { reference: ABSENT_REFERENCE });
        expect(bare.status).toBe(401);
        const withEmptyBearer = await retrieve(base, { authorization: "Bearer " }, { reference: ABSENT_REFERENCE });
        expect(withEmptyBearer.status).toBe(401);
      },
    );
  });

  test("gates the stats endpoint behind the same token", async () => {
    process.env[AUTH_ENV] = TOKEN;
    await withProxy(
      () => {},
      async (base) => {
        const denied = await fetch(`${base}/v1/token-skein/stats`);
        expect(denied.status).toBe(401);
        const allowed = await fetch(`${base}/v1/token-skein/stats`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(allowed.status).toBe(200);
      },
    );
  });
});

describe("retrieve body cap", () => {
  test("rejects an oversized retrieve body", async () => {
    await withProxy(
      (config) => {
        config.limits.maxRequestBytes = 100;
      },
      async (base) => {
        const response = await retrieve(base, {}, { reference: ABSENT_REFERENCE, query: "x".repeat(400) });
        expect(response.status).toBe(413);
      },
    );
  });
});

describe("store quota wiring", () => {
  test("createStore constructs the archive with its byte quota", async () => {
    const config = await testConfig();
    config.archive.maxBytes = 1;
    const store = createStore(config);
    await store.put("a".repeat(4000), { kind: "test", compacted: "x", ttlSeconds: 3600 });
    expect((await store.stats()).entries).toBe(0);
  });
});
