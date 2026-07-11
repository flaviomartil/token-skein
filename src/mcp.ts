import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { compactRecoverably } from "./compact/text.ts";
import { loadConfig } from "./config.ts";
import { MetricsRecorder } from "./metrics.ts";
import { ContextStore } from "./store.ts";
import { countTextTokens } from "./tokenizer.ts";

export async function startMcpServer(): Promise<void> {
  const config = await loadConfig();
  const store = new ContextStore(config.storeDirectory, config.archive.maxBytes);
  const metrics = new MetricsRecorder(config.eventsPath);
  const server = new McpServer({ name: "token-skein", version: "0.1.0" });

  server.registerTool(
    "skein_compress",
    {
      title: "Compress context recoverably",
      description:
        "Compress large text, logs, JSON, or tool output. The original remains in a local content-addressed store and can be recovered with skein_retrieve.",
      inputSchema: {
        content: z.string().min(1),
        kind: z.string().default("manual"),
        ttlSeconds: z.number().int().positive().optional(),
      },
      outputSchema: {
        reference: z.string(),
        compacted: z.string(),
        tokensBefore: z.number(),
        tokensAfter: z.number(),
        tokensSaved: z.number(),
      },
    },
    async ({ content, kind, ttlSeconds }) => {
      const result = await compactRecoverably(content, store, {
        kind,
        maximumLines: config.compression.maximumSummaryLines,
        ttlSeconds: ttlSeconds ?? config.compression.ttlSeconds,
      });
      const tokensBefore = countTextTokens(content);
      const tokensAfter = countTextTokens(result.text);
      const structuredContent = {
        reference: result.reference ?? "",
        compacted: result.text,
        tokensBefore,
        tokensAfter,
        tokensSaved: Math.max(0, tokensBefore - tokensAfter),
      };
      await metrics.record({
        timestamp: new Date().toISOString(),
        kind: "recoverable-text",
        source: "mcp",
        originalBytes: result.originalBytes,
        optimizedBytes: result.compactedBytes,
        estimatedTokensBefore: tokensBefore,
        estimatedTokensAfter: tokensAfter,
        ...(result.reference ? { reference: result.reference } : {}),
        metadata: { strategy: result.strategy },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "skein_retrieve",
    {
      title: "Retrieve archived context",
      description:
        "Retrieve exact original content from a TokenSkein reference. Add query to return only matching lines with surrounding context.",
      inputSchema: {
        reference: z.string().regex(/^(?:skein:)?[a-f0-9]{24}$/i),
        query: z.string().min(1).optional(),
        maxChars: z.number().int().positive().max(500_000).default(80_000),
      },
      outputSchema: {
        reference: z.string(),
        found: z.boolean(),
        content: z.string(),
      },
    },
    async ({ reference, query, maxChars }) => {
      const content = await store.retrieve(reference, query, maxChars);
      const structuredContent = { reference, found: content !== null, content: content ?? "" };
      return {
        content: [
          {
            type: "text",
            text: content ?? `Context ${reference} was not found or has expired.`,
          },
        ],
        structuredContent,
        ...(content === null ? { isError: true } : {}),
      };
    },
  );

  server.registerTool(
    "skein_stats",
    {
      title: "Show context savings",
      description: "Show aggregate estimated token savings and local archive statistics.",
      inputSchema: {},
      outputSchema: {
        metrics: z.record(z.unknown()),
        store: z.record(z.unknown()),
      },
    },
    async () => {
      const structuredContent = {
        metrics: await metrics.summary(),
        store: await store.stats(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TokenSkein MCP server running on stdio");
}
