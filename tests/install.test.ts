import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { doctor, install, resolveInstallPaths, uninstall, verify } from "../src/install.ts";
import { testConfig } from "./helpers.ts";

async function tempCodexHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "token-skein-codex-home-"));
}

describe("install", () => {
  test("installs config.toml and hooks.json when the shell tool shape is compatible", async () => {
    const config = await testConfig();
    const codexHome = await tempCodexHome();
    const result = await install(config, { codexHome, probe: async () => "Bash" });

    expect(result.installedConfigToml).toBe(true);
    expect(result.installedHooksJson).toBe(true);
    expect(result.skippedHook).toBe(false);

    const paths = resolveInstallPaths(codexHome);
    const tomlContent = await readFile(paths.configToml, "utf8");
    expect(tomlContent).toContain("[model_providers.token_skein]");
    const hooksContent = JSON.parse(await readFile(paths.hooksJson, "utf8"));
    expect(hooksContent.hooks.PreToolUse.some((entry: { hooks: { command: string }[] }) =>
      entry.hooks.some((hook) => hook.command.includes("hook codex")),
    )).toBe(true);
  });

  test("skips the hook and leaves a clear message when the shell tool shape is incompatible", async () => {
    const config = await testConfig();
    const codexHome = await tempCodexHome();
    const result = await install(config, { codexHome, probe: async () => "shell" });

    expect(result.installedConfigToml).toBe(true);
    expect(result.installedHooksJson).toBe(false);
    expect(result.skippedHook).toBe(true);
    expect(result.message).toBeTruthy();

    const paths = resolveInstallPaths(codexHome);
    const tomlContent = await readFile(paths.configToml, "utf8");
    expect(tomlContent).toContain("[model_providers.token_skein]");
    await expect(readFile(paths.hooksJson, "utf8")).rejects.toThrow();
  });

  test("rolls back all changes when a later step fails", async () => {
    const config = await testConfig();
    const codexHome = await tempCodexHome();
    const paths = resolveInstallPaths(codexHome);
    await mkdir(paths.hooksJson, { recursive: true });

    await expect(install(config, { codexHome, probe: async () => "Bash" })).rejects.toThrow();

    await expect(readFile(paths.configToml, "utf8")).rejects.toThrow();
  });

  test("preserves unrelated hooks.json and config.toml content", async () => {
    const config = await testConfig();
    const codexHome = await tempCodexHome();
    const paths = resolveInstallPaths(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(paths.configToml, 'model_provider = "openai"\n', "utf8");
    await writeFile(
      paths.hooksJson,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Other", hooks: [{ type: "command", command: "echo hi" }] }] } }),
      "utf8",
    );

    await install(config, { codexHome, probe: async () => "Bash" });

    const tomlContent = await readFile(paths.configToml, "utf8");
    expect(tomlContent).toContain('model_provider = "openai"');
    expect(tomlContent).toContain("[model_providers.token_skein]");
    const hooksContent = JSON.parse(await readFile(paths.hooksJson, "utf8"));
    expect(hooksContent.hooks.PreToolUse).toHaveLength(2);
  });
});

describe("uninstall", () => {
  test("restores prior state by removing only the managed block and hook", async () => {
    const config = await testConfig();
    const codexHome = await tempCodexHome();
    await install(config, { codexHome, probe: async () => "Bash" });

    const result = await uninstall({ codexHome });
    expect(result.removedConfigToml).toBe(true);
    expect(result.removedHooksJson).toBe(true);

    const paths = resolveInstallPaths(codexHome);
    const tomlContent = await readFile(paths.configToml, "utf8");
    expect(tomlContent).not.toContain("[model_providers.token_skein]");
    const hooksContent = JSON.parse(await readFile(paths.hooksJson, "utf8"));
    expect(hooksContent.hooks.PreToolUse).toHaveLength(0);
  });
});

describe("doctor", () => {
  test("reports bun, codex home, and config schema checks", async () => {
    const config = await testConfig();
    const codexHome = await tempCodexHome();
    const report = await doctor(config, { codexHome });

    expect(report.checks.map((check) => check.name)).toEqual(["bun", "codex-home", "config-schema", "proxy"]);
    expect(report.checks.find((check) => check.name === "bun")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "proxy")?.ok).toBe(true);
  });
});

describe("verify", () => {
  test("passes end to end after a successful install without mutating anything", async () => {
    const config = await testConfig();
    const codexHome = await tempCodexHome();
    await install(config, { codexHome, probe: async () => "Bash" });

    const before = await readFile(resolveInstallPaths(codexHome).configToml, "utf8");
    const report = await verify(config, { codexHome, probe: async () => "Bash" });
    const after = await readFile(resolveInstallPaths(codexHome).configToml, "utf8");

    expect(report.ok).toBe(true);
    expect(after).toBe(before);
  });

  test("fails when the install is missing", async () => {
    const config = await testConfig();
    const codexHome = await tempCodexHome();
    const report = await verify(config, { codexHome, probe: async () => "Bash" });
    expect(report.ok).toBe(false);
  });
});
