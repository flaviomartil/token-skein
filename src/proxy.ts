import { loadConfig } from "./config.ts";
import { MetricsRecorder } from "./metrics.ts";
import { optimizeResponsesRequest } from "./optimize.ts";
import { ContextStore } from "./store.ts";
import type { TokenSkeinConfig, JsonObject, ReasoningEffort } from "./types.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
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

async function handleRetrieve(request: Request, store: ContextStore): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
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
    typeof record.maxChars === "number" ? record.maxChars : 80_000,
  );
  if (content === null) return json({ error: "Context not found or expired." }, 404);
  return json({ reference: record.reference, content });
}

async function forward(
  request: Request,
  config: TokenSkeinConfig,
  store: ContextStore,
  metrics: MetricsRecorder,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, config.upstream);
  let body: BodyInit | null = request.body;
  let savedEstimate = 0;

  if (request.method === "POST" && incomingUrl.pathname.endsWith("/responses")) {
    let parsed: unknown;
    try {
      parsed = await request.json();
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
    const optimized = await optimizeResponsesRequest(parsed as JsonObject, config, store, {
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

  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders(request),
      body: request.method === "GET" || request.method === "HEAD" ? null : body,
      redirect: "manual",
    });
    const headers = responseHeaders(upstream.headers);
    headers.set("x-token-skein-estimated-tokens-saved", String(savedEstimate));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return json(
      {
        error: "Unable to reach upstream.",
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}

export async function startProxy(overrides?: Partial<TokenSkeinConfig>): Promise<ReturnType<typeof Bun.serve>> {
  const config = await loadConfig(overrides);
  const store = new ContextStore(config.storeDirectory);
  const metrics = new MetricsRecorder(config.eventsPath);
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
        return json({ metrics: await metrics.summary(), store: await store.stats() });
      }
      if (url.pathname === "/v1/token-skein/retrieve" && request.method === "POST") {
        return handleRetrieve(request, store);
      }
      return forward(request, config, store, metrics);
    },
  });
  return server;
}
