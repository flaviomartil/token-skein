#!/usr/bin/env bun

import { codexIntegrationSnippets } from "./codex.ts";
import { configPath, loadConfig } from "./config.ts";
import { doctor, install, uninstall, verify } from "./install.ts";
import { startMcpServer } from "./mcp.ts";
import { MetricsRecorder, UsageRecorder } from "./metrics.ts";
import { startProxy } from "./proxy.ts";
import { buildCodexHookResponse, runFilteredShell, type CodexHookInput } from "./shell.ts";
import { ContextStore } from "./store.ts";

const VERSION = "0.1.0";

function help(): string {
  return `TokenSkein ${VERSION}

Usage:
  token-skein proxy                 Start the local Responses API proxy
  token-skein mcp                   Start the stdio MCP server
  token-skein hook codex            Process a Codex PreToolUse hook from stdin
  token-skein shell --encoded DATA  Execute and filter an encoded safe command
  token-skein stats                 Show aggregate savings and archive stats
  token-skein cleanup               Remove expired archived contexts
  token-skein codex-snippet         Print Codex config and hook snippets
  token-skein install               Install the Codex integration (transactional)
  token-skein uninstall             Remove the Codex integration
  token-skein doctor                Check prerequisites for the Codex integration
  token-skein verify                Validate an existing install without mutating anything
  token-skein config                Print active config and its source path
  token-skein --version             Print version
`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(help());
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "proxy") {
    const config = await loadConfig();
    const server = await startProxy(config);
    console.log(`TokenSkein proxy listening on http://${server.hostname}:${server.port}`);
    console.log(`Upstream: ${config.upstream}`);
    const stop = () => server.stop(true);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command === "mcp") {
    await startMcpServer();
    return;
  }
  if (command === "hook" && subcommand === "codex") {
    const input = JSON.parse(await readStdin()) as CodexHookInput;
    const response = buildCodexHookResponse(input, await loadConfig());
    if (response) console.log(JSON.stringify(response));
    return;
  }
  if (command === "shell") {
    const args = [subcommand, ...rest].filter((value): value is string => value !== undefined);
    const encodedIndex = args.indexOf("--encoded");
    const encoded = encodedIndex >= 0 ? args[encodedIndex + 1] : undefined;
    if (!encoded) throw new Error("shell requires --encoded DATA");
    process.exitCode = await runFilteredShell(encoded, await loadConfig());
    return;
  }
  if (command === "stats") {
    const config = await loadConfig();
    const metrics = new MetricsRecorder(config.eventsPath);
    const usage = new UsageRecorder(config.economics.usagePath);
    const store = new ContextStore(config.storeDirectory);
    console.log(
      JSON.stringify(
        { metrics: await metrics.summary(), usage: await usage.summary(), store: await store.stats() },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "cleanup") {
    const config = await loadConfig();
    const removed = await new ContextStore(config.storeDirectory, config.archive.maxBytes).cleanup();
    console.log(JSON.stringify({ removed }));
    return;
  }
  if (command === "codex-snippet") {
    const snippets = codexIntegrationSnippets(await loadConfig());
    console.log("# Add to ~/.codex/config.toml\n");
    console.log(snippets.configToml);
    console.log("\n# Merge into ~/.codex/hooks.json\n");
    console.log(snippets.hooksJson);
    return;
  }
  if (command === "install") {
    const result = await install(await loadConfig());
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "uninstall") {
    const result = await uninstall();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "doctor") {
    const report = await doctor(await loadConfig());
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "verify") {
    const report = await verify(await loadConfig());
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "config") {
    console.log(JSON.stringify({ path: configPath(), config: await loadConfig() }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
