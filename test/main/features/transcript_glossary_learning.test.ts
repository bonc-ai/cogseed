import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import {
  _resetLearningFileForTest,
  getLearningState,
  recordConfirmedCorrections,
  setLearningSettings,
  undoLearnedEntry,
} from '../../../src/main/features/transcript_glossary_learning';
import { listEntries, upsertEntry } from '../../../src/main/features/transcript_glossary';
import { userTranscriptGlossaryFile } from '../../../src/main/paths';

let uid = '';
beforeEach(() => {
  uid = `u_learning_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _resetLearningFileForTest(uid);
});

const pair = { wrong: 'cocos set', correct: 'Cogseed', kind: 'product' as const };

describe('transcript glossary auto-learning', () => {
  it('promotes the same confirmed pair after the default threshold of 3', async () => {
    for (let i = 0; i < 3; i += 1) {
      const result = await recordConfirmedCorrections(uid, [pair]);
      if (i < 2) expect(result.learned).toHaveLength(0);
    }
    const learned = getLearningState(uid).recent;
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ wrong: 'cocos set', correct: 'Cogseed', count: 3 });
    const entry = listEntries(uid).find((e) => e.wrong === 'cocos set' && e.correct === 'Cogseed');
    expect(entry).toBeTruthy();
    expect(entry?.scope.global).toBe(true);
    expect(entry?.source).toBe('meeting_accept');
  });

  it('does not learn when disabled or when the pair is already in the glossary', async () => {
    await setLearningSettings(uid, { enabled: false });
    for (let i = 0; i < 5; i += 1) await recordConfirmedCorrections(uid, [pair]);
    expect(listEntries(uid).find((e) => e.wrong === pair.wrong)).toBeUndefined();

    await setLearningSettings(uid, { enabled: true });
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    for (let i = 0; i < 5; i += 1) await recordConfirmedCorrections(uid, [{ ...pair, wrong: 'coxy' }]);
    expect(getLearningState(uid).recent).toHaveLength(0);
  });

  it('undo removes the promoted entry and resets its counter', async () => {
    for (let i = 0; i < 3; i += 1) await recordConfirmedCorrections(uid, [pair]);
    const learned = getLearningState(uid).recent[0];
    expect(await undoLearnedEntry(uid, learned.learnedEntryId)).toBe(true);
    expect(listEntries(uid).find((e) => e.wrong === pair.wrong)).toBeUndefined();
    expect(getLearningState(uid).recent).toHaveLength(0);
    // One more confirmation starts a fresh count; it must not immediately re-promote.
    const again = await recordConfirmedCorrections(uid, [pair]);
    expect(again.learned).toHaveLength(0);
  });

  it('persists and clamps learning settings', async () => {
    const settings = await setLearningSettings(uid, { threshold: 99, notify: false, enabled: true });
    expect(settings).toMatchObject({ threshold: 5, notify: false, enabled: true });
    expect(getLearningState(uid).settings).toMatchObject({ threshold: 5, notify: false });
  });

  it('never learns no-op pairs', async () => {
    for (let i = 0; i < 5; i += 1) await recordConfirmedCorrections(uid, [{ wrong: '张浩', correct: '张浩' }]);
    expect(getLearningState(uid).recent).toHaveLength(0);
    fs.rmSync(userTranscriptGlossaryFile(uid), { force: true });
  });
});
