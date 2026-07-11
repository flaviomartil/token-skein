import { byteLength, countTextTokens } from "./tokenizer.ts";
import { compactRecoverably } from "./compact/text.ts";
import { compactToolSchemas } from "./compact/tools.ts";
import { modelAllowsVision, renderTextPages, visionIsProfitable } from "./compact/image.ts";
import { applyReasoningEffort, classifyEffort, latestUserText } from "./routing.ts";
import { ContextStore } from "./store.ts";
import type {
  TokenSkeinConfig,
  JsonObject,
  JsonValue,
  OptimizationEvent,
  ReasoningEffort,
  RequestOptimizationResult,
} from "./types.ts";

export interface OptimizeRequestOptions {
  bypass?: boolean;
  vision?: boolean;
  style?: boolean;
  effort?: ReasoningEffort;
}

function event(
  partial: Omit<OptimizationEvent, "timestamp" | "source">,
): OptimizationEvent {
  return { timestamp: new Date().toISOString(), source: "proxy", ...partial };
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function appendStyle(body: JsonObject, instruction: string): boolean {
  if (typeof body.instructions === "string" && body.instructions.includes("[TokenSkein output policy]")) {
    return false;
  }
  body.instructions = `${typeof body.instructions === "string" ? `${body.instructions}\n\n` : ""}${instruction}`;
  return true;
}

function imageMessage(reference: string, pages: ReturnType<typeof renderTextPages>): JsonObject {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `[TokenSkein visual archive ${reference}] These pages contain an older tool result. Use skein_retrieve for exact identifiers or omitted details.`,
      },
      ...pages.map((page) => ({
        type: "input_image",
        image_url: page.dataUrl,
        detail: "high",
      })),
    ],
  };
}

export async function optimizeResponsesRequest(
  sourceBody: JsonObject,
  config: TokenSkeinConfig,
  store: ContextStore,
  options: OptimizeRequestOptions = {},
): Promise<RequestOptimizationResult> {
  const body = structuredClone(sourceBody);
  const events: OptimizationEvent[] = [];
  if (options.bypass) return { body, events, transformed: false };
  const model = typeof body.model === "string" ? body.model : "unknown";

  if (Array.isArray(body.tools)) {
    const compacted = compactToolSchemas(body.tools);
    if (compacted.compactedBytes < compacted.originalBytes) {
      body.tools = compacted.tools;
      events.push(
        event({
          kind: "tool-schema",
          originalBytes: compacted.originalBytes,
          optimizedBytes: compacted.compactedBytes,
          estimatedTokensBefore: countTextTokens(JSON.stringify(sourceBody.tools)),
          estimatedTokensAfter: countTextTokens(JSON.stringify(compacted.tools)),
          model,
        }),
      );
    }
  }

  const styleEnabled = options.style ?? config.style.enabled;
  if (styleEnabled && appendStyle(body, config.style.instruction)) {
    events.push(
      event({
        kind: "style",
        originalBytes: 0,
        optimizedBytes: byteLength(config.style.instruction),
        estimatedTokensBefore: 0,
        estimatedTokensAfter: countTextTokens(config.style.instruction),
        model,
      }),
    );
  }

  if (config.routing.enabled) {
    const selectedEffort = options.effort ?? classifyEffort(latestUserText(body));
    if (applyReasoningEffort(body, selectedEffort, config.routing.overrideExisting || options.effort !== undefined)) {
      events.push(
        event({
          kind: "effort-routing",
          originalBytes: 0,
          optimizedBytes: 0,
          estimatedTokensBefore: 0,
          estimatedTokensAfter: 0,
          model,
          metadata: { effort: selectedEffort },
        }),
      );
    }
  }

  if (config.compression.enabled && Array.isArray(body.input)) {
    const originalInput = body.input;
    const cutoff = Math.max(0, originalInput.length - config.compression.recentInputItems);
    const nextInput: JsonValue[] = [];
    for (let index = 0; index < originalInput.length; index += 1) {
      const rawItem = originalInput[index];
      const item = asObject(rawItem);
      if (!item || index >= cutoff || item.type !== "function_call_output" || typeof item.output !== "string") {
        nextInput.push(rawItem ?? null);
        continue;
      }
      const original = item.output;
      if (byteLength(original) < config.compression.minimumBytes) {
        nextInput.push(item);
        continue;
      }

      const compacted = await compactRecoverably(original, store, {
        kind: "function_call_output",
        maximumLines: config.compression.maximumSummaryLines,
        ttlSeconds: config.compression.ttlSeconds,
        metadata: { model, callId: typeof item.call_id === "string" ? item.call_id : "unknown" },
      });
      const beforeTokens = countTextTokens(original);
      const afterTextTokens = countTextTokens(compacted.text);
      const visionEnabled = options.vision ?? config.vision.enabled;
      if (
        visionEnabled &&
        byteLength(original) >= config.vision.minimumBytes &&
        modelAllowsVision(model, config.vision)
      ) {
        const pages = renderTextPages(original, config.vision.maximumPages);
        if (pages.length > 0 && visionIsProfitable(original, pages.length, config.vision)) {
          item.output = compacted.text;
          nextInput.push(item, imageMessage(compacted.reference ?? "skein:unknown", pages));
          events.push(
            event({
              kind: "vision",
              originalBytes: compacted.originalBytes,
              optimizedBytes: compacted.compactedBytes + pages.reduce((total, page) => total + byteLength(page.dataUrl), 0),
              estimatedTokensBefore: beforeTokens,
              estimatedTokensAfter: afterTextTokens + pages.length * config.vision.estimatedTokensPerPage,
              ...(compacted.reference ? { reference: compacted.reference } : {}),
              model,
              metadata: { pages: pages.length, strategy: compacted.strategy },
            }),
          );
          continue;
        }
      }

      if (afterTextTokens < beforeTokens) {
        item.output = compacted.text;
        events.push(
          event({
            kind: "recoverable-text",
            originalBytes: compacted.originalBytes,
            optimizedBytes: compacted.compactedBytes,
            estimatedTokensBefore: beforeTokens,
            estimatedTokensAfter: afterTextTokens,
            ...(compacted.reference ? { reference: compacted.reference } : {}),
            model,
            metadata: { strategy: compacted.strategy },
          }),
        );
      }
      nextInput.push(item);
    }
    body.input = nextInput;
  }

  return { body, events, transformed: events.length > 0 };
}
