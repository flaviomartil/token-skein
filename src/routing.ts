import type { JsonObject, JsonValue, ReasoningEffort } from "./types.ts";

function contentText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function latestUserText(body: JsonObject): string {
  if (typeof body.input === "string") return body.input;
  if (!Array.isArray(body.input)) return "";
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.role === "user") return contentText(item.content);
  }
  return "";
}

export function classifyEffort(prompt: string): ReasoningEffort {
  const normalized = prompt.toLowerCase();
  let score = 0;
  if (prompt.length > 800) score += 1;
  if (prompt.length > 3000) score += 1;
  if (/\b(architect|architecture|migration|security|audit|debug|race condition|root cause)\b/.test(normalized)) score += 2;
  if (/\b(implement|build|refactor|fix|test|investigate|analy[sz]e)\b/.test(normalized)) score += 1;
  if (/\b(across|multiple|entire|production|critical|distributed)\b/.test(normalized)) score += 1;
  if (/\b(rename|format|typo|explain|summarize|list|find)\b/.test(normalized) && prompt.length < 600) score -= 1;
  if (score <= 0) return "low";
  if (score <= 2) return "medium";
  if (score <= 4) return "high";
  return "xhigh";
}

export function applyReasoningEffort(
  body: JsonObject,
  effort: ReasoningEffort,
  overrideExisting: boolean,
): boolean {
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    if (typeof reasoning.effort === "string" && !overrideExisting) return false;
    body.reasoning = { ...reasoning, effort };
    return true;
  }
  body.reasoning = { effort };
  return true;
}
