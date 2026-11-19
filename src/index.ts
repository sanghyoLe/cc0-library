#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol; log only to stderr.
console.error("cc0-library MCP server running on stdio");
