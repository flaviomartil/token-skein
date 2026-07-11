import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { TokenSkeinConfig } from "./types.ts";

export interface CodexIntegrationSnippets {
  configToml: string;
  hooksJson: string;
}

export function codexIntegrationSnippets(config: TokenSkeinConfig): CodexIntegrationSnippets {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolve(projectRoot, "src", "cli.ts");
  const baseUrl = `http://${config.host}:${config.port}/v1`;
  const configToml = [
    '# Select this provider globally or inside a Codex profile:',
    'model_provider = "token_skein"',
    "",
    "[model_providers.token_skein]",
    'name = "TokenSkein local proxy"',
    `base_url = "${baseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
    "[mcp_servers.token_skein]",
    'command = "bun"',
    `args = [${JSON.stringify(cli)}, "mcp"]`,
  ].join("\n");
  const hooksJson = JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `bun ${JSON.stringify(cli)} hook codex`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
  return { configToml, hooksJson };
}
