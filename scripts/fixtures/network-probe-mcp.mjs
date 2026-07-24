#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const counterFile = process.env.AITEAM_NETWORK_PROBE_FILE;
if (!counterFile) throw new Error("AITEAM_NETWORK_PROBE_FILE is required");
const connectFile = process.env.AITEAM_NETWORK_PROBE_CONNECT_FILE;
const connectDelayMs = Math.max(0, Number(process.env.AITEAM_NETWORK_PROBE_CONNECT_DELAY_MS ?? 0));

const server = new McpServer({
  name: "aiteam-network-approval-probe",
  version: "1.0.0",
});

server.registerTool(
  "search",
  {
    description: "Records one deterministic network-approval regression call.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (input) => {
    appendFileSync(counterFile, `${JSON.stringify(input)}\n`, "utf8");
    return {
      content: [
        {
          type: "text",
          text: `network probe result for ${input.query}`,
        },
      ],
    };
  },
);

if (connectFile) appendFileSync(connectFile, `${Date.now()}\n`, "utf8");
if (connectDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
}
await server.connect(new StdioServerTransport());
