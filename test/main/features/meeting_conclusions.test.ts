/**
 * meeting_conclusions — 纪要条目实体 MeetingConclusion（specs/013 T034~T036 / US-502）
 *
 * 四组验收（以 tasks.md 原文为准）：
 *   T034 ① 同输入两次 ⇒ 同 id 不新增；② summary 空/超长被拒；
 *        ③ confirm 不产生任何候选/资产副作用（读盘断言）
 *   T035 锚点字段齐（U0001 体系）；assetRefs 从本文件的引用包取（同一份冻结）；
 *        读盘断言记录内不含转写正文与资产正文（只允许 ≤240 摘要）
 *   T036 ① 无锚点记录 ⇒ 不抛错、unlinkable==='no_transcript_ref'；
 *        ② 手工造旧记录 ⇒ legacy_record；③ 正常记录 unlinkable 缺失；
 *        另钉 anchor_not_found（锚点解析不到 ⇒ 降级不报错）
 *
 * `readAbilityAsset` 走 mock（挂载准入与本模块无关，本模块只从引用包取冻结值）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readAbilityAsset } from '../../../src/main/features/recall/asset-service';
import type { RecallAbilityAssetRecord } from '../../../src/main/features/recall/candidate-service';
import { listRecallCandidates, saveRecallCandidate } from '../../../src/main/features/recall/candidate-service';
import { cognitionContextFileSourceId } from '../../../src/main/features/recall/source-catalog';
import {
  MAX_MEETING_CONCLUSION_SUMMARY,
  MeetingConclusionError,
  buildConclusionCandidateInput,
  conclusionCaptureKey,
  confirmMeetingConclusion,
  listMeetingConclusions,
  meetingConclusionIdFor,
  saveMeetingConclusion,
  unresolvedMeetingAnchorIds,
} from '../../../src/main/features/meeting_conclusions';
import type { MeetingConclusion } from '../../../src/main/features/meeting_conclusions';
import { attachMeetingAsset } from '../../../src/main/features/meeting_refs';
import { docKeyForDocId } from '../../../src/main/features/meeting_doc';
import { userCloudRoot, userLocalRoot, userMeetingRefsDir } from '../../../src/main/paths';

vi.mock('../../../src/main/features/recall/asset-service', () => ({
  readAbilityAsset: vi.fn(),
}));

// 【T045】零模型调用护栏:组装函数是确定性的,任何模型入口都不该被碰到。
// 挂在这里的 spy 一旦被调用(实现错误地引入模型),下面的用例就会抓住。
vi.mock('../../../src/main/features/transcript_llm_candidates', () => ({
  generateReviewCandidates: vi.fn(async () => ({ candidates: [], skipped: 'no_model' })),
  LLM_CANDIDATE_MAX_HINTS: 32,
}));

const uid = 'u_meeting_conclusions_test';

/** 转写样例（块头时钟两段式，parseSource 可解析出 U0001/U0002）。 */
const TRANSCRIPT = [
  '子安 09:30',
  '下周发布 Cogseed 第二版',
  '牛保康 09:31',
  '定价策略需要再跟进一次',
].join('\n');
/** 转写正文里的密标（断言绝不落盘）。 */
const TRANSCRIPT_BODY_MARK = '正文密标NEVERPERSIST';

/** 最小可用资产记录（结构照 meeting_refs.test.ts 的同款夹具）。 */
function assetRecord(over: Partial<RecallAbilityAssetRecord> & { id: string }): RecallAbilityAssetRecord {
  return {
    maturity: 'effectiveness_validated',
    lifecycleStatus: 'user_confirmed_unverified',
    status: 'active',
    scope: 'personal',
    type: 'personal',
    title: over.title ?? '默认资产',
    version: '3',
    activeVersion: undefined,
    ...over,
  } as unknown as RecallAbilityAssetRecord;
}

const assets = new Map<string, RecallAbilityAssetRecord>();

function packFile(docId: string): string {
  return path.join(userMeetingRefsDir(uid), `${docKeyForDocId(docId)}.json`);
}

/** 整棵目录树快照（相对路径 → 文件内容），供「零副作用」读盘断言用。 */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

beforeEach(() => {
  fs.rmSync(userCloudRoot(uid), { recursive: true, force: true });
  fs.rmSync(userLocalRoot(uid), { recursive: true, force: true });
  assets.clear();
  assets.set('ast_cogseed', assetRecord({ id: 'ast_cogseed', title: 'Cogseed 术语表', version: '3', activeVersion: undefined }));
  vi.mocked(readAbilityAsset).mockImplementation(async (_targetUid: string, assetId: string) => {
    const record = assets.get(assetId);
    if (!record) throw new Error('recall ability asset not found');
    return record;
  });
});

// ── T034：纪要条目实体（id 确定性派生 / summary 有界 / confirm 零副作用）────────

describe('T034 ①：id 确定性派生 ⇒ 同输入两次同 id、不新增', () => {
  it('同输入两次 save ⇒ 同 id，list 仍只有一条（幂等 upsert）', () => {
    const input = {
      summary: '确定下周发布 Cogseed 第二版',
      transcriptRefs: [{ utteranceId: 'U0001', blockIndex: 0, from: 0, to: 6 }],
    };
    const first = saveMeetingConclusion(uid, 'kb/m.md', input);
    const second = saveMeetingConclusion(uid, 'kb/m.md', input);
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^mc_[0-9a-f]{12}$/);
    const list = listMeetingConclusions(uid, 'kb/m.md');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(first.id);
  });

  it('id 派生纯函数：同参同值；摘要不同 ⇒ 不同 id（归一化摘要参与派生）', () => {
    const base = { summary: '  结论  摘要  ', transcriptRefs: [{ utteranceId: 'U0001', blockIndex: 0, from: 0, to: 2 }] };
    expect(meetingConclusionIdFor('kb/a.md', base)).toBe(meetingConclusionIdFor('kb/a.md', base));
    expect(meetingConclusionIdFor('kb/a.md', base))
      .toBe(meetingConclusionIdFor('kb/a.md', { ...base, summary: '结论 摘要' }));   // 空白折叠后同键
    expect(meetingConclusionIdFor('kb/a.md', base))
      .not.toBe(meetingConclusionIdFor('kb/a.md', { ...base, summary: '另一个结论' }));
    expect(meetingConclusionIdFor('kb/a.md', base))
      .not.toBe(meetingConclusionIdFor('kb/b.md', base));                              // docId 参与派生
  });

  it('显式 id 被采用且同样幂等（同 id 再存 ⇒ 仍一条）；非法 id 被拒', () => {
    const saved = saveMeetingConclusion(uid, 'kb/m.md', { summary: '结论A' }, { id: 'mc_custom_1' });
    expect(saved.id).toBe('mc_custom_1');
    saveMeetingConclusion(uid, 'kb/m.md', { summary: '结论A' }, { id: 'mc_custom_1' });
    expect(listMeetingConclusions(uid, 'kb/m.md')).toHaveLength(1);
    expect(() => saveMeetingConclusion(uid, 'kb/m.md', { summary: 'x' }, { id: '非法 id!' }))
      .toThrowError(MeetingConclusionError);
  });

  it('upsert 保留 createdAt 与已确认状态（编辑不隐式改状态机）', async () => {
    const first = saveMeetingConclusion(uid, 'kb/m.md', { summary: '结论B' });
    await confirmMeetingConclusion(uid, 'kb/m.md', first.id);
    // 编辑走显式 id（摘要变了派生键也会变；编辑语义 = 同 id 覆盖内容）
    const edited = saveMeetingConclusion(uid, 'kb/m.md', { summary: '结论B（修订）' }, { id: first.id });
    expect(edited.id).toBe(first.id);
    expect(edited.status).toBe('confirmed');
    expect(edited.createdAt).toBe(first.createdAt);
    expect(edited.summary).toBe('结论B（修订）');
    expect(listMeetingConclusions(uid, 'kb/m.md')).toHaveLength(1);
  });
});

describe('T034 ②：summary ≤240 非空（空/超长被拒）', () => {
  it('空串/纯空白 ⇒ invalid_summary', () => {
    expect(() => saveMeetingConclusion(uid, 'kb/m.md', { summary: '' })).toThrowError(MeetingConclusionError);
    expect(() => saveMeetingConclusion(uid, 'kb/m.md', { summary: '   ' })).toThrowError(MeetingConclusionError);
    try {
      saveMeetingConclusion(uid, 'kb/m.md', { summary: '' });
    } catch (error) {
      expect((error as MeetingConclusionError).code).toBe('invalid_summary');
    }
  });

  it(`超长（${MAX_MEETING_CONCLUSION_SUMMARY + 1} 字）⇒ invalid_summary；恰 240 字可通过`, () => {
    expect(() => saveMeetingConclusion(uid, 'kb/m.md', { summary: '长'.repeat(MAX_MEETING_CONCLUSION_SUMMARY + 1) }))
      .toThrowError(/summary/i);
    const exact = saveMeetingConclusion(uid, 'kb/m.md', { summary: '长'.repeat(MAX_MEETING_CONCLUSION_SUMMARY) });
    expect(exact.summary).toHaveLength(MAX_MEETING_CONCLUSION_SUMMARY);
  });

  it('docId 不合法 ⇒ invalid_doc_id；非对象入参 ⇒ invalid_input', () => {
    expect(() => saveMeetingConclusion(uid, 'x'.repeat(1001), { summary: 'x' })).toThrowError(MeetingConclusionError);
    expect(() => saveMeetingConclusion(uid, 'kb/m.md', null as never)).toThrowError(MeetingConclusionError);
  });
});

describe('T034 ③：confirm 不产生任何候选/资产副作用（读盘断言）', () => {
  it('确认后：整棵用户树无新增文件、引用包 assetRefs 逐字未变、无 candidateId', async () => {
    await attachMeetingAsset(uid, 'kb/m.md', 'ast_cogseed');                     // 先有资产引用包
    const saved = saveMeetingConclusion(uid, 'kb/m.md', { summary: '结论C', assetRefs: ['ast_cogseed'] });

    const packBefore = fs.readFileSync(packFile('kb/m.md'), 'utf8');
    const cloudBefore = snapshotTree(userCloudRoot(uid));
    const localBefore = snapshotTree(userLocalRoot(uid));

    const confirmed = confirmMeetingConclusion(uid, 'kb/m.md', saved.id);
    expect(confirmed.status).toBe('confirmed');

    const cloudAfter = snapshotTree(userCloudRoot(uid));
    const localAfter = snapshotTree(userLocalRoot(uid));
    // 副作用断言①：候选/资产零写入 —— 整棵树没有新增（也没有消失）任何文件
    expect(Object.keys(cloudAfter).sort()).toEqual(Object.keys(cloudBefore).sort());
    expect(Object.keys(localAfter).sort()).toEqual(Object.keys(localBefore).sort());
    expect(localAfter).toEqual(localBefore);
    // 副作用断言②：引用包的 assetRefs 逐字未变（确认不动资产引用）
    const before = JSON.parse(packBefore) as { assetRefs: unknown[]; conclusions: Array<Record<string, unknown>> };
    const after = JSON.parse(fs.readFileSync(packFile('kb/m.md'), 'utf8')) as { assetRefs: unknown[]; conclusions: Array<Record<string, unknown>> };
    expect(after.assetRefs).toEqual(before.assetRefs);
    // 副作用断言③：条目本身只改 status/updatedAt；candidateId 键根本不存在
    expect(after.conclusions).toHaveLength(1);
    const strip = (c: Record<string, unknown>) => ({ ...c, status: null, updatedAt: null });
    expect(strip(after.conclusions[0])).toEqual(strip(before.conclusions[0]));
    expect(after.conclusions[0].status).toBe('confirmed');
    expect(after.conclusions[0]).not.toHaveProperty('candidateId');
    expect(after.conclusions[0]).not.toHaveProperty('precipitatedAt');
  });

  it('confirm 状态迁移与幂等：draft→confirmed；再 confirm 原样返回；不存在/非法 id 拒绝', () => {
    const saved = saveMeetingConclusion(uid, 'kb/m.md', { summary: '结论D' });
    const again = confirmMeetingConclusion(uid, 'kb/m.md', saved.id);
    expect(again.status).toBe('confirmed');
    const third = confirmMeetingConclusion(uid, 'kb/m.md', saved.id);            // 幂等，不报错
    expect(third.status).toBe('confirmed');
    expect(() => confirmMeetingConclusion(uid, 'kb/m.md', 'mc_nope')).toThrowError(/not found/i);
    expect(() => confirmMeetingConclusion(uid, 'kb/m.md', '')).toThrowError(MeetingConclusionError);
  });
});

// ── T035：双引用装配（锚点字段齐 + assetRefs 同一份冻结 + 不存正文）────────────

describe('T035：transcriptRefs 段落锚点（U0001 体系）', () => {
  it('锚点字段齐：{utteranceId, blockIndex, from, to} 恰四键，值原样落盘', () => {
    const saved = saveMeetingConclusion(uid, 'kb/a.md', {
      summary: '发布结论',
      transcriptRefs: [{ utteranceId: 'U0002', blockIndex: 1, from: 3, to: 9 }],
    }, { text: TRANSCRIPT });
    expect(saved.transcriptRefs).toEqual([{ utteranceId: 'U0002', blockIndex: 1, from: 3, to: 9 }]);
    expect(Object.keys(saved.transcriptRefs[0]).sort()).toEqual(['blockIndex', 'from', 'to', 'utteranceId']);
    const onDisk = JSON.parse(fs.readFileSync(packFile('kb/a.md'), 'utf8'));
    expect(onDisk.conclusions[0].transcriptRefs).toEqual(saved.transcriptRefs);
  });

  it('锚点形状不合法 ⇒ invalid_anchor（schema 错该报就报；解析不到才走降级）', () => {
    expect(() => saveMeetingConclusion(uid, 'kb/a.md', {
      summary: 'x', transcriptRefs: [{ utteranceId: 'X1', blockIndex: 0, from: 0, to: 2 }] as never,
    })).toThrowError(MeetingConclusionError);
    expect(() => saveMeetingConclusion(uid, 'kb/a.md', {
      summary: 'x', transcriptRefs: [{ utteranceId: 'U0001', blockIndex: -1, from: 0, to: 2 }],
    })).toThrowError(/anchor/i);
    expect(() => saveMeetingConclusion(uid, 'kb/a.md', {
      summary: 'x', transcriptRefs: [{ utteranceId: 'U0001', blockIndex: 0, from: 5, to: 5 }],
    })).toThrowError(/anchor/i);
  });
});

describe('T035：assetRefs 从本文件的引用包取（同一份冻结）', () => {
  it('conclusion.assetRefs[].version === 挂载时冻结版（资产事后升版/改名不影响）', async () => {
    assets.set('ast_a', assetRecord({ id: 'ast_a', title: '术语资产', version: '3', activeVersion: undefined }));
    await attachMeetingAsset(uid, 'kb/b.md', 'ast_a');                           // 挂载时冻结 v3
    // 会后：资产升到 v9 并改名（引用包不动，结论要从同一份冻结取）
    assets.set('ast_a', assetRecord({ id: 'ast_a', title: '术语资产（新版）', version: '3', activeVersion: '9' }));
    const saved = saveMeetingConclusion(uid, 'kb/b.md', { summary: '引用结论', assetRefs: ['ast_a'] });
    expect(saved.assetRefs).toEqual([{ assetId: 'ast_a', version: '3', title: '术语资产', type: 'personal' }]);
    // 与引用包逐字同一份冻结
    const pack = JSON.parse(fs.readFileSync(packFile('kb/b.md'), 'utf8'));
    expect(saved.assetRefs[0].version).toBe(pack.assetRefs[0].version);
    expect(saved.assetRefs[0].title).toBe(pack.assetRefs[0].title);
  });

  it('不在引用包里的 assetId ⇒ 如实跳过（不造引用；挂载是 attach 的职责）', async () => {
    const saved = saveMeetingConclusion(uid, 'kb/b.md', { summary: '无引用结论', assetRefs: ['ast_not_mounted'] });
    expect(saved.assetRefs).toEqual([]);
  });

  it('引用包侧后续 attach/detach 不丢 conclusions（同文件共存，双向不破坏）', async () => {
    const saved = saveMeetingConclusion(uid, 'kb/c.md', { summary: '共存结论' });
    await attachMeetingAsset(uid, 'kb/c.md', 'ast_cogseed');
    let pack = JSON.parse(fs.readFileSync(packFile('kb/c.md'), 'utf8'));
    expect(pack.conclusions).toHaveLength(1);
    expect(pack.conclusions[0].id).toBe(saved.id);
    expect(pack.assetRefs).toHaveLength(1);
    // 再存一条（走引用包已存在的路径），assetRefs 原样保留
    const second = saveMeetingConclusion(uid, 'kb/c.md', { summary: '第二条', assetRefs: ['ast_cogseed'] });
    pack = JSON.parse(fs.readFileSync(packFile('kb/c.md'), 'utf8'));
    expect(pack.conclusions).toHaveLength(2);
    expect(second.assetRefs[0].version).toBe('3');
    expect(pack.assetRefs).toHaveLength(1);
  });
});

describe('T035：读盘断言——记录内不含转写正文与资产正文', () => {
  it('text（含密标）只进不出；资产 statement 密标不落盘；摘要 ≤240', async () => {
    const record = assetRecord({ id: 'ast_body', title: 'T', version: '1' });
    (record as unknown as { statement: string }).statement = '资产正文密标ASSETBODY-NEVER';
    assets.set('ast_body', record);
    await attachMeetingAsset(uid, 'kb/d.md', 'ast_body');
    const textWithMark = TRANSCRIPT.replace('定价策略需要再跟进一次', `定价策略需要再跟进一次，${TRANSCRIPT_BODY_MARK}`);
    saveMeetingConclusion(uid, 'kb/d.md', {
      summary: '含密标转写的结论',
      transcriptRefs: [{ utteranceId: 'U0001', blockIndex: 0, from: 0, to: 6 }],
      assetRefs: ['ast_body'],
    }, { text: textWithMark });

    const raw = fs.readFileSync(packFile('kb/d.md'), 'utf8');
    expect(raw).not.toContain(TRANSCRIPT_BODY_MARK);      // 转写正文不落盘
    expect(raw).not.toContain('资产正文密标');             // 资产正文（statement）不落盘
    expect(raw).not.toContain('下周发布');                  // 转写原文片段不落盘（只有锚点）
    const body = JSON.parse(raw) as { conclusions: Array<{ summary: string }> };
    expect(body.conclusions).toHaveLength(1);
    for (const c of body.conclusions) {
      expect(Array.from(c.summary).length).toBeLessThanOrEqual(MAX_MEETING_CONCLUSION_SUMMARY);
    }
  });
});

// ── T036：锚点解析与降级（旧数据降级为不可关联，不报错）──────────────────────

describe('T036：降级三态（条目照常可读）', () => {
  it('① 无锚点记录 ⇒ 不抛错、unlinkable === no_transcript_ref', () => {
    const saved = saveMeetingConclusion(uid, 'kb/e.md', { summary: '无锚点结论' });
    expect(saved.unlinkable).toBe('no_transcript_ref');
    const list = listMeetingConclusions(uid, 'kb/e.md');                          // 照常可读
    expect(list).toHaveLength(1);
    expect(list[0].unlinkable).toBe('no_transcript_ref');
    expect(list[0].summary).toBe('无锚点结论');
  });

  it('② 手工造旧记录 ⇒ legacy_record，且 list 只读不改写存量', () => {
    const file = packFile('kb/f.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      docId: 'kb/f.md',
      assetRefs: [],
      conclusions: [{
        id: 'old1',
        docId: 'kb/f.md',
        summary: '手造旧纪要',
        status: 'confirmed',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }), 'utf8');

    const list = listMeetingConclusions(uid, 'kb/f.md');                         // 不抛错
    expect(list).toHaveLength(1);
    expect(list[0].unlinkable).toBe('legacy_record');
    expect(list[0].summary).toBe('手造旧纪要');
    expect(list[0].status).toBe('confirmed');
    // 读侧不回写：旧记录原样在盘上（没有偷偷补 unlinkable）
    expect((JSON.parse(fs.readFileSync(file, 'utf8')).conclusions[0] as Record<string, unknown>))
      .not.toHaveProperty('unlinkable');
  });

  it('③ 正常记录（锚点可解析）⇒ unlinkable 键缺失', () => {
    saveMeetingConclusion(uid, 'kb/g.md', {
      summary: '正常结论',
      transcriptRefs: [{ utteranceId: 'U0001', blockIndex: 0, from: 0, to: 6 }],
    }, { text: TRANSCRIPT });
    const [one] = listMeetingConclusions(uid, 'kb/g.md');
    expect(one.transcriptRefs).toHaveLength(1);
    expect('unlinkable' in one).toBe(false);
    expect(one.unlinkable).toBeUndefined();
  });

  it('锚点解析不到 ⇒ anchor_not_found（不抛错，条目照常可读）', () => {
    const saved = saveMeetingConclusion(uid, 'kb/h.md', {
      summary: '解析不到的结论',
      transcriptRefs: [{ utteranceId: 'U9999', blockIndex: 99, from: 0, to: 3 }],
    }, { text: TRANSCRIPT });
    expect(saved.unlinkable).toBe('anchor_not_found');
    const [one] = listMeetingConclusions(uid, 'kb/h.md');                        // 照常可读
    expect(one.unlinkable).toBe('anchor_not_found');
    expect(one.transcriptRefs).toHaveLength(1);                                  // 锚点原样保留（不猜、不删）
  });

  it('解析辅助：id/偏移任一失配即 unresolved；可解析的锚点返回空', () => {
    expect(unresolvedMeetingAnchorIds(TRANSCRIPT, [
      { utteranceId: 'U0001', blockIndex: 0, from: 0, to: 6 },
    ])).toEqual([]);
    expect(unresolvedMeetingAnchorIds(TRANSCRIPT, [
      { utteranceId: 'U9999', blockIndex: 99, from: 0, to: 3 },                 // 无该段
      { utteranceId: 'U0001', blockIndex: 0, from: 0, to: 99999 },              // 偏移越界
    ])).toEqual(['U9999', 'U0001']);
    expect(unresolvedMeetingAnchorIds('', [{ utteranceId: 'U0001', blockIndex: 0, from: 0, to: 1 }]))
      .toEqual(['U0001']);                                                       // 空文档 ⇒ 解析不到
  });

  it('save 不传 text ⇒ 不做解析判定（不编造 anchor_not_found）', () => {
    const saved = saveMeetingConclusion(uid, 'kb/i.md', {
      summary: '未传正文',
      transcriptRefs: [{ utteranceId: 'U0001', blockIndex: 0, from: 0, to: 6 }],
    });
    expect('unlinkable' in saved).toBe(false);
  });
});

// ── T045：结论→候选的确定性组装（单一函数出口，零模型调用）──────────────────

describe('T045：buildConclusionCandidateInput 确定性组装', () => {
  /** 组装用结论（不落盘——纯函数直接吃 MeetingConclusion）。 */
  const sample = (over: Partial<MeetingConclusion> = {}): MeetingConclusion => ({
    id: 'mc_abc123def456',
    docId: 'kb/meet.md',
    summary: '确定下周发布 Cogseed 第二版',
    transcriptRefs: [
      { utteranceId: 'U0001', blockIndex: 0, from: 0, to: 6 },
      { utteranceId: 'U0002', blockIndex: 1, from: 3, to: 9 },
    ],
    assetRefs: [],
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('字段齐：judgment=摘要、缺省不带 value 键、type/scope 缺省 personal、action=create', () => {
    const input = buildConclusionCandidateInput(sample(), { docId: 'kb/meet.md', title: '站会', sourceVersion: '1770000000' });
    expect(input.judgment).toBe('确定下周发布 Cogseed 第二版');
    expect(Object.prototype.hasOwnProperty.call(input, 'value')).toBe(false);   // 缺省不带键（交给 saveRecallCandidate 兜底）
    expect(input.suggestedType).toBe('personal');
    expect(input.suggestedScope).toBe('personal');
    expect(input.suggestedAction).toBe('create');
  });

  it('sourceRefs 恰 1 条 artifact_file/context_file，id 与 cognitionContextFileSourceId 同源', () => {
    const input = buildConclusionCandidateInput(sample(), { docId: 'kb/meet.md', title: '站会', sourceVersion: '1770000000' });
    expect(input.sourceRefs).toHaveLength(1);
    const ref = input.sourceRefs[0] as Record<string, unknown>;
    expect(ref.kind).toBe('artifact_file');
    expect(ref.subtype).toBe('context_file');
    // 与 source-catalog.ts:129-131 的同一出处逐字一致（不另起一套 id 算法）
    expect(ref.id).toBe(cognitionContextFileSourceId('kb/meet.md'));
    expect(ref.title).toBe('站会');
    expect(ref.sourceVersion).toBe('1770000000');
  });

  it('sourceVersion 缺省不写键（不编造版本）；title 缺省从 docId 派生文件名', () => {
    const input = buildConclusionCandidateInput(sample(), { docId: 'kb/deep/nested.md' });
    expect(Object.prototype.hasOwnProperty.call(input.sourceRefs[0], 'sourceVersion')).toBe(false);
    expect((input.sourceRefs[0] as Record<string, unknown>).title).toBe('nested.md');
  });

  it('evidenceRefs 每锚点一条：title 定位描述含 utteranceId、excerpt=摘要 ≤240、不含转写正文', () => {
    const input = buildConclusionCandidateInput(sample(), { docId: 'kb/meet.md', title: '站会' });
    expect(input.evidenceRefs).toHaveLength(2);
    const titles = input.evidenceRefs.map((r) => (r as Record<string, unknown>).title);
    expect(titles[0]).toContain('U0001');
    expect(titles[1]).toContain('U0002');
    for (const ref of input.evidenceRefs as Array<Record<string, unknown>>) {
      expect(ref.id).toBe(cognitionContextFileSourceId('kb/meet.md'));
      const excerpt = String(ref.excerpt ?? '');
      expect(excerpt).toBe('确定下周发布 Cogseed 第二版');
      expect(Array.from(excerpt).length).toBeLessThanOrEqual(240);
    }
    // 双引用纪律：组装输出整体不含转写正文（原文/块头都不进候选）
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain('定价策略需要再跟进一次');
    expect(serialized).not.toContain('子安 09:30');
  });

  it('无锚点 ⇒ evidenceRefs 空数组（候选将落 weak_observation——如实行为，不是缺陷）', () => {
    const input = buildConclusionCandidateInput(sample({ transcriptRefs: [] }), { docId: 'kb/meet.md' });
    expect(input.evidenceRefs).toEqual([]);
    expect(input.sourceRefs).toHaveLength(1);                                   // 文档来源仍在
  });

  it('captureKey 稳定且形态 mtg-<hex>：同输入同值；docId/conclusionId 变 ⇒ 变', () => {
    const first = buildConclusionCandidateInput(sample(), { docId: 'kb/meet.md' });
    const second = buildConclusionCandidateInput(sample(), { docId: 'kb/meet.md', title: '另一个标题' });
    expect(second.captureKey).toBe(first.captureKey);                           // 组装稳定（标题不参与键）
    expect(first.captureKey).toBe(conclusionCaptureKey('kb/meet.md', 'mc_abc123def456'));
    expect(first.captureKey).toMatch(/^mtg-[0-9a-f]+$/);
    expect(conclusionCaptureKey('kb/other.md', 'mc_abc123def456')).not.toBe(first.captureKey);
    expect(conclusionCaptureKey('kb/meet.md', 'mc_other')).not.toBe(first.captureKey);
  });

  it('origin 不在组装输出；经既有 saveRecallCandidate 落盘后派生为 capture（并读回候选）', async () => {
    const input = buildConclusionCandidateInput(sample(), { docId: 'kb/meet.md', title: '站会' });
    expect(Object.prototype.hasOwnProperty.call(input, 'origin')).toBe(false);  // 不传 origin（纪律：由既有函数派生）
    const candidate = await saveRecallCandidate(uid, input);
    expect(candidate.captureKey).toBe(input.captureKey);
    expect(candidate.origin).toBe('capture');                                   // deriveCandidateOrigin 依 captureKey 派生
    const listed = await listRecallCandidates(uid);
    expect(listed.filter((c) => c.captureKey === input.captureKey)).toHaveLength(1);
  });

  it('overrides 生效：judgment/value/suggestedType/suggestedScope/applicableWhen 透传；空 value 不带键', () => {
    const input = buildConclusionCandidateInput(sample(), { docId: 'kb/meet.md' }, {
      judgment: '自定义判断',
      value: '   ',
      suggestedType: 'rule',
      suggestedScope: 'project',
      applicableWhen: ['周会结论'],
    });
    expect(input.judgment).toBe('自定义判断');
    expect(Object.prototype.hasOwnProperty.call(input, 'value')).toBe(false);   // 纯空白 value 不带键
    expect(input.suggestedType).toBe('rule');
    expect(input.suggestedScope).toBe('project');
    expect(input.applicableWhen).toEqual(['周会结论']);
  });

  it('零模型调用（spy 计数 0）：组装是纯同步函数，不触任何模型入口', async () => {
    const { generateReviewCandidates } = await import('../../../src/main/features/transcript_llm_candidates');
    buildConclusionCandidateInput(sample(), { docId: 'kb/meet.md' });
    expect(generateReviewCandidates).not.toHaveBeenCalled();
  });
});
