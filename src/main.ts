#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, createApiCall } from "./server.js";

try {
  await buildServer(createApiCall()).connect(new StdioServerTransport());
} catch {
  // Configuration/transport errors must not dump environment values or stacks.
  process.stderr.write('Ukiyo MCP could not start. Check API origin and local configuration.\n');
  process.exitCode = 1;
}
