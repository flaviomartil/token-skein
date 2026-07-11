import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { codexIntegrationSnippets } from "./codex.ts";
import { CURRENT_CONFIG_SCHEMA_VERSION } from "./config.ts";
import type { TokenSkeinConfig } from "./types.ts";

export function resolveCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export interface InstallPaths {
  codexHome: string;
  configToml: string;
  hooksJson: string;
}

export function resolveInstallPaths(codexHome = resolveCodexHome()): InstallPaths {
  return {
    codexHome,
    configToml: join(codexHome, "config.toml"),
    hooksJson: join(codexHome, "hooks.json"),
  };
}

export type ShellToolShape = "bash" | "unsupported";

export type ShellToolProbe = () => Promise<string | null>;

async function defaultShellToolProbe(): Promise<string | null> {
  if (process.env.TOKEN_SKEIN_CODEX_SHELL_TOOL) return process.env.TOKEN_SKEIN_CODEX_SHELL_TOOL;
  const result = Bun.spawnSync(["codex", "--version"], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? "Bash" : null;
}

export async function detectShellToolShape(probe: ShellToolProbe = defaultShellToolProbe): Promise<ShellToolShape> {
  const toolName = await probe();
  return toolName === "Bash" ? "bash" : "unsupported";
}

const TOML_MARKER_START = "# >>> token-skein managed block >>>";
const TOML_MARKER_END = "# <<< token-skein managed block <<<";
const HOOK_SIGNATURE = "hook codex";

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher: string;
  hooks: HookCommand[];
}

interface HooksFile {
  hooks?: {
    PreToolUse?: HookEntry[];
  };
}

function isOwnHookEntry(entry: HookEntry): boolean {
  return entry.hooks.some((hook) => hook.command.includes(HOOK_SIGNATURE));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

function stripManagedBlock(content: string): string {
  const startIndex = content.indexOf(TOML_MARKER_START);
  if (startIndex === -1) return content;
  const endIndex = content.indexOf(TOML_MARKER_END, startIndex);
  if (endIndex === -1) return content;
  return content.slice(0, startIndex) + content.slice(endIndex + TOML_MARKER_END.length);
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return "";
    throw error;
  }
}

async function writeManagedTomlBlock(path: string, snippet: string): Promise<void> {
  const existing = await readFileOrEmpty(path);
  const stripped = stripManagedBlock(existing).replace(/\s+$/, "");
  const block = `${TOML_MARKER_START}\n${snippet}\n${TOML_MARKER_END}`;
  const next = stripped.length > 0 ? `${stripped}\n\n${block}\n` : `${block}\n`;
  await atomicWrite(path, next);
}

async function readHooksFile(path: string): Promise<HooksFile> {
  const raw = await readFileOrEmpty(path);
  if (!raw.trim()) return {};
  return JSON.parse(raw) as HooksFile;
}

async function writeManagedHooksJson(path: string, snippetJson: string): Promise<void> {
  const snippet = JSON.parse(snippetJson) as HooksFile;
  const existing = await readHooksFile(path);
  const preToolUse = (existing.hooks?.PreToolUse ?? []).filter((entry) => !isOwnHookEntry(entry));
  preToolUse.push(...(snippet.hooks?.PreToolUse ?? []));
  const next: HooksFile = { ...existing, hooks: { ...existing.hooks, PreToolUse: preToolUse } };
  await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
}

interface FileBackup {
  path: string;
  existed: boolean;
  content: string | null;
}

async function backupFile(path: string): Promise<FileBackup> {
  try {
    return { path, existed: true, content: await readFile(path, "utf8") };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { path, existed: false, content: null };
    throw error;
  }
}

async function restoreBackups(backups: FileBackup[]): Promise<void> {
  for (const backup of [...backups].reverse()) {
    if (backup.existed && backup.content !== null) {
      await writeFile(backup.path, backup.content, "utf8");
    } else {
      await unlink(backup.path).catch(() => {});
    }
  }
}

export interface InstallOptions {
  codexHome?: string;
  probe?: ShellToolProbe;
}

export interface InstallResult {
  codexHome: string;
  installedConfigToml: boolean;
  installedHooksJson: boolean;
  shellToolShape: ShellToolShape;
  skippedHook: boolean;
  message?: string;
}

export async function install(config: TokenSkeinConfig, options: InstallOptions = {}): Promise<InstallResult> {
  const paths = resolveInstallPaths(options.codexHome);
  const snippets = codexIntegrationSnippets(config);
  const shape = await detectShellToolShape(options.probe);
  const backups: FileBackup[] = [];

  try {
    await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });

    backups.push(await backupFile(paths.configToml));
    await writeManagedTomlBlock(paths.configToml, snippets.configToml);

    let installedHooksJson = false;
    const skippedHook = shape !== "bash";
    if (!skippedHook) {
      backups.push(await backupFile(paths.hooksJson));
      await writeManagedHooksJson(paths.hooksJson, snippets.hooksJson);
      installedHooksJson = true;
    }

    return {
      codexHome: paths.codexHome,
      installedConfigToml: true,
      installedHooksJson,
      shellToolShape: shape,
      skippedHook,
      ...(skippedHook
        ? {
            message:
              'Codex shell tool shape does not match the supported "Bash" hook shape; skipped hooks.json install. config.toml and the MCP server registration were installed.',
          }
        : {}),
    };
  } catch (error) {
    await restoreBackups(backups);
    throw error;
  }
}

export interface UninstallResult {
  codexHome: string;
  removedConfigToml: boolean;
  removedHooksJson: boolean;
}

export async function uninstall(options: { codexHome?: string } = {}): Promise<UninstallResult> {
  const paths = resolveInstallPaths(options.codexHome);
  let removedConfigToml = false;
  let removedHooksJson = false;

  const existingToml = await readFileOrEmpty(paths.configToml);
  if (existingToml.includes(TOML_MARKER_START)) {
    const stripped = stripManagedBlock(existingToml).replace(/\n{3,}/g, "\n\n");
    await atomicWrite(paths.configToml, stripped);
    removedConfigToml = true;
  }

  if (await pathExists(paths.hooksJson)) {
    const existing = await readHooksFile(paths.hooksJson);
    const original = existing.hooks?.PreToolUse ?? [];
    const preToolUse = original.filter((entry) => !isOwnHookEntry(entry));
    if (preToolUse.length !== original.length) {
      const next: HooksFile = { ...existing, hooks: { ...existing.hooks, PreToolUse: preToolUse } };
      await atomicWrite(paths.hooksJson, `${JSON.stringify(next, null, 2)}\n`);
      removedHooksJson = true;
    }
  }

  return { codexHome: paths.codexHome, removedConfigToml, removedHooksJson };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Report {
  ok: boolean;
  checks: CheckResult[];
}

type ProxyStatus = "up" | "not-running" | "unhealthy";

async function proxyStatus(config: TokenSkeinConfig): Promise<ProxyStatus> {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return "unhealthy";
    const body = (await response.json()) as { status?: string };
    return body.status === "ok" ? "up" : "unhealthy";
  } catch {
    return "not-running";
  }
}

export async function doctor(config: TokenSkeinConfig, options: { codexHome?: string } = {}): Promise<Report> {
  const paths = resolveInstallPaths(options.codexHome);
  const checks: CheckResult[] = [];

  checks.push({ name: "bun", ok: typeof Bun !== "undefined", detail: typeof Bun !== "undefined" ? Bun.version : "Bun runtime not detected" });

  const codexHomeOk = await pathExists(paths.codexHome);
  checks.push({
    name: "codex-home",
    ok: codexHomeOk,
    detail: codexHomeOk ? paths.codexHome : `${paths.codexHome} does not exist`,
  });

  checks.push({
    name: "config-schema",
    ok: config.schemaVersion === CURRENT_CONFIG_SCHEMA_VERSION,
    detail: `schema_version ${config.schemaVersion}`,
  });

  const status = await proxyStatus(config);
  checks.push({
    name: "proxy",
    ok: status !== "unhealthy",
    detail:
      status === "up"
        ? `reachable at http://${config.host}:${config.port}`
        : status === "not-running"
          ? "not running"
          : "running but unhealthy",
  });

  return { ok: checks.every((check) => check.ok), checks };
}

export async function verify(config: TokenSkeinConfig, options: InstallOptions = {}): Promise<Report> {
  const paths = resolveInstallPaths(options.codexHome);
  const checks: CheckResult[] = [];

  const tomlContent = await readFileOrEmpty(paths.configToml);
  const hasProvider =
    tomlContent.includes("[model_providers.token_skein]") &&
    tomlContent.includes(`http://${config.host}:${config.port}/v1`);
  checks.push({
    name: "config-toml",
    ok: hasProvider,
    detail: hasProvider ? paths.configToml : "token_skein provider block not found",
  });

  const hasMcp = tomlContent.includes("[mcp_servers.token_skein]");
  checks.push({ name: "mcp-server", ok: hasMcp, detail: hasMcp ? "registered" : "mcp_servers.token_skein not found" });

  const shape = await detectShellToolShape(options.probe);
  const hooksFile = await readHooksFile(paths.hooksJson).catch(() => ({}) as HooksFile);
  const hasHook = (hooksFile.hooks?.PreToolUse ?? []).some(isOwnHookEntry);
  if (shape === "bash") {
    checks.push({ name: "hook", ok: hasHook, detail: hasHook ? "installed" : "expected hook not found" });
  } else {
    checks.push({ name: "hook", ok: true, detail: "skipped: unsupported shell tool shape" });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
