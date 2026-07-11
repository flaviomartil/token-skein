import { encode } from "gpt-tokenizer";

export function countTextTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
