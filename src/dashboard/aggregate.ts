import type { JsonValue, OptimizationKind } from "../types.ts";

const KNOWN_KINDS: readonly OptimizationKind[] = [
  "tool-schema",
  "recoverable-text",
  "vision",
  "style",
  "effort-routing",
  "shell",
];

export interface ParsedEvent {
  timestamp: string;
  kind: OptimizationKind;
  source: string;
  originalBytes: number;
  optimizedBytes: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  reference?: string;
  model?: string;
  metadata?: Record<string, JsonValue>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseEventLine(line: string): ParsedEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.timestamp !== "string") return null;
  if (typeof value.kind !== "string" || !KNOWN_KINDS.includes(value.kind as OptimizationKind)) return null;
  if (typeof value.source !== "string") return null;
  if (!isFiniteNumber(value.originalBytes)) return null;
  if (!isFiniteNumber(value.optimizedBytes)) return null;
  if (!isFiniteNumber(value.estimatedTokensBefore)) return null;
  if (!isFiniteNumber(value.estimatedTokensAfter)) return null;

  return {
    timestamp: value.timestamp,
    kind: value.kind as OptimizationKind,
    source: value.source,
    originalBytes: value.originalBytes,
    optimizedBytes: value.optimizedBytes,
    estimatedTokensBefore: value.estimatedTokensBefore,
    estimatedTokensAfter: value.estimatedTokensAfter,
    ...(typeof value.reference === "string" ? { reference: value.reference } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? { metadata: value.metadata as Record<string, JsonValue> }
      : {}),
  };
}

export interface TokenStats {
  events: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  savingsPercent: number;
}

function emptyTokenStats(): TokenStats {
  return { events: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, savingsPercent: 0 };
}

function addEvent(stats: TokenStats, ev: ParsedEvent): void {
  stats.events += 1;
  stats.tokensBefore += ev.estimatedTokensBefore;
  stats.tokensAfter += ev.estimatedTokensAfter;
}

function finalizeTokenStats(stats: TokenStats): TokenStats {
  stats.tokensSaved = Math.max(0, stats.tokensBefore - stats.tokensAfter);
  stats.savingsPercent =
    stats.tokensBefore > 0 ? Number(((stats.tokensSaved / stats.tokensBefore) * 100).toFixed(1)) : 0;
  return stats;
}

function numberFromMetadata(metadata: Record<string, JsonValue> | undefined, keys: string[]): number | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function booleanFromMetadata(metadata: Record<string, JsonValue> | undefined, keys: string[]): boolean | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "hit") return true;
      if (value.toLowerCase() === "miss") return false;
    }
  }
  return undefined;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)] ?? 0;
}

export interface CostSummary {
  totalUsd: number | "unknown";
  knownEvents: number;
  unknownEvents: number;
}

export interface LatencySummary {
  averageMs: number;
  p95Ms: number;
  samples: number;
}

export interface CacheSummary {
  hits: number;
  misses: number;
  unknownStatus: number;
}

export interface SeriesPoint {
  bucket: string;
  events: number;
  tokensSaved: number;
}

export interface DashboardSummary {
  windowStart: string | null;
  windowEnd: string | null;
  totalEvents: number;
  skippedLines: number;
  eventCountsByKind: Record<string, number>;
  tokens: {
    total: TokenStats;
    byKind: Record<string, TokenStats>;
    byModel: Record<string, TokenStats>;
  };
  cost: CostSummary;
  latency: LatencySummary | "unknown";
  cache: CacheSummary;
  retrievalEvents: number;
  series: SeriesPoint[];
}

function hourBucket(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 13);
}

export function aggregate(lines: string[]): DashboardSummary {
  const total = emptyTokenStats();
  const byKind: Record<string, TokenStats> = {};
  const byModel: Record<string, TokenStats> = {};
  const eventCountsByKind: Record<string, number> = {};
  const seriesByBucket = new Map<string, SeriesPoint>();

  let skippedLines = 0;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;
  let costTotal = 0;
  let costKnownEvents = 0;
  let costUnknownEvents = 0;
  const latencySamples: number[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let cacheUnknown = 0;
  let retrievalEvents = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const ev = parseEventLine(line);
    if (!ev) {
      skippedLines += 1;
      continue;
    }

    addEvent(total, ev);
    const kindStats = byKind[ev.kind] ?? emptyTokenStats();
    addEvent(kindStats, ev);
    byKind[ev.kind] = kindStats;
    eventCountsByKind[ev.kind] = (eventCountsByKind[ev.kind] ?? 0) + 1;

    const modelKey = ev.model ?? "unknown";
    const modelStats = byModel[modelKey] ?? emptyTokenStats();
    addEvent(modelStats, ev);
    byModel[modelKey] = modelStats;

    if (windowStart === null || ev.timestamp < windowStart) windowStart = ev.timestamp;
    if (windowEnd === null || ev.timestamp > windowEnd) windowEnd = ev.timestamp;

    const cost = numberFromMetadata(ev.metadata, ["costUsd", "cost"]);
    if (cost !== undefined) {
      costTotal += cost;
      costKnownEvents += 1;
    } else {
      costUnknownEvents += 1;
    }

    const latency = numberFromMetadata(ev.metadata, ["latencyMs", "durationMs"]);
    if (latency !== undefined) latencySamples.push(latency);

    const cacheHit = booleanFromMetadata(ev.metadata, ["cacheHit", "cache"]);
    if (cacheHit === true) cacheHits += 1;
    else if (cacheHit === false) cacheMisses += 1;
    else cacheUnknown += 1;

    if (ev.kind === "recoverable-text" && /retriev/i.test(String(ev.metadata?.action ?? ""))) {
      retrievalEvents += 1;
    }

    const bucket = hourBucket(ev.timestamp);
    if (bucket) {
      const point = seriesByBucket.get(bucket) ?? { bucket, events: 0, tokensSaved: 0 };
      point.events += 1;
      point.tokensSaved += Math.max(0, ev.estimatedTokensBefore - ev.estimatedTokensAfter);
      seriesByBucket.set(bucket, point);
    }
  }

  for (const stats of Object.values(byKind)) finalizeTokenStats(stats);
  for (const stats of Object.values(byModel)) finalizeTokenStats(stats);

  const sortedLatency = [...latencySamples].sort((a, b) => a - b);
  const latency: LatencySummary | "unknown" =
    sortedLatency.length > 0
      ? {
          averageMs: Number((sortedLatency.reduce((sum, value) => sum + value, 0) / sortedLatency.length).toFixed(1)),
          p95Ms: Number(percentile(sortedLatency, 95).toFixed(1)),
          samples: sortedLatency.length,
        }
      : "unknown";

  return {
    windowStart,
    windowEnd,
    totalEvents: total.events,
    skippedLines,
    eventCountsByKind,
    tokens: { total: finalizeTokenStats(total), byKind, byModel },
    cost: {
      totalUsd: costKnownEvents > 0 ? Number(costTotal.toFixed(6)) : "unknown",
      knownEvents: costKnownEvents,
      unknownEvents: costUnknownEvents,
    },
    latency,
    cache: { hits: cacheHits, misses: cacheMisses, unknownStatus: cacheUnknown },
    retrievalEvents,
    series: [...seriesByBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}
