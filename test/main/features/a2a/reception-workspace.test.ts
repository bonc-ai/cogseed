import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DIRECTORY_SYMLINKS_SUPPORTED } from '../../../helpers/fs-capabilities';

const USER = 'u1';
const CID = 'a2a-0123456789abcdef0e01';
let tmp: string;
let previous: string | undefined;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-reception-workspace-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});
async function seed() {
  const chats = await import('../../../../src/main/features/chats');
  const service = await import('../../../../src/main/features/a2a/reception-service');
  const paths = await import('../../../../src/main/paths');
  const { writeJson } = await import('../../../../src/main/storage');
  await writeJson(paths.userContactsFile(USER), { version: 1, contacts: [{ userId: 'cs_alice', name: 'Alice' }] });
  await service.handleInboundQuestion(USER, { conversationId: CID, messageId: 'q1', fromAccount: 'cs_alice', text: 'Question' });
  await chats.updateConversation(USER, CID, { title: 'Review folder' });
  return { chats, service, paths };
}
function tree(dir = tmp): unknown {
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    return [name, stat.isDirectory() ? tree(file) : fs.readFileSync(file, 'utf8')];
  });
}
async function preview(service: any, selection: Record<string, unknown> = {}) {
  const result = await service.previewReceptionWorkspace(USER, { conversationId: CID, ...selection });
  if ('error' in result) throw new Error(result.error);
  return result.preview;
}
async function space(uid = USER) {
  const { createSpace } = await import('../../../../src/main/features/spaces');
  const result = await createSpace(uid, { name: 'Local space' });
  if (!result.ok) throw new Error(result.error);
  return result.space.space_id;
}

describe('T4a reception preview-confirm-restore contract', () => {
  it('uses execution collision semantics while ordinary reads keep their union', async () => {
    const { paths } = await seed();
    const owning = await import('../../../../src/main/features/user_workspace');
    const roots = await import('../../../../src/main/features/group_chat/conv_workspace');
    const root = owning.getWorkspacePath(USER);
    fs.mkdirSync(path.join(root, 'review-folder'), { recursive: true });
    const stateBefore = tree();
    const candidate = await roots.resolveReceptionWorkspaceReadOnly(USER, CID);
    expect(candidate?.root).toBe(path.join(root, 'review-folder-2'));
    expect(tree()).toEqual(stateBefore);
    expect(await roots.getConversationWorkspaceReadRoots(USER, CID)).toEqual([root]);
    expect(paths).toBeDefined();
  });

  it('preview and opening/cancelling never provision even a missing default root or choose a slug', async () => {
    const { service } = await seed();
    const { getWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    const root = getWorkspacePath(USER);
    fs.rmSync(root, { recursive: true, force: true });
    const before = tree();
    const first = await preview(service);
    const again = await preview(service);
    expect(again).toEqual(first);
    expect(tree()).toEqual(before); // cancel has no Main request
    const { readState } = await import('../../../../src/main/features/group_chat/state');
    expect((await readState(USER, CID)).workspace_dir).toBeUndefined();
  });

  it.each(['missing', 'nonowned'])('rejects %s space before any mkdir or transition', async kind => {
    const { service, chats } = await seed();
    const spaceId = kind === 'nonowned' ? await space('another-user') : 'missing-space';
    const before = tree();
    expect(await service.confirmReception(USER, { conversationId: CID, spaceId, expectedPreview: { root: '/arbitrary', snapshot: 'bad' } } as any))
      .toMatchObject({ error: 'space not found' });
    expect(tree()).toEqual(before);
    expect((await chats.getConversation(USER, CID))?.a2a?.state).toBe('waiting');
  });

  it('resolves selected default/space/custom on the server and persists the exact single root', async () => {
    const { service, paths, chats } = await seed();
    const spaceId = await space();
    const custom = fs.mkdtempSync(path.join(tmp, 'custom-'));
    const own = await preview(service);
    const selected = await preview(service, { spaceId });
    expect(selected.root).toBe(fs.realpathSync(path.dirname(paths.spaceWorkspaceDir(USER, spaceId))) + path.sep + 'workspace');
    expect(own.root).not.toBe(selected.root);
    expect((await preview(service, { workspace: custom })).root).toBe(custom);
    const confirmed = await service.confirmReception(USER, { conversationId: CID, spaceId, expectedPreview: selected } as any);
    expect(confirmed).toMatchObject({ workspace: selected.root, marker: { workspace: selected.root, state: 'active' } });
    const { readState } = await import('../../../../src/main/features/group_chat/state');
    expect(await readState(USER, CID)).toMatchObject({ coding_project_dir: selected.root, coding_project_dir_explicit: true });
    expect((await chats.getConversation(USER, CID))?.a2a?.workspace).toBe(selected.root);
    expect(fs.statSync(selected.root).isDirectory()).toBe(true);
  });

  it('honors an existing explicit root over the user default and preserves ordinary multi-root reads', async () => {
    const { service } = await seed();
    const state = await import('../../../../src/main/features/group_chat/state');
    const own = await import('../../../../src/main/features/user_workspace');
    const userDefault = fs.mkdtempSync(path.join(tmp, 'user-'));
    const explicit = fs.mkdtempSync(path.join(tmp, 'explicit-'));
    expect(own.setWorkspacePath(USER, userDefault).ok).toBe(true);
    await state.setCodingProjectDir(USER, CID, explicit, { explicit: true });
    expect((await preview(service)).root).toBe(explicit);
    const { getConversationWorkspaceReadRoots } = await import('../../../../src/main/features/group_chat/conv_workspace');
    expect(await getConversationWorkspaceReadRoots(USER, CID)).toEqual([userDefault, explicit]);
  });

  it.each(['title', 'global', 'slug', 'space', 'selection'])('rejects stale %s preview without writing', async change => {
    const { service, chats } = await seed();
    const spaceId = await space();
    const other = fs.mkdtempSync(path.join(tmp, 'other-'));
    const seen = await preview(service);
    let selection = {};
    if (change === 'title') await chats.updateConversation(USER, CID, { title: 'Changed' });
    if (change === 'space') await chats.updateConversation(USER, CID, { space_id: spaceId });
    if (change === 'global') {
      const { setWorkspacePath } = await import('../../../../src/main/features/user_workspace');
      setWorkspacePath(USER, other);
    }
    if (change === 'slug') {
      const { setWorkspaceDirOnce } = await import('../../../../src/main/features/group_chat/state');
      await setWorkspaceDirOnce(USER, CID, 'frozen');
    }
    if (change === 'selection') selection = { workspace: other };
    const before = tree();
    expect(await service.confirmReception(USER, { conversationId: CID, ...selection, expectedPreview: seen } as any))
      .toMatchObject({ error: 'workspace_preview_changed', preview: { root: expect.any(String), snapshot: expect.any(String) } });
    expect(tree()).toEqual(before);
  });

  it('returns the same actual preview for restart pending and requires a preview before creating', async () => {
    const { service } = await seed();
    const seen = await preview(service);
    const before = tree();
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/reception-service');
    expect(await restarted.listPendingReceptions(USER)).toEqual([expect.objectContaining({ workspacePreview: seen.root })]);
    expect(await restarted.confirmReception(USER, { conversationId: CID })).toMatchObject({ error: 'workspace_preview_changed' });
    expect(tree()).toEqual(before);
    expect(await restarted.confirmReception(USER, { conversationId: CID, expectedPreview: seen } as any))
      .toMatchObject({ workspace: seen.root });
  });

  it('rejects malformed, missing and system custom roots and invalid explicit selections', async () => {
    const { service } = await seed();
    for (const workspace of ['relative', path.join(tmp, 'absent'), path.parse(tmp).root, 42]) {
      expect(await service.previewReceptionWorkspace(USER, { conversationId: CID, workspace } as any)).toMatchObject({ error: 'workspace is not a directory' });
    }
    const state = await import('../../../../src/main/features/group_chat/state');
    await state.setCodingProjectDir(USER, CID, path.join(tmp, 'deleted'), { explicit: true });
    expect(await service.previewReceptionWorkspace(USER, { conversationId: CID } as any)).toMatchObject({ error: 'workspace is not a directory' });
  });

  // The canonical-root half of this case plants a real directory symlink; on a
  // host that cannot create one the fixture does not exist at all.
  it.skipIf(!DIRECTORY_SYMLINKS_SUPPORTED)('rejects static slug/symlink escapes and compares canonical custom paths', async () => {
    const { service } = await seed();
    const owning = await import('../../../../src/main/features/user_workspace');
    const state = await import('../../../../src/main/features/group_chat/state');
    await state.setWorkspaceDirOnce(USER, CID, '../escape');
    expect(await service.previewReceptionWorkspace(USER, { conversationId: CID } as any)).toMatchObject({ error: 'workspace is not a directory' });
    await state.replaceWorkspaceDir(USER, CID, '../escape', 'linked');
    const root = owning.getWorkspacePath(USER);
    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
    expect(await service.previewReceptionWorkspace(USER, { conversationId: CID } as any)).toMatchObject({ error: 'workspace is not a directory' });
    const alias = path.join(tmp, 'alias');
    fs.symlinkSync(outside, alias, 'dir');
    const seen = await preview(service, { workspace: alias });
    expect(seen.root).toBe(outside);
    expect(await service.confirmReception(USER, { conversationId: CID, workspace: alias, expectedPreview: seen } as any)).toMatchObject({ workspace: outside });
  });

  it('preserves the first grant on duplicate confirmation despite title/global/selection drift', async () => {
    const { service, chats } = await seed();
    const seen = await preview(service);
    expect(await service.confirmReception(USER, { conversationId: CID, expectedPreview: seen } as any)).toMatchObject({ workspace: seen.root });
    await chats.updateConversation(USER, CID, { title: 'Renamed' });
    const { setWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    setWorkspacePath(USER, fs.mkdtempSync(path.join(tmp, 'new-default-')));
    expect(await service.confirmReception(USER, { conversationId: CID, spaceId: 'missing', expectedPreview: seen } as any))
      .toMatchObject({ duplicate: true, workspace: seen.root });
    expect((await preview(service)).root).toBe(seen.root);
    fs.rmSync(seen.root, { recursive: true, force: true });
    const before = tree();
    expect(await service.confirmReception(USER, { conversationId: CID, expectedPreview: seen } as any)).toMatchObject({ error: 'workspace grant is unavailable' });
    expect(tree()).toEqual(before);
  });
});
