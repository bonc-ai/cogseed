import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { P3394McpRuntimeAdapter } from '../../../../src/main/features/p3394_bridge/mcp-runtime-adapter';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

// 内联 fake MCP runtime server（stdio JSON-RPC），实现 p3394.runtime.* 工具。
const FAKE_SERVER = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const sessions = new Map();
function reply(line, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: line.id, result }) + '\\n'); }
rl.on('line', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.method === 'initialize') return reply(msg, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
  if (msg.method === 'tools/call') {
    const tool = msg.params.name;
    const args = msg.params.arguments || {};
    if (tool === 'p3394.runtime.open_session') {
      sessions.set(args.session_id, 'native-' + args.session_id);
      return reply(msg, { content: [{ type: 'text', text: JSON.stringify({ native_session_id: 'native-' + args.session_id }) }] });
    }
    if (tool === 'p3394.runtime.deliver') {
      return reply(msg, { content: [{ type: 'text', text: JSON.stringify({ task_id: 'mcp-task-1' }) }] });
    }
    if (tool === 'p3394.runtime.task_result') {
      return reply(msg, { content: [{ type: 'text', text: JSON.stringify({ state: 'completed', text: 'runtime answer' }) }] });
    }
    if (tool === 'p3394.runtime.cancel') return reply(msg, { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
    if (tool === 'p3394.runtime.resume') return reply(msg, { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
    if (tool === 'p3394.runtime.snapshot') return reply(msg, { content: [{ type: 'text', text: JSON.stringify({ native_session_id: sessions.get(args.session_id) || '?' }) }] });
    if (tool === 'p3394.runtime.close_session') return reply(msg, { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
  }
});
`;

function envelope(): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-mcp-1',
    session_id: 'ses-mcp-1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'cogseed' },
    recipients: [{ agent_id: 'mcp-agent' }],
    payload: { parts: [{ type: 'text', text: 'hi' }] },
    idempotency_key: 'idem-mcp-1',
  };
}

describe('P3394 SA-MCP agent runtime adapter (SDK §10.1)', () => {
  it('binds a stdio MCP runtime as a full RuntimeAdapter', async () => {
    const adapter = new P3394McpRuntimeAdapter({ command: process.execPath, args: ['-e', FAKE_SERVER] });
    try {
      const binding = await adapter.openSession({ session_id: 'ses-mcp-1', agent_id: 'mcp-agent' });
      expect(binding.native_session_id).toBe('native-ses-mcp-1');

      const delivered = await adapter.deliver(envelope());
      expect(delivered.task_id).toBe('mcp-task-1');

      const events = [];
      for await (const event of adapter.stream('mcp-task-1')) events.push(event);
      expect(events.map((e) => e.kind)).toEqual(['started', 'delta', 'completed']);
      expect(events[1].data?.text).toBe('runtime answer');

      await adapter.resume('ses-mcp-1');
      const snapshot = await adapter.snapshot('ses-mcp-1');
      expect(snapshot.native_session_id).toBe('native-ses-mcp-1');
      await adapter.cancel('mcp-task-1');
      await adapter.closeSession('ses-mcp-1');
    } finally {
      await adapter.close();
    }
  });

  it.runIf(process.platform === 'win32')('runs a real .cmd through ComSpec and closes its descendant tree before resolving', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-mcp-runtime-'));
    const fixtureDir = path.join(root, 'hostile & runtime (测试)');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const serverPath = path.join(fixtureDir, 'server.js');
    const launcherPath = path.join(fixtureDir, 'runtime.cmd');
    const pidPath = path.join(fixtureDir, 'pids.txt');
    const markerPath = path.join(fixtureDir, 'cmd-ran.txt');
    fs.writeFileSync(serverPath, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
fs.writeFileSync(process.env.COGSEED_MCP_PID_FILE, process.pid + '\\n' + descendant.pid + '\\n');
const rl = readline.createInterface({ input: process.stdin });
function reply(message, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
}
rl.on('line', (raw) => {
  const message = JSON.parse(raw);
  if (message.method === 'initialize') {
    reply(message, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'cmd-fixture', version: '1' } });
    return;
  }
  reply(message, { content: [{ type: 'text', text: JSON.stringify({ native_session_id: 'cmd-session' }) }] });
});
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(
      launcherPath,
      '@echo off\r\n> "%COGSEED_MCP_CMD_MARKER%" echo cmd-fallback\r\n"%COGSEED_MCP_TEST_NODE%" "%COGSEED_MCP_TEST_SERVER%" %*\r\n',
    );
    const adapter = new P3394McpRuntimeAdapter({
      command: launcherPath,
      env: {
        COGSEED_MCP_TEST_NODE: process.execPath,
        COGSEED_MCP_TEST_SERVER: serverPath,
        COGSEED_MCP_PID_FILE: pidPath,
        COGSEED_MCP_CMD_MARKER: markerPath,
      },
    });

    try {
      const binding = await adapter.openSession({ session_id: 'cmd', agent_id: 'agent' });
      expect(binding.native_session_id).toBe('cmd-session');
      expect(fs.readFileSync(markerPath, 'utf8')).toContain('cmd-fallback');
      const pids = fs.readFileSync(pidPath, 'utf8').trim().split(/\r?\n/).map(Number);
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      })).toBe(true);

      await adapter.close();

      expect(pids.filter((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      })).toEqual([]);
    } finally {
      await adapter.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15_000);
});
