/**
 * End-to-end contract test over a real engine process.
 *
 * This exists because the PC-side tests mock McpConnection entirely, so they
 * stayed green while the engine exposed no snapshot_import / snapshot_export /
 * record_evidence at all. Only a real stdio process catches that class of drift,
 * so this test speaks JSON-RPC to `dist/index.js` the way the PC does.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ENGINE_ROOT = path.resolve(import.meta.dirname, '..');

class EngineProcess {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
  private stderr = '';

  constructor() {
    this.child = spawn(process.execPath, ['dist/index.js', '--stdio'], {
      cwd: ENGINE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout on ${method}; stderr=${this.stderr}`));
      }, 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async handshake(): Promise<void> {
    await this.handshakeInfo();
  }

  /** Handshake and return the server's advertised identity. */
  async handshakeInfo(): Promise<{ name: string; version: string }> {
    const msg = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kstar-contract-test', version: '1.0.0' },
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
    );
    return msg.result?.serverInfo ?? { name: '', version: '' };
  }

  async listToolNames(): Promise<string[]> {
    const msg = await this.request('tools/list', {});
    return (msg.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  }

  /** Call a tool and return its parsed JSON payload, mirroring parseToolResult on the PC. */
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const msg = await this.request('tools/call', { name, arguments: args });
    const text = msg.result?.content?.find((c: { type: string }) => c.type === 'text')?.text;
    if (text === undefined) {
      throw new Error(`no text content from ${name}: ${JSON.stringify(msg)}`);
    }
    return JSON.parse(text);
  }

  kill(): void {
    this.child.kill();
  }
}

let engines: EngineProcess[] = [];
function startEngine(): EngineProcess {
  const engine = new EngineProcess();
  engines.push(engine);
  return engine;
}

afterEach(() => {
  engines.forEach((engine) => engine.kill());
  engines = [];
});

describe('MCP process KSTAR snapshot contract', () => {
  it('reports one version across serverInfo, get_engine_info and package.json', async () => {
    // MCP clients read serverInfo.version. It drifted to 0.1.0 while the rest
    // of the engine said 1.0.0, so a future capability gate would have seen an
    // older engine than the one running.
    const fs = await import('node:fs');
    const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8'));

    const engine = startEngine();
    const serverInfo = await engine.handshakeInfo();
    const info = await engine.callTool('get_engine_info', {});

    expect(serverInfo.version).toBe(pkg.version);
    expect(info.engine_version).toBe(pkg.version);
    expect(info.version).toBe(pkg.version);
  });

  it('exposes every tool kstar-adapter.ts calls', async () => {
    const engine = startEngine();
    await engine.handshake();
    const names = await engine.listToolNames();

    // Keep this list in step with the callTool names in
    // src/main/features/p3394/kstar-adapter.ts.
    expect(names).toEqual(
      expect.arrayContaining([
        'get_engine_info',
        'snapshot_import',
        'snapshot_export',
        'record_evidence',
      ]),
    );
  });

  it('records evidence and returns a snapshot the caller can persist', async () => {
    const engine = startEngine();
    await engine.handshake();

    const result = await engine.callTool('record_evidence', {
      id: 'tool-c1-a1-t1-call1',
      type: 'tool_cycle',
      status: 'succeeded',
    });

    expect(result.success).toBe(true);
    expect(result.deduplicated).toBe(false);
    expect(result.snapshot.evidence).toHaveLength(1);
    expect(result.snapshot.evidence[0].id).toBe('tool-c1-a1-t1-call1');
  });

  it('carries history across an engine restart via export then import', async () => {
    const first = startEngine();
    await first.handshake();
    await first.callTool('record_evidence', { id: 'run-1', type: 'agent_run_result' });
    const exported = (await first.callTool('snapshot_export', {})).snapshot;
    first.kill();

    const second = startEngine();
    await second.handshake();
    const imported = await second.callTool('snapshot_import', { snapshot: exported });
    expect(imported.success).toBe(true);
    expect(imported.evidence_count).toBe(1);

    await second.callTool('record_evidence', { id: 'run-2', type: 'agent_run_result' });
    const after = (await second.callTool('snapshot_export', {})).snapshot;

    expect(after.evidence.map((e: { id: string }) => e.id)).toEqual(['run-1', 'run-2']);
  });

  it('deduplicates a replayed evidence id without growing the snapshot', async () => {
    const engine = startEngine();
    await engine.handshake();

    await engine.callTool('record_evidence', { id: 'tool-1', type: 'tool_cycle' });
    const replay = await engine.callTool('record_evidence', { id: 'tool-1', type: 'tool_cycle' });

    expect(replay.success).toBe(true);
    expect(replay.deduplicated).toBe(true);
    expect(replay.snapshot.evidence).toHaveLength(1);
  });

  it('reports a corrupted snapshot as a failed import instead of accepting it', async () => {
    const source = startEngine();
    await source.handshake();
    await source.callTool('record_evidence', { id: 'tool-1', type: 'tool_cycle' });
    const good = (await source.callTool('snapshot_export', {})).snapshot;

    const tampered = { ...good, evidence: [{ ...good.evidence[0], status: 'tampered' }] };

    const target = startEngine();
    await target.handshake();
    const result = await target.callTool('snapshot_import', { snapshot: tampered });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/snapshot_hash mismatch/);

    // A rejected import must not leave partial state behind.
    const exported = (await target.callTool('snapshot_export', {})).snapshot;
    expect(exported.evidence).toHaveLength(0);
  });

  it('starts from empty state when asked to import nothing', async () => {
    const engine = startEngine();
    await engine.handshake();
    await engine.callTool('record_evidence', { id: 'tool-1', type: 'tool_cycle' });

    const reset = await engine.callTool('snapshot_import', {});
    expect(reset.success).toBe(true);
    expect(reset.evidence_count).toBe(0);
  });

  it('rejects evidence with no id', async () => {
    const engine = startEngine();
    await engine.handshake();

    const result = await engine.callTool('record_evidence', { type: 'tool_cycle' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/id is required/);
  });
});
