export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CompressionConfig {
  enabled: boolean;
  minimumBytes: number;
  recentInputItems: number;
  maximumSummaryLines: number;
  ttlSeconds: number;
}

export interface VisionConfig {
  enabled: boolean;
  models: string[];
  minimumBytes: number;
  maximumPages: number;
  estimatedTokensPerPage: number;
  minimumSavingsRatio: number;
}

export interface StyleConfig {
  enabled: boolean;
  instruction: string;
}

export interface RoutingConfig {
  enabled: boolean;
  overrideExisting: boolean;
}

export interface ShellConfig {
  enabled: boolean;
  preferRtk: boolean;
  minimumBytes: number;
  maximumLines: number;
}

export interface ArchiveConfig {
  maxBytes: number;
}

export interface TokenSkeinConfig {
  schemaVersion: number;
  host: string;
  port: number;
  upstream: string;
  storeDirectory: string;
  eventsPath: string;
  compression: CompressionConfig;
  vision: VisionConfig;
  style: StyleConfig;
  routing: RoutingConfig;
  shell: ShellConfig;
  archive: ArchiveConfig;
}

export type OptimizationKind =
  | "tool-schema"
  | "recoverable-text"
  | "vision"
  | "style"
  | "effort-routing"
  | "shell";

export interface OptimizationEvent {
  timestamp: string;
  kind: OptimizationKind;
  source: "proxy" | "mcp" | "shell";
  originalBytes: number;
  optimizedBytes: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  reference?: string;
  model?: string;
  metadata?: Record<string, JsonValue>;
}

export interface StoredContext {
  version: 1;
  reference: string;
  createdAt: string;
  expiresAt: string;
  kind: string;
  original: string;
  compacted: string;
  metadata: Record<string, JsonValue>;
}

export interface CompactionResult {
  text: string;
  reference?: string;
  originalBytes: number;
  compactedBytes: number;
  strategy: string;
}

export interface RequestOptimizationResult {
  body: JsonObject;
  events: OptimizationEvent[];
  transformed: boolean;
}
