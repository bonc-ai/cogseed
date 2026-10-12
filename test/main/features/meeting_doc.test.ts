/**
 * meeting_doc — 统一文档模型 MeetingDocRef（specs/013 T010）
 *
 * 钉住四条验收：①同 docId 两次调用同 docKey；②幂等不产生第二条；
 * ③刷新不覆盖 createdAt；④create:false 且缺失返回 null 不抛错。
 * 另钉：docKey 确定性/安全化、speakers 主进程现算且正文不落盘、边界截断。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MeetingDocError,
  MAX_SCENARIO_TAGS,
  MAX_SPEAKERS,
  computeSpeakers,
  degradedFlagsOf,
  docKeyForDocId,
  getMeetingDoc,
  listMeetingDocs,
  meetingDocFile,
} from '../../../src/main/features/meeting_doc';
import { userMeetingDocsDir, userMeetingActionDraftsDir, userMeetingMetricsFile, userMeetingRefsDir, userTranscriptGlossaryDir, userTranscriptMetricsFile } from '../../../src/main/paths';

const uid = 'u_meeting_doc_test';

beforeEach(() => {
  fs.rmSync(userMeetingDocsDir(uid), { recursive: true, force: true });
});

describe('docKey 确定性派生（安全化 + 超长截断 + 短 hash）', () => {
  it('同一 docId 永远同一 docKey（确定性）', () => {
    expect(docKeyForDocId('kb/ meetings/2026-09-05 转写.md')).toBe(docKeyForDocId('kb/ meetings/2026-09-05 转写.md'));
  });

  it('路径分隔符/中文被安全化，文件名段里只剩 [A-Za-z0-9._-] 与 hash', () => {
    const key = docKeyForDocId('kb/../meetings/2026-09-05 转写.md');
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(key).not.toContain('/');
    expect(key).not.toContain('..');
  });

  it('超长 docId 截断且恒带 10 位 hash 后缀（安全化碰撞由 hash 兜住）', () => {
    const long = 'a'.repeat(5000);
    const key = docKeyForDocId(long);
    expect(key.length).toBeLessThanOrEqual(91); // 80 截断 + '-' + 10 hash
    expect(key.endsWith(`-${docKeyForDocId(long).slice(-10)}`)).toBe(true);
    // 安全化把不同 docId 折成同一名时，hash 让 docKey 仍不同
    expect(docKeyForDocId('a/b')).not.toBe(docKeyForDocId('a_b'));
  });

  it('全中文 docId 不会得到空文件名', () => {
    expect(docKeyForDocId('会议纪要')).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('getMeetingDoc：惰性创建 / 幂等 / 刷新（T010 四条验收）', () => {
  it('① 同 docId 两次调用同 docKey；② 幂等不产生第二条', () => {
    const first = getMeetingDoc(uid, 'kb/meetings/0910.md', { title: '0910 例会' });
    const second = getMeetingDoc(uid, 'kb/meetings/0910.md', { title: '0910 例会' });
    expect(docKeyForDocId('kb/meetings/0910.md')).toBe(docKeyForDocId('kb/meetings/0910.md'));
    expect(second.docId).toBe(first.docId);
    // 目录里只有一个文件 = 没有第二条
    const files = fs.readdirSync(userMeetingDocsDir(uid)).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(listMeetingDocs(uid)).toHaveLength(1);
  });

  it('③ 刷新 sourceVersion/transcript/speakers/scenarioTags，但 createdAt 不被覆盖', async () => {
    const first = getMeetingDoc(uid, 'kb/m.md', {
      title: '第一版',
      sourceVersion: '1000',
      text: '张磊 00:01:00\n说了两句\n',
    });
    await new Promise((resolve) => setTimeout(resolve, 15)); // 保证时间戳可分辨
    const second = getMeetingDoc(uid, 'kb/m.md', {
      sourceVersion: '2000',
      text: '张磊 00:01:00\n第一句\nAlex 00:02:00\n第二句\n',
      scenarioTags: ['组会'],
    });
    expect(second.createdAt).toBe(first.createdAt);           // 创建时间不覆盖
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect(second.sourceVersion).toBe('2000');                 // 刷新
    expect(second.speakers).toEqual(['张磊', 'Alex']);          // 主进程现算（去重保序）
    expect(second.scenarioTags).toEqual(['组会']);
    expect(second.title).toBe('第一版');                        // 不传 title = 保留既有
  });

  it('④ create:false 且缺失 → 返回 null，不抛错也不落盘（只读探测）', () => {
    expect(getMeetingDoc(uid, 'kb/none.md', { create: false })).toBeNull();
    expect(fs.existsSync(userMeetingDocsDir(uid))).toBe(false);
  });

  it('docId 空/超长 → 码化拒绝（invalid_doc_id，归因 schema）', () => {
    expect(() => getMeetingDoc(uid, '  ')).toThrowError(MeetingDocError);
    expect(() => getMeetingDoc(uid, 'x'.repeat(1001))).toThrowError(MeetingDocError);
    try {
      getMeetingDoc(uid, '');
    } catch (error) {
      expect((error as MeetingDocError).code).toBe('invalid_doc_id');
    }
  });

  it('缺省 title 从 docId 文件名派生，且 ≤120 截断', () => {
    const doc = getMeetingDoc(uid, 'kb/meetings/季度对齐会.md');
    expect(doc.title).toBe('季度对齐会.md');
    const long = getMeetingDoc(uid, `${'深'.repeat(300)}.md`, { title: 'x'.repeat(500) });
    expect(long.title.length).toBeLessThanOrEqual(120);
  });
});

describe('speakers 主进程现算（text 只进不出）', () => {
  it('块头解析出说话人：去重保序；无块头 → 缺省（不编造）', () => {
    expect(computeSpeakers('张磊 00:01:00\n你好\nAlex 00:02:00\n嗨\n张磊 00:03:00\n又一句\n')).toEqual(['张磊', 'Alex']);
    expect(computeSpeakers('这是没有块头的平文，没有说话人。')).toBeUndefined();
    expect(computeSpeakers('')).toBeUndefined();
  });

  it('有界 50：超出的说话人截断', () => {
    const text = Array.from({ length: 80 }, (_, i) => `说话人${i} 00:0${i % 10}:00\n内容\n`).join('');
    expect(computeSpeakers(text)).toHaveLength(MAX_SPEAKERS);
  });

  it('转写正文绝不落盘：读盘记录里只有名单，没有正文（隐私边界 D20）', () => {
    const body = '张磊 00:01:00\n这句是转写正文，绝不允许出现在记录里。';
    getMeetingDoc(uid, 'kb/private.md', { text: body });
    const file = meetingDocFile(uid, docKeyForDocId('kb/private.md'));
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('张磊');
    expect(raw).not.toContain('转写正文');
    expect(raw).not.toContain('绝不允许');
  });
});

describe('边界与容错', () => {
  it('scenarioTags 去重 + ≤20 截断；空数组 = 字段缺省', () => {
    const many = Array.from({ length: 40 }, (_, i) => (i === 1 ? '组会' : `场景${i}`));
    const doc = getMeetingDoc(uid, 'kb/tags.md', { scenarioTags: many });
    expect(doc.scenarioTags).toHaveLength(MAX_SCENARIO_TAGS);
    expect(new Set(doc.scenarioTags).size).toBe(MAX_SCENARIO_TAGS); // 去重后仍满 20
    const empty = getMeetingDoc(uid, 'kb/tags2.md', { scenarioTags: [] });
    expect(empty.scenarioTags).toBeUndefined();
  });

  it('transcript 锚点只在字段齐时写入（runId/beforeSha1 缺一不写）', () => {
    const doc = getMeetingDoc(uid, 'kb/run.md', { transcript: { runId: 'r1', beforeSha1: 'abc' } });
    expect(doc.transcript).toEqual({ runId: 'r1', beforeSha1: 'abc', at: doc.transcript!.at });
    const bad = getMeetingDoc(uid, 'kb/run2.md', { transcript: { runId: '', beforeSha1: 'abc' } });
    expect(bad.transcript).toBeUndefined();
  });

  it('schemaVersion 恒为 1；坏文件按缺失处理（重建不炸）', () => {
    const first = getMeetingDoc(uid, 'kb/corrupt.md', {});
    expect(first.schemaVersion).toBe(1);
    const file = meetingDocFile(uid, docKeyForDocId('kb/corrupt.md'));
    fs.writeFileSync(file, '{not json', 'utf8');
    const retry = getMeetingDoc(uid, 'kb/corrupt.md', {});
    expect(retry).not.toBeNull();
    expect(retry.createdAt).toBeTruthy();
  });

  it('listMeetingDocs：目录缺失返回空数组（不抛错）', () => {
    expect(listMeetingDocs('u_no_such_user_at_all')).toEqual([]);
  });

  it('路径与词表同域（cloud 的 transcript/ 下，T009）', () => {
    const dir = userMeetingDocsDir(uid);
    expect(dir).toContain(path.join('cloud', 'cogseed', 'transcript'));
    expect(dir.endsWith('meeting-docs')).toBe(true);
  });
});

describe('会议侧存储路径（specs/013 T009：3 个 cloud 目录 + 1 个 local 指标文件）', () => {
  it('三个目录与词表同域 <uid>/cloud/cogseed/transcript/**', () => {
    expect(userMeetingDocsDir(uid)).toBe(
      path.join(userTranscriptGlossaryDir(uid), 'meeting-docs'),
    );
    expect(userMeetingRefsDir(uid)).toBe(
      path.join(userTranscriptGlossaryDir(uid), 'meeting-refs'),
    );
    expect(userMeetingActionDraftsDir(uid)).toBe(
      path.join(userTranscriptGlossaryDir(uid), 'action-drafts'),
    );
    for (const dir of [userMeetingDocsDir(uid), userMeetingRefsDir(uid), userMeetingActionDraftsDir(uid)]) {
      expect(dir).toContain(path.join('cloud', 'cogseed', 'transcript'));
    }
  });

  it('会议指标文件在 local 域且与既有 metrics.jsonl 同目录不混流', () => {
    const file = userMeetingMetricsFile(uid);
    expect(file).toContain(path.join('local', 'cogseed', 'transcript'));
    expect(path.basename(file)).toBe('meeting-metrics.jsonl');
    expect(file).not.toBe(userTranscriptMetricsFile(uid));
    expect(path.dirname(file)).toBe(path.dirname(userTranscriptMetricsFile(uid)));
  });
});

// ── 降级如实标注（specs/013 T021：三种可判定缺失各自记名，不编造定位）─────────
describe('degraded（T021）：no_speakers / no_scenario_tags / no_transcript_run', () => {
  it('三种缺失各自出现：算不出说话人 + 没传场景标签 + 没有 run 锚点', () => {
    const doc = getMeetingDoc(uid, 'kb/bare.md', { text: '这是没有块头的平文。' });
    expect(doc.degraded).toEqual(['no_speakers', 'no_scenario_tags', 'no_transcript_run']);
    // 读盘可见（界面文案按码出"缺失说明"，本任务只落数据）
    const raw = JSON.parse(fs.readFileSync(meetingDocFile(uid, docKeyForDocId('kb/bare.md')), 'utf8'));
    expect(raw.degraded).toEqual(['no_speakers', 'no_scenario_tags', 'no_transcript_run']);
  });

  it('部分缺失只记缺的那几种（有说话人但仍无标签、无 run）', () => {
    const doc = getMeetingDoc(uid, 'kb/partial.md', {
      text: '张磊 00:01:00\n说了一句\n',
    });
    expect(doc.speakers).toEqual(['张磊']);
    expect(doc.degraded).toEqual(['no_scenario_tags', 'no_transcript_run']);
  });

  it('三样齐备 → degraded 缺省（不落空数组）', () => {
    const doc = getMeetingDoc(uid, 'kb/full.md', {
      text: '张磊 00:01:00\n说了一句\n',
      scenarioTags: ['组会'],
      transcript: { runId: 'run_1', beforeSha1: 'abc' },
    });
    expect(doc.degraded).toBeUndefined();
  });

  it('刷新后补齐 → degraded 随之消失（按写前一刻的状态重算）', () => {
    getMeetingDoc(uid, 'kb/heal.md', { text: '平文' });
    const healed = getMeetingDoc(uid, 'kb/heal.md', {
      text: '张磊 00:01:00\n说了一句\n',
      scenarioTags: ['组会'],
      transcript: { runId: 'run_2', beforeSha1: 'def' },
    });
    expect(healed.degraded).toBeUndefined();
  });

  it('degradedFlagsOf 是纯判定（不碰盘）：三缺一各记各的', () => {
    expect(degradedFlagsOf({})).toEqual(['no_speakers', 'no_scenario_tags', 'no_transcript_run']);
    expect(degradedFlagsOf({ speakers: ['张磊'] })).toEqual(['no_scenario_tags', 'no_transcript_run']);
    expect(degradedFlagsOf({ speakers: ['张磊'], scenarioTags: ['组会'] })).toEqual(['no_transcript_run']);
    expect(degradedFlagsOf({ speakers: ['张磊'], scenarioTags: ['组会'], transcript: { runId: 'r', beforeSha1: 's', at: '' } })).toEqual([]);
  });
});
