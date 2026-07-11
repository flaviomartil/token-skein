#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

import { aggregate, parseEventLine, type DashboardSummary, type TokenStats } from "./dashboard/aggregate.ts";
import { loadConfig } from "./config.ts";
import { readUsageInsights, type UsageCostInsight, type UsageLatencyInsight } from "./metrics.ts";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokenSkein Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0b0e14;
    color: #e6e8ee;
    font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8890a4; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: #131722; border: 1px solid #1f2432; border-radius: 8px; padding: 14px 16px; }
  .card .label { color: #8890a4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .value { font-size: 22px; margin-top: 6px; color: #7ee787; }
  .card .value.neutral { color: #e6e8ee; }
  .card .value.warn { color: #f0c674; }
  section { margin-bottom: 32px; }
  h2 { font-size: 14px; color: #8890a4; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #1f2432; }
  th { color: #8890a4; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  svg { background: #131722; border: 1px solid #1f2432; border-radius: 8px; }
  .empty { color: #8890a4; padding: 20px; }
  .err { color: #f07178; padding: 20px; }
</style>
</head>
<body>
<h1>TokenSkein Dashboard</h1>
<div class="sub" id="window">loading…</div>
<div class="cards" id="cards"></div>
<section>
  <h2>By mode</h2>
  <div id="byKind"></div>
</section>
<section>
  <h2>By model</h2>
  <div id="byModel"></div>
</section>
<section>
  <h2>Events over time (tokens saved per hour)</h2>
  <div id="series"></div>
</section>
<script>
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function card(label, value, cls) {
  return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value ' + (cls || "") + '">' + esc(value) + "</div></div>";
}

function statTable(rows, title) {
  if (Object.keys(rows).length === 0) return '<div class="empty">no data</div>';
  var head = "<tr><th>" + esc(title) + '</th><th class="num">Events</th><th class="num">Tokens before</th><th class="num">Tokens after</th><th class="num">Saved</th><th class="num">Saved %</th></tr>';
  var body = Object.keys(rows).sort().map(function (key) {
    var r = rows[key];
    return "<tr><td>" + esc(key) + '</td><td class="num">' + r.events + '</td><td class="num">' + r.tokensBefore + '</td><td class="num">' + r.tokensAfter + '</td><td class="num">' + r.tokensSaved + '</td><td class="num">' + r.savingsPercent + "%</td></tr>";
  }).join("");
  return "<table>" + head + body + "</table>";
}

function seriesSvg(series) {
  if (series.length === 0) return '<div class="empty">no data</div>';
  var w = 760, h = 180, pad = 24;
  var max = Math.max(1, Math.max.apply(null, series.map(function (p) { return p.tokensSaved; })));
  var step = series.length > 1 ? (w - pad * 2) / (series.length - 1) : 0;
  var points = series.map(function (p, i) {
    var x = pad + i * step;
    var y = h - pad - (p.tokensSaved / max) * (h - pad * 2);
    return x + "," + y;
  }).join(" ");
  var dots = series.map(function (p, i) {
    var x = pad + i * step;
    var y = h - pad - (p.tokensSaved / max) * (h - pad * 2);
    return '<circle cx="' + x + '" cy="' + y + '" r="2.5" fill="#7ee787"><title>' + esc(p.bucket) + ": " + p.tokensSaved + " tokens saved (" + p.events + " events)</title></circle>";
  }).join("");
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">' +
    '<polyline points="' + points + '" fill="none" stroke="#7ee787" stroke-width="1.5" />' +
    dots +
    "</svg>";
}

fetch("/api/summary").then(function (r) { return r.json(); }).then(function (s) {
  document.getElementById("window").textContent =
    (s.windowStart ? s.windowStart + " -> " + s.windowEnd : "no events yet") +
    " | " + s.totalEvents + " events | " + s.skippedLines + " skipped lines";

  var cost = s.cost.totalUsd === "unknown" ? "unknown" : "$" + s.cost.totalUsd.toFixed(4);
  var latency = s.latency === "unknown" ? "unknown" : s.latency.p50Ms + "ms p50 / " + s.latency.p95Ms + "ms p95";

  document.getElementById("cards").innerHTML =
    card("Total events", s.totalEvents) +
    card("Tokens saved", s.tokens.total.tokensSaved) +
    card("Tokens added", s.tokens.total.tokensAdded, s.tokens.total.tokensAdded > 0 ? "warn" : "neutral") +
    card("Savings %", s.tokens.total.savingsPercent + "%") +
    card("Cost", cost, s.cost.totalUsd === "unknown" ? "warn" : "neutral") +
    card("Latency", latency, s.latency === "unknown" ? "warn" : "neutral") +
    card("Cache hit/miss/unknown", s.cache.hits + "/" + s.cache.misses + "/" + s.cache.unknownStatus, "neutral") +
    card("Retrieval events", s.retrievalEvents, "neutral") +
    card("Skipped lines", s.skippedLines, s.skippedLines > 0 ? "warn" : "neutral");

  document.getElementById("byKind").innerHTML = statTable(s.tokens.byKind, "Mode");
  document.getElementById("byModel").innerHTML = statTable(s.tokens.byModel, "Model");
  document.getElementById("series").innerHTML = seriesSvg(s.series);
}).catch(function (err) {
  document.getElementById("window").innerHTML = '<span class="err">Failed to load /api/summary: ' + esc(err) + "</span>";
});
</script>
</body>
</html>
`;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function readEventLines(eventsPath: string): Promise<string[]> {
  try {
    const raw = await readFile(eventsPath, "utf8");
    return raw.split(/\r?\n/);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

type TotalTokens = TokenStats & { tokensAdded: number };

interface DashboardView extends Omit<DashboardSummary, "cost" | "latency" | "tokens"> {
  cost: UsageCostInsight;
  latency: UsageLatencyInsight | "unknown";
  tokens: {
    total: TotalTokens;
    byKind: DashboardSummary["tokens"]["byKind"];
    byModel: DashboardSummary["tokens"]["byModel"];
  };
  usageRecords: number;
  usageSkippedLines: number;
}

export async function buildSummary(eventsPath: string, usagePath: string): Promise<DashboardView> {
  const lines = await readEventLines(eventsPath);
  const base = aggregate(lines);

  let grossSaved = 0;
  let grossAdded = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const ev = parseEventLine(line);
    if (!ev) continue;
    const delta = ev.estimatedTokensBefore - ev.estimatedTokensAfter;
    if (delta > 0) grossSaved += delta;
    else if (delta < 0) grossAdded += -delta;
  }

  const insights = await readUsageInsights(usagePath);

  return {
    ...base,
    cost: insights.cost,
    latency: insights.latency,
    tokens: {
      ...base.tokens,
      total: { ...base.tokens.total, tokensSaved: grossSaved, tokensAdded: grossAdded },
    },
    usageRecords: insights.records,
    usageSkippedLines: insights.skippedLines,
  };
}

export async function startDashboard(): Promise<ReturnType<typeof Bun.serve>> {
  const config = await loadConfig();
  const port = Number(process.env.TOKEN_SKEIN_DASHBOARD_PORT ?? 8790);

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/summary") {
        return json(await buildSummary(config.eventsPath, config.economics.usagePath));
      }
      if (url.pathname === "/") {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return json({ error: "Not found" }, 404);
    },
  });
}

if (import.meta.main) {
  const server = await startDashboard();
  console.log(`TokenSkein dashboard listening on http://${server.hostname}:${server.port}`);
}
