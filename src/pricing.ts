import type { CostBreakdown, ProviderUsage } from "./types.ts";

export interface ModelPricing {
  input: number;
  cachedInput: number;
  output: number;
  source: string;
}

export const PRICE_CATALOG: Record<string, ModelPricing> = {
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
