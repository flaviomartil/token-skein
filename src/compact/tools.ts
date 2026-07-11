import type { JsonValue } from "../types.ts";

const DROPPED_SCHEMA_KEYS = new Set([
  "$id",
  "$schema",
  "$comment",
  "deprecated",
  "example",
  "examples",
  "markdownDescription",
  "readOnly",
  "title",
  "writeOnly",
]);

function compactValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(compactValue);
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "description" && typeof child === "string") {
      output[key] = child.replace(/\s+/g, " ").trim();
    } else {
      output[key] = compactValue(child);
    }
  }
  return output;
}

export function compactToolSchemas(tools: JsonValue): {
  tools: JsonValue;
  originalBytes: number;
  compactedBytes: number;
} {
  const original = JSON.stringify(tools);
  const compacted = compactValue(tools);
  const serialized = JSON.stringify(compacted);
  return {
    tools: serialized.length < original.length ? compacted : tools,
    originalBytes: Buffer.byteLength(original),
    compactedBytes: Buffer.byteLength(serialized.length < original.length ? serialized : original),
  };
}
