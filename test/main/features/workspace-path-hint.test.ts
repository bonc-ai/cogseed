import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { candidatePathsForHint } from '../../../src/main/features/workspace_path_hint';

const ROOT = path.resolve('/ws/userWorkSpace');
const HOME = path.resolve('/home/u');
const ctx = (over: Partial<Parameters<typeof candidatePathsForHint>[1]> = {}) => ({
  homeDir: HOME,
  bases: [ROOT],
  recordedPaths: [],
  ...over,
});

describe('candidatePathsForHint', () => {
  it.each([
    ['ascii ellipsis', '.../跟进下下午和张浩的会议-4/2026-10-14_下午_张浩会议_任务清单_v001.md'],
    ['unicode ellipsis', '…/跟进下下午和张浩的会议-4/2026-10-14_下午_张浩会议_任务清单_v001.md'],
    ['bare relative', '跟进下下午和张浩的会议-4/2026-10-14_下午_张浩会议_任务清单_v001.md'],
    ['dot relative', './跟进下下午和张浩的会议-4/2026-10-14_下午_张浩会议_任务清单_v001.md'],
  ])('joins a %s hint onto each base', (_label, hint) => {
    expect(candidatePathsForHint(hint, ctx())).toEqual([
      path.join(ROOT, '跟进下下午和张浩的会议-4', '2026-10-14_下午_张浩会议_任务清单_v001.md'),
    ]);
  });

  it('joins a bare file name onto each base, conversation dir first', () => {
    const convDir = path.join(ROOT, '跟进下下午和张浩的会议-4');
    expect(candidatePathsForHint('2026-10-14_下午_张浩会议_会议纪要_v001.md', ctx({ bases: [convDir, ROOT] }))).toEqual([
      path.join(convDir, '2026-10-14_下午_张浩会议_会议纪要_v001.md'),
      path.join(ROOT, '2026-10-14_下午_张浩会议_会议纪要_v001.md'),
    ]);
  });

  it('prefers a recorded produced path whose tail matches the shortened hint', () => {
    const recorded = path.join(ROOT, 'spaces', 's1', '跟进-4', '纪要.md');
    const out = candidatePathsForHint('.../跟进-4/纪要.md', ctx({ recordedPaths: [recorded] }));
    expect(out[0]).toBe(recorded);
    expect(out).toContain(path.join(ROOT, '跟进-4', '纪要.md'));
  });

  it('does not match a recorded path on a partial segment', () => {
    const recorded = path.join(ROOT, 'old跟进-4', '纪要.md');
    expect(candidatePathsForHint('跟进-4/纪要.md', ctx({ recordedPaths: [recorded] })))
      .toEqual([path.join(ROOT, '跟进-4', '纪要.md')]);
  });

  it('keeps absolute and home paths as a single candidate', () => {
    expect(candidatePathsForHint('/ws/userWorkSpace/a/b.md', ctx())).toEqual([path.resolve('/ws/userWorkSpace/a/b.md')]);
    expect(candidatePathsForHint('~/notes/a.md', ctx())).toEqual([path.join(HOME, 'notes', 'a.md')]);
  });

  it.each([
    ['parent traversal', '.../../etc/passwd'],
    ['embedded traversal', 'a/../../secret.md'],
    ['url', 'https://example.com/a.md'],
    ['multi-line', 'a/b.md\nc/d.md'],
    ['empty', '   '],
  ])('rejects %s', (_label, hint) => {
    expect(candidatePathsForHint(hint, ctx())).toEqual([]);
  });
});
