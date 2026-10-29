#!/usr/bin/env node
'use strict';
// Electron-as-Node starts the unpacked entrypoint. Resolve npm packages from
// app.asar's dependency tree; relative adapter helpers remain next to this file.
const runtimeRequire = __filename.includes('app.asar.unpacked')
  ? require('node:module').createRequire(__filename.replace(/\bapp\.asar\.unpacked\b/, 'app.asar'))
  : require;
// Only launched by connectors/mcp-client.ts. Stdout is reserved for MCP JSON-RPC.
const { Server } = runtimeRequire('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = runtimeRequire('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = runtimeRequire('@modelcontextprotocol/sdk/types.js');
const { config, createMailbox, TOOLS, safeError } = require('./email-mcp-core.cjs');
async function main() {
  const cfg = config(process.env.EMAIL_PROVIDER, process.env.EMAIL_ADDRESS, process.env.EMAIL_PASSWORD, {
    host: process.env.EMAIL_IMAP_HOST, port: Number(process.env.EMAIL_IMAP_PORT),
    security: process.env.EMAIL_IMAP_SECURITY, username: process.env.EMAIL_USERNAME,
  });
  delete process.env.EMAIL_PASSWORD;
  const mailbox = createMailbox(cfg);
  const server = new Server({ name: 'readonly-email', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Discovery succeeds only after login AND read-only INBOX access, including refresh.
    await mailbox.verify();
    return { tools: TOOLS };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await mailbox.call(request.params.name, request.params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: safeError(err) }] }; }
  });
  await server.connect(new StdioServerTransport());
}
main().catch(() => { process.exitCode = 1; });
