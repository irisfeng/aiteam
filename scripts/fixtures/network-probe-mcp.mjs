#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const counterFile = process.env.AITEAM_NETWORK_PROBE_FILE;
if (!counterFile) throw new Error("AITEAM_NETWORK_PROBE_FILE is required");

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

await server.connect(new StdioServerTransport());
