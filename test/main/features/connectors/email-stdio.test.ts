import { it, expect } from 'vitest';
import * as path from 'node:path';
import { McpConnection } from '../../../../src/main/features/connectors/mcp-client';

it('speaks real MCP stdio without stdout pollution or exposing credential/write tools', async () => {
  const conn = new McpConnection('email-protocol-test', { kind: 'stdio', command: process.execPath,
    args: [path.resolve('bin/email-mcp-server.cjs')], env: { ELECTRON_RUN_AS_NODE: '1',
      EMAIL_PROVIDER: 'email-qq', EMAIL_ADDRESS: 'protocol-test@qq.com', EMAIL_PASSWORD: 'never-sent-to-a-provider' } });
  try {
    await conn.connect();
    // A disallowed tool fails BEFORE any network operation; no real authentication is attempted.
    const response = await conn.callTool('configure_account', { password: 'model-must-not-configure' }) as any;
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe('email_unknown_tool');
    expect(JSON.stringify(response)).not.toContain('never-sent');
  } finally { await conn.close(); }
});
