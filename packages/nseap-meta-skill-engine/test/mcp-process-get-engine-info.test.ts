import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function callGetEngineInfo(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const root = path.resolve(import.meta.dirname, '..');
    const child = spawn(process.execPath, ['dist/index.js', '--stdio'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting for get_engine_info; stdout=${stdout}; stderr=${stderr}`));
    }, 5_000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'engine-smoke', version: '1.0.0' },
      },
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_engine_info', arguments: {} },
    }) + '\n');

    setTimeout(() => {
      clearTimeout(timer);
      child.kill();
      try {
        const lines = stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
        const response = lines.find((line) => line.id === 2);
        if (!response || response.error || response.result?.isError) {
          reject(new Error(`get_engine_info failed; stdout=${stdout}; stderr=${stderr}`));
          return;
        }
        resolve(JSON.parse(response.result.content[0].text));
      } catch (err) {
        reject(err);
      }
    }, 600);
  });
}

describe('MCP process get_engine_info', () => {
  it('serves engine info over the packaged stdio entrypoint', async () => {
    const info = await callGetEngineInfo();

    expect(info.engine_name).toBe('nseap-meta-skill-engine');
    expect(info.engine_version).toBe('1.0.0');
    expect(info.protocol_version).toBe('1.0');
    expect(info.capabilities).toEqual(expect.arrayContaining(['snapshot_migration', 'legacy_import']));
  });
});
