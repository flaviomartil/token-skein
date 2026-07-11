import { describe, expect, test } from "bun:test";

import { computeCost, costForModel, isPriced, priceModel, type ModelPricing } from "../src/pricing.ts";
import type { ProviderUsage } from "../src/types.ts";

const pricing: ModelPricing = { input: 2, cachedInput: 0.5, output: 8, source: "2026-01-15" };

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    imageInputTokens: 0,
    outputTokens: 500_000,
    reasoningTokens: 100_000,
    totalTokens: 1_500_000,
    ...overrides,
  };
}

describe("cache-aware cost", () => {
  test("charges uncached input, cached input, and output separately", () => {
    const cost = computeCost(usage(), pricing);
    expect(cost.priced).toBeTrue();
    expect(cost.uncachedInputCost).toBeCloseTo(1.2, 10);
    expect(cost.cachedInputCost).toBeCloseTo(0.2, 10);
    expect(cost.outputCost).toBeCloseTo(4, 10);
    expect(cost.totalCost).toBeCloseTo(5.4, 10);
    expect(cost.pricingSource).toBe("2026-01-15");
  });

  test("never charges cached tokens at the full input rate", () => {
    const cached = computeCost(usage({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }), pricing);
    const uncached = computeCost(usage({ inputTokens: 1_000_000, cachedInputTokens: 0 }), pricing);
    expect(cached.uncachedInputCost).toBe(0);
    expect(cached.cachedInputCost).toBeLessThan(uncached.uncachedInputCost);
  });
});

describe("catalog pricing", () => {
  test("returns unknown for a model without dated pricing", () => {
    // gpt-5.4-cyber aparece na página de preços sem valores publicados.
    expect(priceModel("gpt-5.4-cyber")).toBeNull();
    const cost = costForModel(usage(), "gpt-5.4-cyber");
    expect(cost.priced).toBeFalse();
    expect(cost.totalCost).toBe(0);
    expect(cost.pricingSource).toBeNull();
    expect(cost.unknownReason).toContain("gpt-5.4-cyber");
  });

  test("prices a known catalog model", () => {
    const cost = costForModel(usage(), "gpt-4o");
    expect(cost.priced).toBeTrue();
    expect(cost.pricingSource).not.toBeNull();
    expect(cost.totalCost).toBeGreaterThan(0);
  });

  test("isPriced returns true for catalog models", () => {
    expect(isPriced("gpt-4o")).toBeTrue();
    expect(isPriced("gpt-4o-mini")).toBeTrue();
    expect(isPriced("gpt-4.1")).toBeTrue();
    expect(isPriced("gpt-5.6-sol")).toBeTrue();
    expect(isPriced("gpt-5.6-terra")).toBeTrue();
    expect(isPriced("gpt-5.6-luna")).toBeTrue();
    expect(isPriced("gpt-5.4")).toBeTrue();
  });

  test("isPriced returns false for unpriced models", () => {
    expect(isPriced("gpt-5.6")).toBeFalse();
    const cost = costForModel(usage(), "gpt-5.6");
    expect(cost.priced).toBeFalse();
    expect(cost.unknownReason).toContain("gpt-5.6");
  });
});
