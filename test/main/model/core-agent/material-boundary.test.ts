/**
 * material-boundary (COGSEED-39 ① Phase 3) — material set resolution.
 *
 * Hermetic tests with a temp workspace root:
 *   - attachments of a conversation land in the set with inScope computed
 *     against the attachment root;
 *   - absent cid / spaceId / projectId yields an empty boundary with the
 *     right library slices and history scope;
 *   - space artifacts are included when a spaceId is present (empty space
 *     returns an empty artifacts list, no throw).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'matboundary';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-mb-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadBoundary() {
  return import('../../../../src/main/model/core-agent/material-boundary');
}

describe('material_boundary › resolveMaterialSet', () => {
  it('lists conversation attachments with inScope=true under their cid root', async () => {
    const mod = await loadBoundary();
    const { attachmentDirForCid } = await import('../../../../src/main/features/chat_attachments');
    const dir = attachmentDirForCid(TEST_UID, 'conv-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.pdf'), 'pdf bytes');
    fs.writeFileSync(path.join(dir, 'slides.pptx'), 'pptx bytes');

    const set = await mod.resolveMaterialSet({ userId: TEST_UID, cid: 'conv-1' });

    expect(set.library).toEqual({ global: true, space: false });
    expect(set.history).toBe('none');
    expect(set.artifacts).toEqual([]);
    const names = set.attachments.map((a) => a.name).sort();
    expect(names).toEqual(['notes.pdf', 'slides.pptx']);
    for (const a of set.attachments) expect(a.inScope).toBe(true);
    expect(set.attachments.every((a) => a.bytes > 0)).toBe(true);
  });

  it('attachment upload after resolution is picked up immediately (no cache)', async () => {
    const mod = await loadBoundary();
    const { attachmentDirForCid } = await import('../../../../src/main/features/chat_attachments');
    const dir = attachmentDirForCid(TEST_UID, 'conv-2');
    fs.mkdirSync(dir, { recursive: true });

    const before = await mod.resolveMaterialSet({ userId: TEST_UID, cid: 'conv-2' });
    expect(before.attachments).toEqual([]);

    fs.writeFileSync(path.join(dir, 'new.pdf'), 'new');
    const after = await mod.resolveMaterialSet({ userId: TEST_UID, cid: 'conv-2' });
    expect(after.attachments.map((a) => a.name)).toEqual(['new.pdf']);
  });

  it('empty boundary when no cid/space/project is provided', async () => {
    const mod = await loadBoundary();
    const set = await mod.resolveMaterialSet({ userId: TEST_UID });
    expect(set).toEqual({
      library: { global: true, space: false },
      attachments: [],
      artifacts: [],
      history: 'none',
    });
  });

  it('space + project set space slice and history scope', async () => {
    const mod = await loadBoundary();
    const set = await mod.resolveMaterialSet({ userId: TEST_UID, spaceId: 'space-x', projectId: 'proj-1' });
    expect(set.library.space).toBe(true);
    expect(set.history).toBe('project');
    // Empty space: no artifacts thrown, empty list.
    expect(set.artifacts).toEqual([]);
  });
});
