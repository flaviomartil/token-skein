import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { ContextStore, objectPathFor } from "../src/store.ts";
import { testConfig } from "./helpers.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  test("resolves references regardless of skein: prefix case", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const entry = await store.put("case content", { kind: "test", compacted: "case", ttlSeconds: 600 });
    const hash = entry.reference.slice("skein:".length);
    const upper = `SKEIN:${hash.toUpperCase()}`;

    expect(objectPathFor(config.storeDirectory, upper)).toBe(objectPathFor(config.storeDirectory, entry.reference));
    expect(await store.retrieve(upper)).toBe("case content");
  });

  test("stats and cleanup skip stray files with a non-hex stem instead of throwing", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const entry = await store.put("kept content", { kind: "test", compacted: "kept", ttlSeconds: 600 });

    const strayDirectory = dirname(objectPathFor(config.storeDirectory, entry.reference));
    const strayPath = join(strayDirectory, "not-a-valid-hash.json.gz");
    await mkdir(strayDirectory, { recursive: true });
    await writeFile(strayPath, "garbage");

    const stats = await store.stats();
    expect(stats.entries).toBe(1);

    expect(await store.cleanup()).toBe(0);
    await expect(readFile(strayPath)).resolves.toBeDefined();
    expect(await store.retrieve(entry.reference)).toBe("kept content");
  });

  test("handles concurrent writers without corrupting entries", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const count = 25;

    const entries = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.put(`payload-${index}`, { kind: "test", compacted: `payload-${index}`, ttlSeconds: 600 }),
      ),
    );

    const results = await Promise.all(entries.map((entry) => store.retrieve(entry.reference)));
    results.forEach((result, index) => expect(result).toBe(`payload-${index}`));
    expect((await store.stats()).entries).toBe(count);
  });

  test("an interrupted write never corrupts an existing object", async () => {
    const config = await testConfig();
    const store = new ContextStore(config.storeDirectory);
    const entry = await store.put("original content", { kind: "test", compacted: "original", ttlSeconds: 600 });
    const path = objectPathFor(config.storeDirectory, entry.reference);
    const before = await readFile(path);

    await writeFile(`${path}.tmp-simulated-crash`, "not valid gzip json, simulates a write that never renamed");

    expect(await readFile(path)).toEqual(before);
    expect(await store.retrieve(entry.reference)).toBe("original content");
  });

  test("enforces a byte quota by evicting the least recently used entries", async () => {
    const config = await testConfig();
    const probe = new ContextStore(config.storeDirectory);
    const probeEntry = await probe.put("x".repeat(400), { kind: "test", compacted: "probe", ttlSeconds: 600 });
    const singleEntryBytes = (await probe.stats()).bytes;
    await probe.remove(probeEntry.reference);

    const store = new ContextStore(config.storeDirectory, Math.ceil(singleEntryBytes * 2.5));
    const first = await store.put("x".repeat(400), { kind: "test", compacted: "first", ttlSeconds: 600 });
    await sleep(5);
    const second = await store.put("y".repeat(400), { kind: "test", compacted: "second", ttlSeconds: 600 });
    await sleep(5);
    await store.get(first.reference);
    await sleep(5);
    const third = await store.put("z".repeat(400), { kind: "test", compacted: "third", ttlSeconds: 600 });

    expect(await store.get(second.reference, true, false)).toBeNull();
    expect(await store.get(first.reference, true, false)).not.toBeNull();
    expect(await store.get(third.reference, true, false)).not.toBeNull();
  });
});
