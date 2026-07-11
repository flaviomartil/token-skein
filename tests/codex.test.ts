import { describe, expect, test } from "bun:test";

import { codexIntegrationSnippets } from "../src/codex.ts";
import { testConfig } from "./helpers.ts";

describe("Codex integration snippets", () => {
  test("selects the local Responses provider and wires MCP and the optional hook", async () => {
    const config = await testConfig();
    const snippets = codexIntegrationSnippets(config);

    expect(snippets.configToml).toContain('model_provider = "token_skein"');
    expect(snippets.configToml).toContain('[model_providers.token_skein]');
    expect(snippets.configToml).toContain('wire_api = "responses"');
    expect(snippets.configToml).toContain('[mcp_servers.token_skein]');
    expect(snippets.hooksJson).toContain('"PreToolUse"');
    expect(snippets.hooksJson).toContain("hook codex");
  });
});

