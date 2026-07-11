import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OptimizationEvent, OptimizationKind, UsageMode, UsageRecord } from "./types.ts";

export interface KindStats {
  events: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  savingsPercent: number;
}

export interface MetricsSummary extends KindStats {
  skippedLines: number;
  byKind: Partial<Record<OptimizationKind, KindStats>>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

interface MetricsEventShape {
  kind: OptimizationKind;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

function validMetricsEvent(value: unknown): MetricsEventShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string") return null;
  if (!isFiniteNumber(record.estimatedTokensBefore)) return null;
  if (!isFiniteNumber(record.estimatedTokensAfter)) return null;
  return {
    kind: record.kind as OptimizationKind,
    estimatedTokensBefore: record.estimatedTokensBefore,
    estimatedTokensAfter: record.estimatedTokensAfter,
  };
}

function emptyStats(): KindStats {
  return {
    events: 0,
    estimatedTokensBefore: 0,
    estimatedTokensAfter: 0,
    estimatedTokensSaved: 0,
    savingsPercent: 0,
  };
}

function finalize(stats: KindStats): KindStats {
  stats.estimatedTokensSaved = Math.max(
    0,
    stats.estimatedTokensBefore - stats.estimatedTokensAfter,
  );
  stats.savingsPercent =
    stats.estimatedTokensBefore > 0
      ? Number(((stats.estimatedTokensSaved / stats.estimatedTokensBefore) * 100).toFixed(1))
      : 0;
  return stats;
}

export class MetricsRecorder {
  constructor(private readonly eventsPath: string) {}

  async record(event: OptimizationEvent): Promise<void> {
    await mkdir(dirname(this.eventsPath), { recursive: true, mode: 0o700 });
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(this.eventsPath, 0o600);
  }

  async recordMany(events: OptimizationEvent[]): Promise<void> {
    for (const event of events) await this.record(event);
  }

  async summary(): Promise<MetricsSummary> {
    let raw = "";
    try {
      raw = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
    const total = emptyStats();
    const byKind: Partial<Record<OptimizationKind, KindStats>> = {};
    let skippedLines = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      const event = validMetricsEvent(parsed);
      if (!event) {
        skippedLines += 1;
        continue;
      }
      const target = byKind[event.kind] ?? emptyStats();
      target.events += 1;
      target.estimatedTokensBefore += event.estimatedTokensBefore;
      target.estimatedTokensAfter += event.estimatedTokensAfter;
      byKind[event.kind] = target;
      total.events += 1;
      total.estimatedTokensBefore += event.estimatedTokensBefore;
      total.estimatedTokensAfter += event.estimatedTokensAfter;
    }
    for (const stats of Object.values(byKind)) finalize(stats);
    return { ...finalize(total), skippedLines, byKind };
  }
}

export interface UsageTotals {
  records: number;
  pricedRecords: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  billableTokens: number;
  billedCost: number;
}

export interface UsagePair {
  baselineId: string;
  model: string;
  fixture: string | null;
  comparable: boolean;
  priced: boolean;
  baselineRecords: number;
  optimizedRecords: number;
  billableTokensSavedPerRequest: number | null;
  billedCostSavedPerRequest: number | null;
}

export interface UsageSummary {
  records: number;
  skippedLines: number;
  byMode: Record<UsageMode, UsageTotals>;
  pairs: UsagePair[];
}

interface ValidUsageRecord {
  mode: UsageMode;
  model: string;
  baselineId: string;
  fixture: string | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
  priced: boolean;
  totalCost: number;
}

function validUsageRecord(value: unknown): ValidUsageRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.mode !== "baseline" && record.mode !== "optimized") return null;
  const usage = record.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  if (
    !isFiniteNumber(u.inputTokens) ||
    !isFiniteNumber(u.cachedInputTokens) ||
    !isFiniteNumber(u.outputTokens) ||
    !isFiniteNumber(u.reasoningTokens)
  ) {
    return null;
  }
  const cost = record.cost && typeof record.cost === "object" ? (record.cost as Record<string, unknown>) : null;
  const priced = cost?.priced === true && isFiniteNumber(cost.totalCost);
  return {
    mode: record.mode,
    model: typeof record.model === "string" ? record.model : "unknown",
    baselineId: typeof record.baselineId === "string" ? record.baselineId : "",
    fixture: typeof record.fixture === "string" ? record.fixture : null,
    usage: {
      inputTokens: u.inputTokens,
      cachedInputTokens: u.cachedInputTokens,
      outputTokens: u.outputTokens,
      reasoningTokens: u.reasoningTokens,
    },
    priced,
    totalCost: priced ? (cost!.totalCost as number) : 0,
  };
}

function emptyTotals(): UsageTotals {
  return {
    records: 0,
    pricedRecords: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    billableTokens: 0,
    billedCost: 0,
  };
}

function accumulate(totals: UsageTotals, record: ValidUsageRecord): void {
  totals.records += 1;
  totals.inputTokens += record.usage.inputTokens;
  totals.cachedInputTokens += record.usage.cachedInputTokens;
  totals.outputTokens += record.usage.outputTokens;
  totals.reasoningTokens += record.usage.reasoningTokens;
  totals.billableTokens +=
    Math.max(0, record.usage.inputTokens - record.usage.cachedInputTokens) + record.usage.outputTokens;
  if (record.priced) {
    totals.pricedRecords += 1;
    totals.billedCost += record.totalCost;
  }
}

export class UsageRecorder {
  constructor(private readonly usagePath: string) {}

  async record(record: UsageRecord): Promise<void> {
    await mkdir(dirname(this.usagePath), { recursive: true, mode: 0o700 });
    await appendFile(this.usagePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await chmod(this.usagePath, 0o600);
  }

  async summary(): Promise<UsageSummary> {
    let raw = "";
    try {
      raw = await readFile(this.usagePath, "utf8");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
    const byMode: Record<UsageMode, UsageTotals> = {
      baseline: emptyTotals(),
      optimized: emptyTotals(),
    };
    const groups = new Map<
      string,
      { model: string; fixture: string | null; baseline: UsageTotals; optimized: UsageTotals }
    >();
    let records = 0;
    let skippedLines = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      const record = validUsageRecord(parsed);
      if (!record) {
        skippedLines += 1;
        continue;
      }
      records += 1;
      accumulate(byMode[record.mode], record);
      const group =
        groups.get(record.baselineId) ??
        { model: record.model, fixture: record.fixture, baseline: emptyTotals(), optimized: emptyTotals() };
      accumulate(group[record.mode], record);
      groups.set(record.baselineId, group);
    }
    const pairs: UsagePair[] = [];
    for (const [id, group] of groups) {
      const bothSides = group.baseline.records > 0 && group.optimized.records > 0;
      const priced = bothSides && group.baseline.pricedRecords > 0 && group.optimized.pricedRecords > 0;
      const comparable = bothSides && group.fixture !== null;
      const baselinePerRequest = group.baseline.records > 0 ? group.baseline.billableTokens / group.baseline.records : 0;
      const optimizedPerRequest =
        group.optimized.records > 0 ? group.optimized.billableTokens / group.optimized.records : 0;
      pairs.push({
        baselineId: id,
        model: group.model,
        fixture: group.fixture,
        comparable,
        priced,
        baselineRecords: group.baseline.records,
        optimizedRecords: group.optimized.records,
        billableTokensSavedPerRequest: bothSides
          ? Number((baselinePerRequest - optimizedPerRequest).toFixed(3))
          : null,
        billedCostSavedPerRequest: priced
          ? Number((group.baseline.billedCost / group.baseline.records - group.optimized.billedCost / group.optimized.records).toFixed(6))
          : null,
      });
    }
    return { records, skippedLines, byMode, pairs };
  }
}
