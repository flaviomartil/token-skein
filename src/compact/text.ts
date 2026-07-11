import { byteLength, countTextTokens } from "../tokenizer.ts";
import { ContextStore } from "../store.ts";
import type { CompactionResult, JsonValue } from "../types.ts";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b([A-Z0-9_-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_-]*)\s*[:=]\s*([^\s,}]+)/gi,
];

const EXACT_PATTERNS = [
  /\b[a-f0-9]{7,64}\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  /(?:^|\s)(?:\.{0,2}\/|\/)[A-Za-z0-9_./@+:-]+/g,
  /https?:\/\/[^\s)\]}>,]+/g,
  /\b[A-Z][A-Z0-9_]{2,}\b/g,
  /\b(?:ERR|E)[A-Z0-9_]{2,}\b/g,
];

function redactSecrets(text: string): string {
  let output = text;
  output = output.replace(SECRET_PATTERNS[0]!, "sk-[REDACTED]");
  output = output.replace(SECRET_PATTERNS[1]!, "$1 [REDACTED]");
  output = output.replace(SECRET_PATTERNS[2]!, "$1=[REDACTED]");
  return output;
}

function exactSidecar(text: string, limit = 30): string[] {
  const redacted = redactSecrets(text);
  const values = new Set<string>();
  for (const pattern of EXACT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of redacted.matchAll(pattern)) {
      const value = match[0].trim();
      if (value.length >= 3 && value.length <= 240) values.add(value);
      if (values.size >= limit) return [...values];
    }
  }
  return [...values];
}

function valueShape(value: unknown, depth = 0): unknown {
  if (depth >= 3) return Array.isArray(value) ? `[array:${value.length}]` : typeof value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 3).map((item) => valueShape(item, depth + 1)),
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.slice(0, 80).map(([key, child]) => [key, valueShape(child, depth + 1)]));
  }
  if (typeof value === "string") return value.length <= 120 ? redactSecrets(value) : `[string:${value.length}]`;
  return value;
}

function tryCompactJson(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as JsonValue;
    return `[JSON structural summary]\n${JSON.stringify(valueShape(parsed), null, 2)}`;
  } catch {
    return null;
  }
}

function compactLines(text: string, maximumLines: number): string {
  const lines = text.split(/\r?\n/);
  const deduped: string[] = [];
  let previous = "";
  let repeats = 0;
  for (const line of lines) {
    if (line === previous) {
      repeats += 1;
      continue;
    }
    if (repeats > 0) deduped.push(`[previous line repeated ${repeats} times]`);
    previous = line;
    repeats = 0;
    deduped.push(redactSecrets(line));
  }
  if (repeats > 0) deduped.push(`[previous line repeated ${repeats} times]`);
  if (deduped.length <= maximumLines) return deduped.join("\n");

  const important = deduped.filter((line) => /\b(error|failed|failure|warning|warn|panic|exception|denied)\b/i.test(line));
  const head = deduped.slice(0, Math.min(24, Math.floor(maximumLines / 4)));
  const tail = deduped.slice(-Math.min(48, Math.floor(maximumLines / 3)));
  const selected = [...head, ...important.slice(0, Math.floor(maximumLines / 3)), ...tail];
  return [...new Set(selected)].slice(0, maximumLines).join("\n");
}

export interface CompactTextOptions {
  kind: string;
  maximumLines: number;
  ttlSeconds: number;
  metadata?: Record<string, JsonValue>;
}

export async function compactRecoverably(
  text: string,
  store: ContextStore,
  options: CompactTextOptions,
): Promise<CompactionResult> {
  const jsonSummary = tryCompactJson(text);
  const core = jsonSummary ?? compactLines(text, options.maximumLines);
  const identifiers = exactSidecar(text);
  const sidecar = identifiers.length > 0 ? `\n\nExact identifiers retained as text:\n${identifiers.join("\n")}` : "";
  const provisional = `${core}${sidecar}`;
  const entry = await store.put(text, {
    kind: options.kind,
    compacted: provisional,
    ttlSeconds: options.ttlSeconds,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  const marker = [
    `[TokenSkein archived ${options.kind}]`,
    `reference=${entry.reference}`,
    `original_tokens=${countTextTokens(text)}`,
    `retrieve with skein_retrieve when exact or omitted details are needed`,
  ].join(" ");
  const compacted = `${marker}\n${provisional}`;
  return {
    text: compacted,
    reference: entry.reference,
    originalBytes: byteLength(text),
    compactedBytes: byteLength(compacted),
    strategy: jsonSummary ? "json-shape" : "line-salience",
  };
}
