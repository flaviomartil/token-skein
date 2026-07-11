import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

import type { JsonValue, StoredContext } from "./types.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const HASH_PATTERN = /^[a-f0-9]{24}$/i;

function normalizedReference(reference: string): string {
  return reference.replace(/^skein:/i, "").toLowerCase();
}

export function objectPathFor(directory: string, reference: string): string {
  const hash = normalizedReference(reference);
  if (!HASH_PATTERN.test(hash)) throw new Error(`Invalid context reference: ${reference}`);
  return join(directory, "objects", hash.slice(0, 2), `${hash}.json.gz`);
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_./:@-]{2,}/gu) ?? [])];
}

export interface PutContextOptions {
  kind: string;
  compacted: string;
  ttlSeconds: number;
  metadata?: Record<string, JsonValue>;
}

export interface StoreStats {
  entries: number;
  bytes: number;
  expired: number;
}

export class ContextStore {
  constructor(
    private readonly directory: string,
    private readonly maxBytes?: number,
  ) {}

  async put(original: string, options: PutContextOptions): Promise<StoredContext> {
    const hash = createHash("sha256").update(original).digest("hex").slice(0, 24);
    const reference = `skein:${hash}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + options.ttlSeconds * 1000);
    const entry: StoredContext = {
      version: 1,
      reference,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      kind: options.kind,
      original,
      compacted: options.compacted,
      metadata: options.metadata ?? {},
    };
    const path = objectPathFor(this.directory, reference);
    const tempPath = `${path}.tmp-${randomUUID()}`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    await writeFile(tempPath, await gzipAsync(JSON.stringify(entry)), { mode: 0o600 });
    await rename(tempPath, path);
    if (this.maxBytes) await this.enforceQuota();
    return entry;
  }

  async get(reference: string, includeExpired = false, touch = true): Promise<StoredContext | null> {
    const path = objectPathFor(this.directory, reference);
    try {
      const compressed = await readFile(path);
      const entry = JSON.parse((await gunzipAsync(compressed)).toString("utf8")) as StoredContext;
      if (!includeExpired && Date.parse(entry.expiresAt) <= Date.now()) return null;
      if (touch) {
        const now = new Date();
        await utimes(path, now, now).catch(() => {});
      }
      return entry;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async retrieve(reference: string, query?: string, maxChars = 80_000): Promise<string | null> {
    const entry = await this.get(reference);
    if (!entry) return null;
    if (!query) return entry.original.slice(0, maxChars);

    const terms = tokenizeQuery(query);
    if (terms.length === 0) return entry.original.slice(0, maxChars);
    const lines = entry.original.split(/\r?\n/);
    const ranked = lines
      .map((line, index) => ({
        line,
        index,
        score: terms.reduce((score, term) => score + (line.toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const selected = new Map<number, string>();
    for (const row of ranked.slice(0, 80)) {
      for (let index = Math.max(0, row.index - 1); index <= Math.min(lines.length - 1, row.index + 1); index += 1) {
        const line = lines[index];
        if (line !== undefined) selected.set(index, line);
      }
    }
    const output = [...selected.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, line]) => `${index + 1}: ${line}`)
      .join("\n");
    return output.slice(0, maxChars);
  }

  async remove(reference: string): Promise<boolean> {
    try {
      await unlink(objectPathFor(this.directory, reference));
      return true;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return false;
      throw error;
    }
  }

  async stats(): Promise<StoreStats> {
    const root = join(this.directory, "objects");
    let entries = 0;
    let bytes = 0;
    let expired = 0;
    try {
      for (const prefix of await readdir(root)) {
        const directory = join(root, prefix);
        for (const file of await readdir(directory)) {
          if (!file.endsWith(".json.gz")) continue;
          const stem = file.slice(0, -8);
          if (!HASH_PATTERN.test(stem)) continue;
          entries += 1;
          bytes += (await stat(join(directory, file))).size;
          const entry = await this.get(`skein:${stem}`, true, false);
          if (entry && Date.parse(entry.expiresAt) <= Date.now()) expired += 1;
        }
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
    return { entries, bytes, expired };
  }

  async cleanup(): Promise<number> {
    const root = join(this.directory, "objects");
    let removed = 0;
    try {
      for (const prefix of await readdir(root)) {
        const directory = join(root, prefix);
        for (const file of await readdir(directory)) {
          if (!file.endsWith(".json.gz")) continue;
          const stem = file.slice(0, -8);
          if (!HASH_PATTERN.test(stem)) continue;
          const reference = `skein:${stem}`;
          const entry = await this.get(reference, true, false);
          if (entry && Date.parse(entry.expiresAt) <= Date.now() && (await this.remove(reference))) {
            removed += 1;
          }
        }
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
    if (this.maxBytes) removed += await this.enforceQuota();
    return removed;
  }

  private async enforceQuota(): Promise<number> {
    if (!this.maxBytes) return 0;
    const root = join(this.directory, "objects");
    const files: { reference: string; size: number; mtimeMs: number }[] = [];
    try {
      for (const prefix of await readdir(root)) {
        const directory = join(root, prefix);
        for (const file of await readdir(directory)) {
          if (!file.endsWith(".json.gz")) continue;
          const stem = file.slice(0, -8);
          if (!HASH_PATTERN.test(stem)) continue;
          const info = await stat(join(directory, file));
          files.push({ reference: `skein:${stem}`, size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
      return 0;
    }

    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.maxBytes) return 0;

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let removed = 0;
    for (const file of files) {
      if (total <= this.maxBytes) break;
      if (await this.remove(file.reference)) {
        total -= file.size;
        removed += 1;
      }
    }
    return removed;
  }
}
