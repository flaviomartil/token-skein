import { createHash, timingSafeEqual } from "node:crypto";

import { loadConfig } from "./config.ts";
import { baselineId, captureUsage, configHash, emptyUsage } from "./economics.ts";
import { MetricsRecorder, UsageRecorder } from "./metrics.ts";
import { optimizeResponsesRequest } from "./optimize.ts";
import { costForModel, unknownCost } from "./pricing.ts";
import { ContextStore } from "./store.ts";
import type { TokenSkeinConfig, JsonObject, ReasoningEffort, UsageMode } from "./types.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized === "::ffff:127.0.0.1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (ipv4) return Number(ipv4[1]) === 127;
  return false;
}

export function loopbackEnforcement(
  host: string,
  allowRemote: boolean,
): { allowed: true } | { allowed: false; reason: string } {
  if (isLoopbackHost(host) || allowRemote) return { allowed: true };
  return {
    allowed: false,
    reason:
      `token-skein refuses to bind to non-loopback host "${host}" because ` +
      "/v1/token-skein/retrieve returns unredacted stored originals without authentication. " +
      "Set TOKEN_SKEIN_ALLOW_REMOTE=1 to bind remotely on purpose.",
  };
}

async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) {
    const buffer = new Uint8Array(await request.arrayBuffer());
    return buffer.byteLength > limit ? null : buffer;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function truthyHeader(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (["1", "true", "on", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "off", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

function effortHeader(value: string | null): ReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : undefined;
}

function upstreamHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const key of [
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "x-token-skein-bypass",
    "x-token-skein-vision",
    "x-token-skein-style",
    "x-token-skein-effort",
    "x-token-skein-fixture",
  ]) {
    headers.delete(key);
  }
  headers.set("content-type", "application/json");
  headers.set("accept-encoding", "identity");
  return headers;
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return headers;
}

function clampMaxChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 80_000;
  return Math.min(Math.floor(value), 500_000);
}

function authorizeRequest(request: Request): Response | null {
  const expected = process.env.TOKEN_SKEIN_AUTH_TOKEN;
  if (expected === undefined) return null;
  if (expected === "") {
    console.error("token-skein: TOKEN_SKEIN_AUTH_TOKEN is set but empty; denying protected endpoints.");
    return json({ error: "Unauthorized." }, 401);
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.*)$/is.exec(header);
  const presented = match?.[1] ?? "";
  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  if (timingSafeEqual(presentedHash, expectedHash)) return null;
  return json({ error: "Unauthorized." }, 401);
}

async function handleRetrieve(request: Request, store: ContextStore, limit: number): Promise<Response> {
  const raw = await readLimitedBody(request, limit);
  if (raw === null) {
    return json({ error: "Request body exceeds the configured size limit." }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Expected an object body." }, 400);
  }
  const record = body as Record<string, unknown>;
  if (typeof record.reference !== "string") {
    return json({ error: "reference is required." }, 400);
  }
  const content = await store.retrieve(
    record.reference,
    typeof record.query === "string" ? record.query : undefined,
    clampMaxChars(record.maxChars),
  );
  if (content === null) return json({ error: "Context not found or expired." }, 404);
  return json({ reference: record.reference, content });
}

async function forward(
  request: Request,
  config: TokenSkeinConfig,
  store: ContextStore,
  metrics: MetricsRecorder,
  usage: UsageRecorder,
  cfgHash: string,
): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > config.limits.maxRequestBytes) {
    return json({ error: "Request body exceeds the configured size limit." }, 413);
  }

  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, config.upstream);
  const isResponses = request.method === "POST" && incomingUrl.pathname.endsWith("/responses");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let rawBody = new Uint8Array(0);
  if (hasBody) {
    const read = await readLimitedBody(request, config.limits.maxRequestBytes);
    if (read === null) {
      return json({ error: "Request body exceeds the configured size limit." }, 413);
    }
    rawBody = read;
  }

  let body: BodyInit | null = hasBody ? rawBody : null;
  let savedEstimate = 0;
  let model = "unknown";
  let mode: UsageMode = "optimized";
  let fixture: string | null = null;
  let pairId = "";

  if (isResponses) {
    const raw = new TextDecoder().decode(rawBody);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "Responses requests must contain valid JSON." }, 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Responses request body must be an object." }, 400);
    }
    const bypass = truthyHeader(request.headers.get("x-token-skein-bypass"));
    const vision = truthyHeader(request.headers.get("x-token-skein-vision"));
    const style = truthyHeader(request.headers.get("x-token-skein-style"));
    const effort = effortHeader(request.headers.get("x-token-skein-effort"));
    const source = parsed as JsonObject;
    model = typeof source.model === "string" ? source.model : "unknown";
    fixture = request.headers.get("x-token-skein-fixture");
    mode = bypass === true ? "baseline" : "optimized";
    pairId = baselineId(fixture, model, cfgHash);
    const optimized = await optimizeResponsesRequest(source, config, store, {
      ...(bypass === undefined ? {} : { bypass }),
      ...(vision === undefined ? {} : { vision }),
      ...(style === undefined ? {} : { style }),
      ...(effort === undefined ? {} : { effort }),
    });
    await metrics.recordMany(optimized.events);
    savedEstimate = optimized.events.reduce(
      (total, event) => total + Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter),
      0,
    );
    body = JSON.stringify(optimized.body);
  }

  const startedAt = performance.now();
  const headerController = new AbortController();
  const headerTimeout = setTimeout(
    () =>
      headerController.abort(
        new DOMException("Upstream timed out before sending response headers.", "TimeoutError"),
      ),
    config.limits.upstreamTimeoutMs,
  );
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders(request),
      body: request.method === "GET" || request.method === "HEAD" ? null : body,
      redirect: "manual",
      signal: headerController.signal,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return json({ error: "Upstream request timed out." }, 504);
    }
    return json(
      {
        error: "Unable to reach upstream.",
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  } finally {
    clearTimeout(headerTimeout);
  }

  const headers = responseHeaders(upstream.headers);
  headers.set("x-token-skein-estimated-tokens-saved", String(savedEstimate));
  if (isResponses) headers.set("x-token-skein-baseline-id", pairId);

  if (isResponses && config.economics.enabled && upstream.body) {
    const [clientStream, inspectStream] = upstream.body.tee();
    const streaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    void recordUsage({
      stream: inspectStream,
      streaming,
      startedAt,
      model,
      mode,
      fixture,
      cfgHash,
      pairId,
      usage,
      maxJsonBytes: config.limits.maxRequestBytes,
    });
    return new Response(clientStream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

interface RecordUsageArgs {
  stream: ReadableStream<Uint8Array>;
  streaming: boolean;
  startedAt: number;
  model: string;
  mode: UsageMode;
  fixture: string | null;
  cfgHash: string;
  pairId: string;
  usage: UsageRecorder;
  maxJsonBytes: number;
}

async function recordUsage(args: RecordUsageArgs): Promise<void> {
  try {
    const captured = await captureUsage(args.stream, args.streaming, args.startedAt, args.maxJsonBytes);
    const providerUsage = captured.usage ?? emptyUsage();
    const cost = captured.usage
      ? costForModel(providerUsage, args.model)
      : unknownCost("usage not reported by provider");
    await args.usage.record({
      timestamp: new Date().toISOString(),
      model: args.model,
      mode: args.mode,
      streaming: args.streaming,
      reported: captured.usage !== null,
      fixture: args.fixture,
      configHash: args.cfgHash,
      baselineId: args.pairId,
      firstByteMs: captured.firstByteMs < 0 ? 0 : Number(captured.firstByteMs.toFixed(2)),
      usage: providerUsage,
      cost,
    });
  } catch {
    return;
  }
}

export function createStore(config: TokenSkeinConfig): ContextStore {
  return new ContextStore(config.storeDirectory, config.archive.maxBytes);
}

export async function startProxy(overrides?: Partial<TokenSkeinConfig>): Promise<ReturnType<typeof Bun.serve>> {
  const config = await loadConfig(overrides);
  const decision = loopbackEnforcement(config.host, process.env.TOKEN_SKEIN_ALLOW_REMOTE === "1");
  if (!decision.allowed) throw new Error(decision.reason);
  const store = createStore(config);
  const metrics = new MetricsRecorder(config.eventsPath);
  const usage = new UsageRecorder(config.economics.usagePath);
  const cfgHash = configHash(config);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return json({ status: "ok", service: "token-skein", upstream: config.upstream });
      }
      if (url.pathname === "/v1/token-skein/stats" && request.method === "GET") {
        const denied = authorizeRequest(request);
        if (denied) return denied;
        return json({
          metrics: await metrics.summary(),
          usage: await usage.summary(),
          store: await store.stats(),
        });
      }
      if (url.pathname === "/v1/token-skein/retrieve" && request.method === "POST") {
        const denied = authorizeRequest(request);
        if (denied) return denied;
        return handleRetrieve(request, store, config.limits.maxRequestBytes);
      }
      return forward(request, config, store, metrics, usage, cfgHash);
    },
  });
  return server;
}
