import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {} }));
let root: string, previous: string | undefined;
const uid = 'repair-owner';
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-coordinate-repair-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(async () => {
  vi.restoreAllMocks(); await drainMainRuntimeForTest(uid);
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

const sha = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');

async function seedConversation(cid: string, rows: Array<{ id: string; text: string; deleted_at?: string }>) {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(uid, { conversationId: cid, title: 'Synthetic repair source', kind: 'normal' });
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  for (const row of rows) await appendJsonlAtomic(conversationMessageFile(uid, cid), { ...row, from: 'user', ts: new Date().toISOString() });
  chats.invalidateConversationCaches(uid);
  return conversationMessageFile(uid, cid);
}
async function refs() {
  const { cognitionMessageSourceId } = await import('../../../../src/main/features/recall/source-identity');
  return {
    message: (cid: string, mid: string) => ({ kind: 'conversation', subtype: 'message', taxonomyVersion: 2, scope: 'conversation', id: cognitionMessageSourceId(cid, mid) }),
    session: (cid: string) => ({ kind: 'conversation', subtype: 'session', taxonomyVersion: 2, scope: 'conversation', id: cid, title: 'Synthetic repair source' }),
  };
}
async function seedRecord(collection: string, id: string, extra: Record<string, unknown>) {
  const store = await import('../../../../src/main/features/recall/store');
  await store.writeRecallJsonRecord(uid, collection, id, { schemaVersion: 1, ownerId: uid, id, ...extra });
  return store;
}
const repair = async () => (await import('../../../../src/main/features/recall/source-coordinate-repair')).repairRecallSourceCoordinates(uid);
const readAsset = async (store: Awaited<ReturnType<typeof seedRecord>>, id: string) => store.readRecallJsonRecord(uid, 'ability-assets', id);
const availability = async (asset: unknown) =>
  (await import('../../../../src/main/features/recall/asset-source-availability')).createAssetSourceAvailability(uid)(asset as never);

it('repairs a coordinate-less legacy ref from its own session and makes the asset readable, once', async () => {
  const cid = 'a1b2c3d4e5f6';
  await seedConversation(cid, [{ id: 'source-message-1', text: 'Keep the original wording.' },
    { id: 'already-measured', text: 'Already measured.' }]);
  const { message, session } = await refs();
  const strict = { ...message(cid, 'already-measured'), locator: { conversationId: cid, messageId: 'already-measured' }, sourceVersion: sha('Already measured.') };
  const store = await seedRecord('ability-assets', 'aa-repair-1', { status: 'active', title: 'Synthetic repair asset',
    statement: 'Synthetic content.', version: '1', evidenceRefs: [session(cid), strict, message(cid, 'source-message-1')], sourceSessionIds: [cid] });
  const before = await readAsset(store, 'aa-repair-1');
  expect(await availability(before)).toBe(false);

  const stats = await repair();
  expect(stats).toMatchObject({ repairedRefs: 1, updatedRecords: 1, unresolvedRefs: 0, skippedRemovedRefs: 0, failedRecords: 0 });
  const after = await readAsset(store, 'aa-repair-1');
  const repairedRef = after!.evidenceRefs.find((ref) => ref.subtype === 'message' && ref.sourceVersion === sha('Keep the original wording.'));
  expect(repairedRef?.locator).toEqual({ conversationId: cid, messageId: 'source-message-1' });
  expect(JSON.stringify(after!.evidenceRefs[1])).toBe(JSON.stringify(strict));
  expect(await availability(after)).toBe(true);

  // 幂等：补完落标记，之后启动只做标记判断，不再扫描或写入。
  await expect(repair()).resolves.toMatchObject({ skipped: true, repairedRefs: 0, updatedRecords: 0 });
});

it('adds the missing content version to a locator-only ref without touching its locator', async () => {
  const cid = 'a1b2c3d4e5f7';
  await seedConversation(cid, [{ id: 'source-message-2', text: 'Bound to the live message.' }]);
  const { message } = await refs();
  const store = await seedRecord('ability-assets', 'aa-repair-2', { status: 'active', title: 'Synthetic locator-only asset',
    statement: 'Synthetic content.', version: '1', evidenceRefs: [{ ...message(cid, 'source-message-2'), locator: { conversationId: cid, messageId: 'source-message-2' } }] });
  await repair();
  const after = await readAsset(store, 'aa-repair-2');
  const ref = after!.evidenceRefs[0];
  expect(ref.locator).toEqual({ conversationId: cid, messageId: 'source-message-2' });
  expect(ref.sourceVersion).toBe(sha('Bound to the live message.'));
  expect(await availability(after)).toBe(true);
});

it('leaves deleted messages unresolved and the record untouched', async () => {
  const cid = 'a1b2c3d4e5f8';
  const file = await seedConversation(cid, [{ id: 'source-message-3', text: 'Deleted later.' }]);
  fs.writeFileSync(file, JSON.stringify({ id: 'source-message-3', from: 'user', text: 'Deleted later.', ts: new Date().toISOString(), deleted_at: new Date().toISOString() }) + '\n');
  const { message, session } = await refs();
  const store = await seedRecord('ability-assets', 'aa-repair-3', { status: 'active', title: 'Synthetic deleted source',
    statement: 'Synthetic content.', version: '1', evidenceRefs: [session(cid), message(cid, 'source-message-3')], sourceSessionIds: [cid] });
  const stats = await repair();
  expect(stats).toMatchObject({ repairedRefs: 0, updatedRecords: 0, unresolvedRefs: 1 });
  const after = await readAsset(store, 'aa-repair-3');
  expect(after!.evidenceRefs[1]).not.toHaveProperty('locator');
  expect(await availability(after)).toBe(false);
});

it('skips references whose source was paused, and repairs them after the source resumes', async () => {
  const cid = 'a1b2c3d4e5f9';
  await seedConversation(cid, [{ id: 'source-message-4', text: 'Paused then resumed.' }]);
  const { message, session } = await refs();
  const { pauseCognitionSource, resumeCognitionSource } = await import('../../../../src/main/features/recall/source-control');
  await pauseCognitionSource(uid, session(cid));
  const store = await seedRecord('ability-assets', 'aa-repair-4', { status: 'active', title: 'Synthetic paused source',
    statement: 'Synthetic content.', version: '1', evidenceRefs: [message(cid, 'source-message-4')], sourceSessionIds: [cid] });
  await expect(repair()).resolves.toMatchObject({ repairedRefs: 0, skippedRemovedRefs: 1 });
  await resumeCognitionSource(uid, session(cid));
  await expect(repair()).resolves.toMatchObject({ repairedRefs: 1, updatedRecords: 1 });
  const after = await readAsset(store, 'aa-repair-4');
  expect(after!.evidenceRefs[0].sourceVersion).toBe(sha('Paused then resumed.'));
});

it('covers candidate records, keeps legacy v1 refs, and reports refs without any declared session', async () => {
  const cid = 'a1b2c3d4e5fa';
  await seedConversation(cid, [{ id: 'source-message-5', text: 'Candidate evidence.' }]);
  const { message, session } = await refs();
  const legacyV1 = { kind: 'message', subtype: 'message', taxonomyVersion: 1, id: 'legacy-message' };
  const store = await seedRecord('candidates', 'cand-repair-1', { status: 'pending_review',
    evidenceRefs: [message(cid, 'source-message-5'), legacyV1], sourceRefs: [session(cid)] });
  await seedRecord('ability-assets', 'aa-repair-5', { status: 'active', title: 'Synthetic sessionless asset',
    statement: 'Synthetic content.', version: '1', evidenceRefs: [message(cid, 'source-message-5')] });
  const stats = await repair();
  expect(stats).toMatchObject({ repairedRefs: 1, updatedRecords: 1, unresolvedRefs: 1 });
  const candidate = await store.readRecallJsonRecord(uid, 'candidates', 'cand-repair-1');
  expect(candidate!.evidenceRefs[0].locator).toEqual({ conversationId: cid, messageId: 'source-message-5' });
  expect(JSON.stringify(candidate!.evidenceRefs[1])).toBe(JSON.stringify(legacyV1));
  const sessionless = await readAsset(store, 'aa-repair-5');
  expect(sessionless!.evidenceRefs[0]).not.toHaveProperty('locator');
  // 残留未决引用时不落标记，下次启动继续重试。
  await expect(repair()).resolves.toMatchObject({ skipped: false, unresolvedRefs: 1 });
});