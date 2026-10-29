import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({ suggestAbilityAssetTitle: async () => ({ title: 'Synthetic source checks' }) }));
vi.mock('../../../../src/main/features/kb_embed', () => ({ closeEmbedder: vi.fn(), embedQuery: async () => { throw new Error('embedding unavailable'); } }));
vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {} }));
let root: string, previous: string | undefined;
const uid = 'source-owner';
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-source-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(async () => {
  vi.restoreAllMocks(); await drainMainRuntimeForTest(uid);
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const candidate = await createNightlyCandidateFixture(uid, { judgment: 'Retain the original source before using a reusable conclusion.',
    value: 'Source checks support later work.', suggestedType: 'cognition', suggestedScope: 'general', sourceRefs: [] });
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const { asset } = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
  const store = await import('../../../../src/main/features/recall/store');
  const capture = await store.readRecallJsonRecord(uid, 'captures', candidate.captureProvenance!.captureId);
  const cid = String(capture!.conversationId);
  const { conversationMessageReadFile } = await import('../../../../src/main/util/project-layout');
  const file = conversationMessageReadFile(uid, cid), original = fs.readFileSync(file, 'utf8');
  const row = JSON.parse(original.trim());
  const chats = await import('../../../../src/main/features/chats');
  chats.invalidateConversationCaches(uid);
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const { createAssetSourceAvailability } = await import('../../../../src/main/features/recall/asset-source-availability');
  const { cognitionMessageSourceRef } = await import('../../../../src/main/features/recall/source-locator');
  return { asset, assets, row, cid, file, original, chats, read: () => createAssetSourceAvailability(uid), ref: cognitionMessageSourceRef(cid, row) };
}

it('uses the committed formation for old references without coordinates and detects changes outside their excerpt', async () => {
  const f = await fixture();
  expect(f.asset.evidenceRefs.find(ref => ref.subtype === 'message')?.locator).toBeUndefined();
  expect(await f.read()(f.asset)).toBe(true);
  fs.appendFileSync(f.file, JSON.stringify({ id: 'later-message', from: 'user', text: 'Unrelated later message.', ts: new Date().toISOString() }) + '\n');
  expect(await f.read()(f.asset)).toBe(true);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.row, text: f.row.text + ' Changed after the saved excerpt.' }) + '\n');
  expect(await f.read()(f.asset)).toBe(false);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.row, deleted_at: new Date().toISOString() }) + '\n');
  expect(await f.read()(f.asset)).toBe(false);
  fs.writeFileSync(f.file, f.original);
  expect(await f.read()(f.asset)).toBe(true);
});

it('resolves versioned legacy coordinates inside the owning conversation and caches only this read', async () => {
  const f = await fixture();
  const { locator, ...ref } = f.ref;
  const asset = { ...f.asset, candidateId: '', sourceCandidateIds: [], evidenceRefs: [ref] };
  const pages = vi.spyOn(f.chats, 'getMessagesPage');
  const read = f.read();
  expect(await read(asset)).toBe(true);
  const count = pages.mock.calls.length;
  expect(await read(asset)).toBe(true);
  expect(pages).toHaveBeenCalledTimes(count);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.row, text: 'Edited while retaining the timestamp.' }) + '\n');
  expect(await f.read()(asset)).toBe(false);
  expect(await f.read()({ ...asset, evidenceRefs: [{ ...ref, sourceVersion: undefined }] })).toBe(false);
});

it('fails closed on unreadable originals and retries source reads in the next request', async () => {
  const f = await fixture();
  const asset = { ...f.asset, evidenceRefs: [f.ref] };
  const pages = vi.spyOn(f.chats, 'getMessagesPage').mockRejectedValueOnce(new Error('Synthetic read failure'));
  expect(await f.read()(asset)).toBe(false);
  expect(await f.read()(asset)).toBe(true);
  expect(pages).toHaveBeenCalledTimes(2);
});

it('checks the selected version, not historical candidates, unrelated conversations or later messages', async () => {
  const f = await fixture();
  const nextCid = 'replacement-source-chat';
  await f.chats.createConversation(uid, { conversationId: nextCid, title: 'Synthetic replacement source', kind: 'normal' });
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const { cognitionMessageSourceRef } = await import('../../../../src/main/features/recall/source-locator');
  const row = { id: 'replacement-source', text: 'A reviewed replacement source.', from: 'user', ts: new Date().toISOString() };
  await appendJsonlAtomic(conversationMessageFile(uid, nextCid), row);
  const asset = await f.assets.updateAbilityAsset(uid, f.asset.id, { evidenceRefs: [cognitionMessageSourceRef(nextCid, row)], actor: 'user', reason: 'Replace current evidence.' });
  fs.writeFileSync(f.file, JSON.stringify({ ...f.row, deleted_at: new Date().toISOString() }) + '\n');
  await appendJsonlAtomic(conversationMessageFile(uid, nextCid), { ...row, id: 'later-unrelated', text: 'Later unrelated content.' });
  expect(asset.candidateId).toBe(f.asset.candidateId);
  expect(await f.read()(asset)).toBe(true);
  expect(await f.read()(f.asset)).toBe(false);
  expect(await f.assets.listAbilityAssetVersions(uid, asset.id)).toHaveLength(2);
});

it('preserves manual entries without message sources and legacy source-kind contracts', async () => {
  const f = await fixture();
  const { seedStoredAbilityAsset } = await import('../../../helpers/stored-ability-asset');
  const manual = await seedStoredAbilityAsset(uid, { ...f.asset, id: 'legacy-manual-asset', candidateId: '', sourceCandidateIds: [], evidenceRefs: [] });
  fs.unlinkSync(f.file);
  expect(await f.read()(manual)).toBe(true);
  expect(await f.read()({ ...manual, evidenceRefs: [{ kind: 'message', subtype: 'message', taxonomyVersion: 1, id: 'legacy-message' }] })).toBe(true);
});
