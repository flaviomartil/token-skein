import type { CostBreakdown, ProviderUsage } from "./types.ts";

export interface ModelPricing {
  input: number;
  cachedInput: number;
  output: number;
  source: string;
}

// Preços em USD por 1M tokens, tier Standard.
// Fonte: https://platform.openai.com/docs/pricing (capturado em 2026-07-11).
// Modelos sem desconto de cache (5.5-pro / 5.4-pro) usam cachedInput = input
// para nunca subestimar custo.
export const PRICE_CATALOG: Record<string, ModelPricing> = {
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30, source: "2026-07-11" },
  "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15, source: "2026-07-11" },
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6, source: "2026-07-11" },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30, source: "2026-07-11" },
  "gpt-5.5-pro": { input: 30, cachedInput: 30, output: 180, source: "2026-07-11" },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15, source: "2026-07-11" },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5, source: "2026-07-11" },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25, source: "2026-07-11" },
  "gpt-5.4-pro": { input: 30, cachedInput: 30, output: 180, source: "2026-07-11" },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10, source: "2026-01-15" },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6, source: "2026-01-15" },
  "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8, source: "2026-01-15" },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6, source: "2026-01-15" },
};

export function priceModel(model: string): ModelPricing | null {
  const pricing = PRICE_CATALOG[model];
  if (!pricing || !pricing.source) return null;
  return pricing;
}

export function isPriced(model: string): boolean {
  return priceModel(model) !== null;
}

export function unknownCost(reason: string): CostBreakdown {
  return {
    priced: false,
    currency: "usd",
    pricingSource: null,
    uncachedInputCost: 0,
    cachedInputCost: 0,
    outputCost: 0,
    totalCost: 0,
    unknownReason: reason,
  };
}

export function computeCost(usage: ProviderUsage, pricing: ModelPricing): CostBreakdown {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const uncachedInputCost = (uncachedInput / 1_000_000) * pricing.input;
  const cachedInputCost = (usage.cachedInputTokens / 1_000_000) * pricing.cachedInput;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  return {
    priced: true,
    currency: "usd",
    pricingSource: pricing.source,
    uncachedInputCost,
    cachedInputCost,
    outputCost,
    totalCost: uncachedInputCost + cachedInputCost + outputCost,
    unknownReason: null,
  };
}

export function costForModel(usage: ProviderUsage, model: string): CostBreakdown {
  const pricing = priceModel(model);
  if (!pricing) return unknownCost(`no dated price for model ${model}`);
  return computeCost(usage, pricing);
}
