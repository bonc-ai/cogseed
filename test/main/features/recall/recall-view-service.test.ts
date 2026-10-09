import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-view-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('RecallView service', () => {
  it('persists metadata-only views with canonical and preserved legacy refs', async () => {
    const views = await import('../../../../src/main/features/recall/recall-view-service');
    const created = await views.createRecallView('user-a', {
      purpose: 'conversation_capture',
      workspaceId: 'workspace-a',
      sourceRefs: [
        { kind: 'conversation', subtype: 'session', id: 'conv-a', title: '/private/conversation.jsonl', excerpt: 'must not be copied' },
        { kind: 'memory', id: 'legacy-memory-a', excerpt: 'private memory body' },
      ],
      assetRefs: ['asset-a'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    expect(created).toMatchObject({ taxonomyVersion: 2, ownerId: 'user-a', purpose: 'conversation_capture', workspaceId: 'workspace-a' });
    expect(created.sourceRefs).toEqual([
      expect.objectContaining({ kind: 'conversation', subtype: 'session', id: 'conv-a' }),
      expect.objectContaining({ kind: 'memory', subtype: 'teaching', id: 'legacy-memory-a', taxonomyVersion: 1, degraded: true, reason: 'legacy_memory_untraceable' }),
    ]);
    expect(JSON.stringify(created)).not.toContain('must not be copied');
    expect(JSON.stringify(created)).not.toContain('private memory body');
    expect(JSON.stringify(created)).not.toContain('/private/conversation.jsonl');
    expect(created.degradedRefs).toContain('memory:legacy-memory-a');
    await expect(views.readRecallView('user-b', created.id)).rejects.toThrow(/not found/i);
  });

  it('isolates listing by workspace, purpose, owner, and expiry', async () => {
    const views = await import('../../../../src/main/features/recall/recall-view-service');
    await views.createRecallView('user-a', { purpose: 'conversation_capture', workspaceId: 'workspace-a', sourceRefs: [{ kind: 'conversation', id: 'conv-a' }] });
    await views.createRecallView('user-a', { purpose: 'task_context', workspaceId: 'workspace-b', sourceRefs: [{ kind: 'artifact_file', subtype: 'context_file', id: 'ctx-a' }] });
    await views.createRecallView('user-a', { purpose: 'conversation_capture', workspaceId: 'workspace-a', sourceRefs: [{ kind: 'conversation', id: 'conv-old' }], expiresAt: '2000-01-01T00:00:00.000Z' });
    await views.createRecallView('user-b', { purpose: 'conversation_capture', workspaceId: 'workspace-a', sourceRefs: [{ kind: 'conversation', id: 'conv-b' }] });

    const active = await views.listRecallViews('user-a', { purpose: 'conversation_capture', workspaceId: 'workspace-a' });
    expect(active).toHaveLength(1);
    expect(active[0].sourceRefs[0].id).toBe('conv-a');
    await expect(views.listRecallViews('user-a', { purpose: 'conversation_capture', workspaceId: 'workspace-a', includeExpired: true })).resolves.toHaveLength(2);
  });
});
