import { describe, expect, test } from "bun:test";

import { ContextStore } from "../src/store.ts";
import { testConfig } from "./helpers.ts";

describe("ContextStore", () => {
  test("stores, retrieves, and searches exact content", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const original = ["alpha line", "database failure ERR_TIMEOUT", "omega line"].join("\n");
    const entry = await store.put(original, {
      kind: "test",
      compacted: "database failure",
      ttlSeconds: 60,
    });

    expect(entry.reference).toMatch(/^skein:[a-f0-9]{24}$/);
    expect(await store.retrieve(entry.reference)).toBe(original);
    expect(await store.retrieve(entry.reference, "ERR_TIMEOUT")).toContain("database failure");
    expect((await store.stats()).entries).toBe(1);
  });

  test("does not return expired entries", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const entry = await store.put("expired", {
      kind: "test",
      compacted: "expired",
      ttlSeconds: -1,
    });

    expect(await store.retrieve(entry.reference)).toBeNull();
    expect((await store.stats()).expired).toBe(1);
    expect(await store.cleanup()).toBe(1);
  });
});
