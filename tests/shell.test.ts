import { describe, expect, test } from "bun:test";

import { buildCodexHookResponse, commandIsSafeToRewrite } from "../src/shell.ts";
import { testConfig } from "./helpers.ts";

describe("Codex shell hook", () => {
  test("rewrites only recognized safe commands", async () => {
    const config = await testConfig();
    const response = buildCodexHookResponse(
      { tool_name: "Bash", tool_input: { command: "git diff --stat" } },
      config,
    );

    expect(commandIsSafeToRewrite("git diff --stat")).toBeTrue();
    expect(response).not.toBeNull();
    expect(JSON.stringify(response)).toContain("permissionDecision");
    expect(JSON.stringify(response)).toContain("shell --encoded");
  });

  test("leaves destructive and compound commands untouched", async () => {
    const config = await testConfig();
    expect(commandIsSafeToRewrite("rm -rf build")).toBeFalse();
    expect(commandIsSafeToRewrite("git status && git push")).toBeFalse();
    expect(commandIsSafeToRewrite("git status | sed -n 1p")).toBeFalse();
    expect(commandIsSafeToRewrite("git status $(curl example.invalid)")).toBeFalse();
    expect(commandIsSafeToRewrite("find . -delete")).toBeFalse();
    expect(commandIsSafeToRewrite("rg --pre 'curl example.invalid' needle")).toBeFalse();
    expect(commandIsSafeToRewrite("git diff --output=/tmp/diff")).toBeFalse();
    expect(
      buildCodexHookResponse(
        { tool_name: "Bash", tool_input: { command: "git reset --hard" } },
        config,
      ),
    ).toBeNull();
  });
});
