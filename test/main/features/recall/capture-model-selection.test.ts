import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const mocks = vi.hoisted(() => ({ entries: vi.fn(), buildRunner: vi.fn(), run: vi.fn() }));
vi.mock('../../../../src/main/features/auth', () => ({ listEntriesForUser: mocks.entries }));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({ buildRunner: mocks.buildRunner }));
vi.mock('../../../../src/main/features/config', () => ({ getThinkingLevel: () => 'auto' }));
import { readRecallCaptureModelSelection, resolveRecallCaptureModelCandidates } from '../../../../src/main/features/recall/capture-model-selection';
import { readRecallCaptureSettings, updateRecallCaptureSettings } from '../../../../src/main/features/recall/capture-settings';
import { writeRecallJsonRecord } from '../../../../src/main/features/recall/store';
import { runRecallCaptureModel } from '../../../../src/main/features/recall/capture-model-routing';
const first = { provider: 'one', model: 'first' };
const second = { provider: 'two', model: 'second' };
let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-model-selection-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  mocks.entries.mockReset().mockResolvedValue({ entries: [first, second] });
  mocks.run.mockReset().mockResolvedValue({ text: '', meta: { error: { kind: 'provider_error', message: '503 service unavailable' } } });
  mocks.buildRunner.mockReset().mockResolvedValue({ runner: { run: mocks.run } });
});
afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('capture model selection and persisted contract', () => {
  it('resolves only the first configured model, keeps its credential pool deduplicated and scopes reads to the user', async () => {
    mocks.entries.mockResolvedValue({ entries: [{ ...first, modelAvailable: false }, second, first] });
    expect(await readRecallCaptureModelSelection('alice', [])).toMatchObject({ source: 'system-first', effective: [{ ...first, available: true }] });
    expect((await readRecallCaptureModelSelection('alice', [])).configured).toHaveLength(2);
    expect(mocks.entries).toHaveBeenCalledWith('alice', { includeUnavailable: true });
    mocks.entries.mockResolvedValue({ entries: [second, first] });
    expect(await resolveRecallCaptureModelCandidates('alice', [])).toEqual([second]);
  });
  it('never dispatches an unlisted fallback even when the default first model fails', async () => {
    await runRecallCaptureModel('alice', { sessionId: 'memory-summary-test', systemPrompt: '', message: '',
      modelCandidates: await resolveRecallCaptureModelCandidates('alice', []) });
    expect(mocks.buildRunner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'alice', modelCandidates: [first] }));
  });
  it('does not skip a disabled first row, but leaves an empty configured set to the existing environment/CLI route', async () => {
    mocks.entries.mockResolvedValue({ entries: [{ ...first, modelAvailable: false }, second] });
    expect((await readRecallCaptureModelSelection('alice', [])).effective).toMatchObject([{ ...first, available: false }]);
    expect(await resolveRecallCaptureModelCandidates('alice', [])).toEqual([first]);
    mocks.entries.mockResolvedValue({ entries: [] });
    expect(await resolveRecallCaptureModelCandidates('alice', [])).toEqual([]);
  });
  it('persists the inherited first plus added model and keeps the independent order across rereads and system reorder', async () => {
    await updateRecallCaptureSettings('alice', { modelCandidates: [first, second] });
    mocks.entries.mockResolvedValue({ entries: [second, first] });
    const settings = await readRecallCaptureSettings('alice');
    expect(await resolveRecallCaptureModelCandidates('alice', settings.modelCandidates)).toEqual([first, second]);
    await updateRecallCaptureSettings('alice', { modelCandidates: [second, first] });
    expect((await readRecallCaptureSettings('alice')).modelCandidates).toEqual([second, first]);
    await updateRecallCaptureSettings('alice', { modelCandidates: [] });
    expect(await resolveRecallCaptureModelCandidates('alice', (await readRecallCaptureSettings('alice')).modelCandidates)).toEqual([second]);
  });
  it('rejects new unconfigured/disabled rows without changing storage, while retaining legacy and disabled inherited rows', async () => {
    mocks.entries.mockResolvedValue({ entries: [first, { ...second, modelAvailable: false }] });
    await expect(updateRecallCaptureSettings('alice', { modelCandidates: [first, second] })).rejects.toThrow('not configured or is disabled');
    await expect(updateRecallCaptureSettings('alice', { modelCandidates: [{ provider: 'one', model: 'catalog-only' }] })).rejects.toThrow('not configured');
    expect((await readRecallCaptureSettings('alice')).modelCandidates).toEqual([]);
    const legacy = { provider: 'removed', model: 'historical' };
    const stored = await readRecallCaptureSettings('alice');
    await writeRecallJsonRecord('alice', 'capture-settings', 'settings', { ...stored, modelCandidates: [legacy, second] });
    await updateRecallCaptureSettings('alice', { modelCandidates: [second, legacy] });
    expect((await readRecallCaptureSettings('alice')).modelCandidates).toEqual([second, legacy]);
    await updateRecallCaptureSettings('alice', { modelCandidates: [legacy] });
    expect((await readRecallCaptureModelSelection('alice', [legacy])).effective).toMatchObject([{ ...legacy, configured: false }]);
    await updateRecallCaptureSettings('alice', { modelCandidates: [] });
    mocks.entries.mockResolvedValue({ entries: [{ ...first, modelAvailable: false }, second] });
    await updateRecallCaptureSettings('alice', { modelCandidates: [first, second] });
    expect((await readRecallCaptureSettings('alice')).modelCandidates).toEqual([first, second]);
  });
});
