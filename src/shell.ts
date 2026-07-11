import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { compactRecoverably } from "./compact/text.ts";
import { MetricsRecorder } from "./metrics.ts";
import { ContextStore } from "./store.ts";
import { byteLength, countTextTokens } from "./tokenizer.ts";
import type { TokenSkeinConfig, JsonObject } from "./types.ts";

const UNSAFE_COMMAND = /(?:^|\s)(?:rm|mv|cp|chmod|chown|sudo|dd|mkfs|kill|pkill|git\s+(?:push|reset|clean|checkout|switch|commit|merge|rebase)|docker\s+(?:rm|rmi|stop|kill)|kubectl\s+(?:delete|apply)|terraform\s+apply)(?:\s|$)/i;
const SHELL_CONTROL = /[\n\r;&|><`]|\$\(/;
const SAFE_COMMAND = /^\s*(?:git\s+(?:status|diff|log|show|rev-parse)\b|rg\b|grep\b|find\b|ls\b|tree\b|wc\b|cat\b|head\b|tail\b)/i;
const UNSAFE_READ_OPTIONS = /(?:^|\s)(?:--pre(?:=|\s|$)|--ext-diff\b|--textconv\b|--output(?:=|\s)|-o(?:\s|$)|-(?:exec|execdir|ok|okdir|delete|fls|fprint|fprintf)\b)/i;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ownInvocation(): string {
  if (process.env.TOKEN_SKEIN_BIN) return process.env.TOKEN_SKEIN_BIN;
  const script = resolve(process.argv[1] ?? "src/cli.ts");
  return `${shellQuote(process.execPath)} ${shellQuote(script)}`;
}

export function commandIsSafeToRewrite(command: string): boolean {
  if (!command || SHELL_CONTROL.test(command)) return false;
  if (UNSAFE_COMMAND.test(command)) return false;
  if (UNSAFE_READ_OPTIONS.test(command)) return false;
  if (/token-skein|src\/cli\.ts\s+shell/.test(command)) return false;
  return SAFE_COMMAND.test(command);
}

export function rewriteWithRtk(command: string): string | null {
  const result = Bun.spawnSync(["rtk", "rewrite", command], {
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  if (result.exitCode !== 0) return null;
  const rewritten = result.stdout.toString("utf8").trim();
  return rewritten.startsWith("rtk ") && !SHELL_CONTROL.test(rewritten) ? rewritten : null;
}

export interface CodexHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export function buildCodexHookResponse(
  input: CodexHookInput,
  config: TokenSkeinConfig,
): JsonObject | null {
  if (!config.shell.enabled || input.tool_name !== "Bash" || !input.tool_input) return null;
  const rawCommand = input.tool_input.command ?? input.tool_input.cmd;
  if (typeof rawCommand !== "string" || !commandIsSafeToRewrite(rawCommand)) return null;
  const rewritten = config.shell.preferRtk ? rewriteWithRtk(rawCommand) ?? rawCommand : rawCommand;
  const encoded = Buffer.from(rewritten, "utf8").toString("base64url");
  const command = `${ownInvocation()} shell --encoded ${encoded}`;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "TokenSkein safe output-filter rewrite",
      updatedInput: { ...input.tool_input, command },
    },
  };
}

export async function runFilteredShell(encoded: string, config: TokenSkeinConfig): Promise<number> {
  let command: string;
  try {
    command = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid encoded shell command.");
  }
  const child = Bun.spawn(["/usr/bin/env", "zsh", "-lc", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const combined = [stdout ? `[stdout]\n${stdout}` : "", stderr ? `[stderr]\n${stderr}` : ""]
    .filter(Boolean)
    .join("\n");
  if (byteLength(combined) < config.shell.minimumBytes) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return exitCode;
  }

  const store = new ContextStore(config.storeDirectory);
  const metrics = new MetricsRecorder(config.eventsPath);
  const compacted = await compactRecoverably(combined, store, {
    kind: "shell_output",
    maximumLines: exitCode === 0 ? config.shell.maximumLines : config.shell.maximumLines * 2,
    ttlSeconds: config.compression.ttlSeconds,
    metadata: {
      commandHash: createHash("sha256").update(command).digest("hex").slice(0, 16),
      exitCode,
      rtk: command.trimStart().startsWith("rtk "),
    },
  });
  const before = countTextTokens(combined);
  const after = countTextTokens(compacted.text);
  await metrics.record({
    timestamp: new Date().toISOString(),
    kind: "shell",
    source: "shell",
    originalBytes: compacted.originalBytes,
    optimizedBytes: compacted.compactedBytes,
    estimatedTokensBefore: before,
    estimatedTokensAfter: after,
    ...(compacted.reference ? { reference: compacted.reference } : {}),
    metadata: { exitCode, rtk: command.trimStart().startsWith("rtk ") },
  });
  process.stdout.write(`${compacted.text}\n`);
  return exitCode;
}
