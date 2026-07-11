import { createHash } from "node:crypto";

import type { ProviderUsage, TokenSkeinConfig } from "./types.ts";

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function emptyUsage(): ProviderUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    imageInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function parseUsage(usage: unknown): ProviderUsage | null {
  const record = toRecord(usage);
  if (!record) return null;
  const input = toNumber(record.input_tokens);
  const output = toNumber(record.output_tokens);
  if (input === null && output === null) return null;
  const inputDetails = toRecord(record.input_tokens_details);
  const outputDetails = toRecord(record.output_tokens_details);
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  return {
    inputTokens,
    cachedInputTokens: toNumber(inputDetails?.cached_tokens) ?? 0,
    imageInputTokens: toNumber(inputDetails?.image_tokens) ?? 0,
    outputTokens,
    reasoningTokens: toNumber(outputDetails?.reasoning_tokens) ?? 0,
    totalTokens: toNumber(record.total_tokens) ?? inputTokens + outputTokens,
  };
}

export function parseCompletedUsage(response: unknown): ProviderUsage | null {
  const record = toRecord(response);
  if (!record) return null;
  const nested = toRecord(record.response);
  return parseUsage(nested?.usage ?? record.usage);
}

const MAX_EVENT_BYTES = 1_048_576;

export class SseUsageExtractor {
  private pending = "";
  private found: ProviderUsage | null = null;

  push(text: string): void {
    if (this.found) return;
    this.pending += text;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const block = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.consume(block);
      if (this.found) {
        this.pending = "";
        return;
      }
    }
    if (this.pending.length > MAX_EVENT_BYTES) {
      this.pending = this.pending.slice(-MAX_EVENT_BYTES);
    }
  }

  private consume(block: string): void {
    if (!block.includes('"usage"')) return;
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      this.found = parseCompletedUsage(JSON.parse(data));
    } catch {
      this.found = null;
    }
  }

  get usage(): ProviderUsage | null {
    return this.found;
  }
}

export async function captureUsage(
  stream: ReadableStream<Uint8Array>,
  streaming: boolean,
  startedAt: number,
  maxJsonBytes: number,
): Promise<{ usage: ProviderUsage | null; firstByteMs: number }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let firstByteMs = -1;

  if (streaming) {
    const extractor = new SseUsageExtractor();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs < 0) firstByteMs = performance.now() - startedAt;
      extractor.push(decoder.decode(value, { stream: true }));
      if (extractor.usage) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return { usage: extractor.usage, firstByteMs };
  }

  let text = "";
  let overflow = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs < 0) firstByteMs = performance.now() - startedAt;
    if (overflow) continue;
    text += decoder.decode(value, { stream: true });
    if (Buffer.byteLength(text, "utf8") > maxJsonBytes) {
      overflow = true;
      text = "";
    }
  }
  if (overflow || !text) return { usage: null, firstByteMs };
  try {
    return { usage: parseCompletedUsage(JSON.parse(text)), firstByteMs };
  } catch {
    return { usage: null, firstByteMs };
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = toRecord(value);
  if (!record) return JSON.stringify(value ?? null);
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function configHash(config: TokenSkeinConfig): string {
  const relevant = {
    compression: config.compression,
    vision: config.vision,
    style: config.style,
    routing: config.routing,
    shell: config.shell,
  };
  return createHash("sha256").update(stableStringify(relevant)).digest("hex").slice(0, 16);
}

export function baselineId(fixture: string | null, model: string, hash: string): string {
  return createHash("sha256")
    .update(`${fixture ?? ""}\u0000${model}\u0000${hash}`)
    .digest("hex")
    .slice(0, 16);
}
