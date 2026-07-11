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
  byKind: Partial<Record<OptimizationKind, KindStats>>;
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
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let event: OptimizationEvent;
      try {
        event = JSON.parse(line) as OptimizationEvent;
      } catch {
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
    return { ...finalize(total), byKind };
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
  priced: boolean;
  billableTokensSaved: number;
  billedCostSaved: number | null;
}

export interface UsageSummary {
  records: number;
  byMode: Record<UsageMode, UsageTotals>;
  pairs: UsagePair[];
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

function accumulate(totals: UsageTotals, record: UsageRecord): void {
  totals.records += 1;
  totals.inputTokens += record.usage.inputTokens;
  totals.cachedInputTokens += record.usage.cachedInputTokens;
  totals.outputTokens += record.usage.outputTokens;
  totals.reasoningTokens += record.usage.reasoningTokens;
  totals.billableTokens +=
    Math.max(0, record.usage.inputTokens - record.usage.cachedInputTokens) + record.usage.outputTokens;
  if (record.cost.priced) {
    totals.pricedRecords += 1;
    totals.billedCost += record.cost.totalCost;
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
    const groups = new Map<string, { model: string; baseline: UsageTotals; optimized: UsageTotals }>();
    let records = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let record: UsageRecord;
      try {
        record = JSON.parse(line) as UsageRecord;
      } catch {
        continue;
      }
      records += 1;
      accumulate(byMode[record.mode], record);
      const group =
        groups.get(record.baselineId) ??
        { model: record.model, baseline: emptyTotals(), optimized: emptyTotals() };
      accumulate(group[record.mode], record);
      groups.set(record.baselineId, group);
    }
    const pairs: UsagePair[] = [];
    for (const [id, group] of groups) {
      if (group.baseline.records === 0 || group.optimized.records === 0) continue;
      const priced = group.baseline.pricedRecords > 0 && group.optimized.pricedRecords > 0;
      pairs.push({
        baselineId: id,
        model: group.model,
        priced,
        billableTokensSaved: group.baseline.billableTokens - group.optimized.billableTokens,
        billedCostSaved: priced ? group.baseline.billedCost - group.optimized.billedCost : null,
      });
    }
    return { records, byMode, pairs };
  }
}
