import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateCreatorPresetManifest } from '../../src/main/features/creator/schema';

const root = path.resolve(import.meta.dirname, '../..');
const creatorDir = path.join(root, 'src/main/features/creator');
const ipcDir = path.join(root, 'src/main/ipc');
const creatorIndex = path.join(creatorDir, 'index.ts');
const creatorRenderer = path.join(root, 'src/renderer/modules/creator-mode.js');
const p3394Service = path.join(root, 'src/main/features/p3394_bridge/external-gateways.ts');
const creatorIpc = path.join(root, 'src/main/ipc/creator.ts');

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(dir);
  return files;
}

describe('Creator/P3394 security boundary', () => {
  it('removes the standalone Creator renderer entry point', () => {
    expect(fs.existsSync(creatorRenderer)).toBe(false);
  });

  it('keeps Creator core exports independent from optional external-agent delegation', () => {
    const content = fs.readFileSync(creatorIndex, 'utf8');
    expect(content).not.toMatch(/remote-execution-service/);
  });

  it('keeps the entire Creator feature independent from P3394 peers and remote delegation', () => {
    const content = sourceFiles(creatorDir).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(content).not.toMatch(/p3394|peer-capability|networkPeers|remote-execution|allowedPeers|allowedCapabilities|delegation/i);
    expect(fs.readFileSync(creatorIpc, 'utf8')).not.toMatch(/approvedPeers/i);
  });

  it('keeps Creator and P3394 feature-flag ownership independent', () => {
    const p3394Text = fs.readFileSync(p3394Service, 'utf8');
    const creatorFlags = fs.readFileSync(path.join(creatorDir, 'flags.ts'), 'utf8');

    expect(p3394Text).not.toMatch(/features\/creator\/flags|creator\/flags|readCreatorFeatureFlags/);
    expect(creatorFlags).not.toMatch(/COGSEED_P3394_|remoteAgent|remoteStreaming|p3394RemoteAgent/);
  });

  it('keeps Creator Agent IPC input limited to safe goal/session scope', () => {
    const content = fs.readFileSync(creatorIpc, 'utf8');
    expect(content).toContain("'creator.agent.run'");
    expect(content).toMatch(/sourceSessionId/);
    expect(content).not.toMatch(/payload\.endpoint|payload\.token|payload\.rawHeaders|payload\.socketHandle|payload\.cwd|payload\.command/);
    expect(content).not.toMatch(/networkSettings|raw_headers|socket_handle/);
  });

  it('keeps main-only Creator code free of process execution and untrusted module paths', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(creatorDir)) {
      // schema.ts contains validation regexes with command words; it does not
      // import or execute a process, so inspect execution-bearing modules here.
      if (file.endsWith('/schema.ts')) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (/node:child_process|execFile|spawn\s*\(|\bexec\s*\(|new Function|\beval\s*\(/.test(content)) {
        offenders.push(`${path.relative(root, file)} invokes process execution`);
      }
      for (const match of content.matchAll(/import\(\s*([^)]*)\)/g)) {
        if (!/^['"][^'"]+['"]$/.test(match[1].trim())) {
          offenders.push(`${path.relative(root, file)} imports a non-literal module path`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('restricts new network ownership to the P3394 bridge adapters', () => {
    const creatorText = sourceFiles(creatorDir).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(creatorText).not.toMatch(/node:(?:http|https|net|tls|dgram)|WebSocket|fetch\s*\(/);
  });

  it('keeps IPC handlers away from main-only secret and transport stores', () => {
    const forbiddenImport = /(?:from|import\s*\()\s*['"](?:[^'"]*\/)?(?:secrets|secret-store|credentials|keychain)(?:\.js|\.ts)?['"]/i;
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(ipcDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = path.join(ipcDir, entry.name);
      if (forbiddenImport.test(fs.readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('rejects endpoint, token, and raw transport fields from Creator manifests', () => {
    const manifest: any = {
      schemaVersion: 1, presetId: 'safe', version: '1', displayName: 'Safe', description: 'Safe',
      presetType: 'remote-research-collaborator', model: { providerId: 'provider', modelId: 'model' },
      capabilities: [{ capabilityId: 'research.answer', version: '1' }],
      prompt: { systemSections: ['research'] },
      runtime: { sessionPolicy: 'new-per-run', memoryPolicy: 'read-only', loopPolicy: 'single-agent', sandboxProfile: 'creator-read-only-v1', timeoutMs: 1000, budget: {} },
      permissions: { tools: [], files: [], networkPeers: ['peer-a'], sideEffects: [], approvalMode: 'always' },
      remote: { allowedPeers: ['peer-a'], allowedCapabilities: ['research.answer'], delegation: { maxDepth: 1, maxFanout: 1, requireApproval: true } },
      provenance: { createdBy: 'user', sourceSessionId: 'session-1', sourceAssetRefs: [] },
      endpoint: 'http://127.0.0.1:1234',
      token: 'secret-token',
      raw_headers: { authorization: 'Bearer secret-token' },
    };
    const result = validateCreatorPresetManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain('creator_secret_field');
    }
  });
});
