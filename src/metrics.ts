import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OptimizationEvent, OptimizationKind } from "./types.ts";

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
