/**
 * transcript_glossary — 词表模型/归一化/风险分级/迁移/台账
 *
 * 重点覆盖（对齐 AGENTS「测业务不变量、恢复路径、文本陷阱」）：
 *   - 全角/大小写归一化后仍能 1:1 定位（否则扫描器 span 会整体错位）；
 *   - 高危短词分级（真实事故：`for`/`model`/`cloud` 这类合法英文词被全局替换）；
 *   - 纯数字变体 / 单姓敬称拒绝入册（真实事故：姓氏变体被当全局规则）；
 *   - v1→v2 迁移（老方案文件不能被读成空表）；
 *   - uid 不匹配、JSON 损坏时的降级路径；
 *   - 台账只追加（改写台账 = 审计失效）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import {
  deriveRiskLevel,
  defaultBoundary,
  entryId,
  exportGlossary,
  findEntry,
  foldText,
  importGlossary,
  isPureDigits,
  isSingleSurnameHonorific,
  listEntries,
  listCandidates,
  countPendingCandidates,
  loadGlossary,
  markVerified,
  migrateGlossaryV1ToV2,
  addContextAllow,
  adoptCandidate,
  clearCandidates,
  discardCandidate,
  recordCandidates,
  recordReplacement,
  removeContextAllow,
  retargetEntry,
  setIgnored,
  setScope,
  saveGlossary,
  setEntryStatus,
  deleteEntry,
  upsertEntry,
} from '../../../src/main/features/transcript_glossary';
import { scanText } from '../../../src/main/features/transcript_auto_correct';
import { userTranscriptGlossaryFile } from '../../../src/main/paths';

let uid = '';
beforeEach(() => {
  uid = `u_glossary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe('归一化与索引对齐', () => {
  it('折叠后长度与原串一致（span 定位的前提）', () => {
    for (const text of ['ｃｏｘｙ', 'COXY', 'Cogseed 与 K star', '　　全角空格ＡＢ１２']) {
      expect(foldText(text).length).toBe(text.length);
    }
  });

  it('全角/大小写折叠后等价', () => {
    expect(foldText('ＣＯＸＹ')).toBe('coxy');
    expect(foldText('CoXy')).toBe('coxy');
  });
});

describe('删除类词条（口癖）的存读往返', () => {
  it('correct 为空的 delete 词条必须能存能读（曾经被读盘校验丢掉，只剩最后一条）', () => {
    for (const term of ['嗯', '呃', '啊', '哦', '这个', '那个', '的话', '就是', '然后', '对']) {
      upsertEntry(uid, { wrong: term, action: 'delete', kind: 'filler', boundary: 'substring', source: 'import' });
    }
    const fillers = listEntries(uid, { kind: 'filler' });
    expect(fillers).toHaveLength(10);
    expect(fillers.every((e) => e.action === 'delete' && e.correct === '')).toBe(true);
    // 重新读盘一次仍然在（写一次覆盖一次的 bug 就藏在这条断言后面）
    expect(loadGlossary(uid).entries.filter((e) => e.action === 'delete')).toHaveLength(10);
  });

  it('replace 词条缺正确写法仍然是脏数据（不能被放进词表）', () => {
    const entry = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    const file = loadGlossary(uid);
    const broken = { ...file, entries: [...file.entries, { ...entry, id: 'g_broken', correct: '' }] };
    saveGlossary(uid, broken);
    expect(loadGlossary(uid).entries.some((e) => e.id === 'g_broken')).toBe(false);
  });
});

describe('写法对齐（本体规范名覆盖词表写法）', () => {
  it('只改 correct，重算风险；wrong/台账/频次一律不动', () => {
    const created = upsertEntry(uid, { wrong: 'kstar', correct: 'K star', kind: 'term' }).entry!;
    recordReplacement(uid, [created.id], { docId: 'd1', runId: 'r1' });
    const before = findEntry(uid, created.id)!;
    const after = retargetEntry(uid, created.id, 'KSTAR')!;
    expect(after.correct).toBe('KSTAR');
    expect(after.wrong).toBe(before.wrong);
    expect(after.freq).toBe(before.freq);
    expect(after.replacedIn).toEqual(before.replacedIn);
    expect(after.source).toBe(before.source);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('同一个错形出现两种写法时 → 改完自动升为 high（同错不同正的风险）', () => {
    const a = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    // 折叠后不同才算"另一种写法"（`CogSeed` 与 `Cogseed` 折叠等价 → 是同一条）
    upsertEntry(uid, { wrong: 'coxy', correct: 'Coseed' });
    expect(retargetEntry(uid, a.id, 'Cogseed Studio')!.riskLevel).toBe('high');
  });

  it('改成空值报错；未知 id 返回 null；写法未变则原样返回不写盘', () => {
    const entry = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    expect(() => retargetEntry(uid, entry.id, '   ')).toThrow();
    expect(retargetEntry(uid, 'g_missing', 'X')).toBeNull();
    expect(retargetEntry(uid, entry.id, 'Cogseed')!.correct).toBe('Cogseed');
  });
});

describe('接受的三个动作（范围 / 忽略 / 加白）', () => {
  it('范围：限本文档 / 限本场景，全局只给非高危', () => {
    const a = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    const risky = upsertEntry(uid, { wrong: 'model', correct: 'Moodle', riskLevel: 'high' }).entry!;

    expect(setScope(uid, [a.id], { choice: 'doc', docId: 'doc-1' }).updated).toBe(1);
    expect(findEntry(uid, a.id)!.scope).toEqual({ docIds: ['doc-1'], scenarioTags: [], global: false });

    expect(setScope(uid, [a.id], { choice: 'task', scenarioTags: ['组会'] }).updated).toBe(1);
    expect(findEntry(uid, a.id)!.scope).toEqual({ docIds: [], scenarioTags: ['组会'], global: false });

    // 高危词条拒绝全局：拒绝项如实回报，且原作用域不变（方案 §2.2 红线）
    const before = findEntry(uid, risky.id)!.scope;
    const refused = setScope(uid, [a.id, risky.id], { choice: 'global' });
    expect(refused.updated).toBe(1);
    expect(refused.refused).toEqual([{ id: risky.id, wrong: 'model', reason: 'high_risk_cannot_global' }]);
    expect(findEntry(uid, risky.id)!.scope).toEqual(before);
    expect(findEntry(uid, a.id)!.scope.global).toBe(true);
  });

  it('范围：缺 docId/场景标签时抛错，不静默降级', () => {
    const a = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    expect(() => setScope(uid, [a.id], { choice: 'doc' })).toThrow();
    expect(() => setScope(uid, [a.id], { choice: 'task', scenarioTags: [] })).toThrow();
    expect(setScope(uid, [a.id], { choice: 'keep' })).toEqual({ updated: 0, refused: [] });
  });

  it('忽略可逆且留痕：不删词条、不动台账与频次', () => {
    const entry = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    recordReplacement(uid, [entry.id], { docId: 'd1', runId: 'r1' });
    const before = findEntry(uid, entry.id)!;
    expect(setIgnored(uid, [entry.id], true)).toBe(1);
    const ignored = findEntry(uid, entry.id)!;
    expect(ignored.ignoredCount).toBe(1);
    expect(ignored.freq).toBe(before.freq);
    expect(ignored.replacedIn).toEqual(before.replacedIn);

    expect(setIgnored(uid, [entry.id], false)).toBe(1);
    // 恢复 = 删键，不在用户文件里留 0
    expect(findEntry(uid, entry.id)!.ignoredCount).toBeUndefined();
    expect(findEntry(uid, entry.id)!.ignoredAt).toBeUndefined();
  });

  it('加白去重、截断，且不改动黑名单', () => {
    const entry = upsertEntry(uid, { wrong: 'model', correct: 'Moodle', contextDeny: ['模型'] }).entry!;
    expect(addContextAllow(uid, [entry.id], '产品模型')).toBe(1);
    expect(addContextAllow(uid, [entry.id], '产品模型')).toBe(0); // 重复不加
    const after = findEntry(uid, entry.id)!;
    expect(after.contextAllow).toEqual(['产品模型']);
    expect(after.contextDeny).toEqual(['模型']);
    expect(() => addContextAllow(uid, [entry.id], '   ')).toThrow();

    // 白名单必须能撤（静默候选 = 只进不出会变成黑洞）
    expect(removeContextAllow(uid, [entry.id], '产品模型')).toBe(1);
    expect(findEntry(uid, entry.id)!.contextAllow).toEqual([]);
    expect(removeContextAllow(uid, [entry.id], '产品模型')).toBe(0);
  });
});

describe('风险分级', () => {
  it('高危短词与介词级 token → high', () => {
    for (const wrong of ['for', 'model', 'contact', 'redmi', 'cloud']) {
      expect(deriveRiskLevel({ wrong, correct: 'X', action: 'replace' })).toBe('high');
    }
  });

  it('生造产品词 → low', () => {
    expect(deriveRiskLevel({ wrong: 'coxy', correct: 'Cogseed', action: 'replace' })).toBe('low');
    expect(deriveRiskLevel({ wrong: '示例人物', correct: 'SpeakerA', action: 'replace' })).toBe('low');
  });

  it('单姓敬称 / 纯数字 / 显式 partial → high 或拒绝', () => {
    expect(deriveRiskLevel({ wrong: '朱老师', correct: '朱明', action: 'replace' })).toBe('high');
    expect(isSingleSurnameHonorific('王总')).toBe(true);
    expect(isSingleSurnameHonorific('王总工')).toBe(false);
    expect(isPureDigits('20231080000006')).toBe(true);
    expect(isPureDigits('k42')).toBe(false);
    expect(deriveRiskLevel({ wrong: 'Coco', correct: 'Cogseed', action: 'replace', partial: true })).toBe('high');
  });

  it('同 wrong 多 correct → high（禁止静默全局替换）', () => {
    expect(deriveRiskLevel(
      { wrong: 'kstar', correct: 'KSTAR', action: 'replace' },
      { otherCorrects: ['K-Star'] },
    )).toBe('high');
  });

  it('删除类（口癖）不按短词升级', () => {
    expect(deriveRiskLevel({ wrong: '啊', correct: '', action: 'delete' })).toBe('low');
  });

  it('边界模式按形态推导', () => {
    expect(defaultBoundary('coxy', 'replace')).toBe('word');
    expect(defaultBoundary('K 星', 'replace')).toBe('substring');
    expect(defaultBoundary('啊', 'delete')).toBe('substring');
  });
});

describe('CRUD 与不变量', () => {
  it('新增 → 列表可见，同 wrong+correct 幂等更新且保留 freq/createdAt', () => {
    const first = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    expect(first.created).toBe(true);
    expect(first.entry?.riskLevel).toBe('low');

    recordReplacement(uid, [first.entry!.id], { docId: 'doc1', runId: 'run_a' });
    const before = findEntry(uid, first.entry!.id)!;
    expect(before.freq).toBe(1);

    const second = upsertEntry(uid, { wrong: 'COXY', correct: 'Cogseed' });
    expect(second.created).toBe(false);
    expect(second.entry?.id).toBe(first.entry?.id);
    expect(second.entry?.freq).toBe(1);
    expect(second.entry?.createdAt).toBe(before.createdAt);
    expect(listEntries(uid)).toHaveLength(1);
  });

  it('纯数字变体拒绝入册', () => {
    const res = upsertEntry(uid, { wrong: '20231080000006', correct: '某学号' });
    expect(res.entry).toBeNull();
    expect(res.skippedReason).toBe('pure_digit_variant');
    expect(listEntries(uid)).toHaveLength(0);
  });

  it('manual 词条默认全局；meeting_accept 默认只在本次文档生效', () => {
    const manual = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    expect(manual.entry?.scope.global).toBe(true);

    const meeting = upsertEntry(uid, {
      wrong: '示例人物', correct: 'SpeakerA', source: 'meeting_accept',
      scope: { docIds: ['doc-2026-09-05'], scenarioTags: [], global: false },
    });
    expect(meeting.entry?.scope.global).toBe(false);
    expect(meeting.entry?.scope.docIds).toEqual(['doc-2026-09-05']);
  });

  it('状态切换 / 删除 / 标记复核时间', () => {
    const e = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    expect(setEntryStatus(uid, e.id, 'paused')?.status).toBe('paused');
    expect(listEntries(uid, { status: 'active' })).toHaveLength(0);
    expect(markVerified(uid, e.id, 123)?.lastVerifiedAt).toBe(123);
    expect(deleteEntry(uid, e.id)).toBe(true);
    expect(deleteEntry(uid, e.id)).toBe(false);
  });

  it('台账只追加：两次替换留两条记录，freq 累加', () => {
    const e = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    recordReplacement(uid, [e.id], { docId: 'doc1', runId: 'run_a' });
    recordReplacement(uid, [e.id], { docId: 'doc1', runId: 'run_b' });
    const after = findEntry(uid, e.id)!;
    expect(after.replacedIn.map((r) => r.runId)).toEqual(['run_a', 'run_b']);
    expect(after.freq).toBe(2);
  });

  it('不存在的词条 id 不影响其它词条', () => {
    const e = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' }).entry!;
    recordReplacement(uid, ['g_missing'], { docId: 'd', runId: 'r' });
    expect(findEntry(uid, e.id)?.freq).toBe(0);
  });
});

describe('迁移与降级', () => {
  it('v1 文件 → 当前版本（补作用域/风险/台账/候选区，且落盘为新版本）', () => {
    const v1 = {
      version: 1,
      entries: [
        { id: 'g_old', wrong: 'coxy', correct: 'CogSeed', kind: 'product', scenarioTags: ['组会'], freq: 3, source: 'manual', status: 'active', ownerScope: 'personal', createdAt: 1, updatedAt: 2 },
        { id: 'g_bad' },
      ],
      meta: { lastReconcileAt: 9 },
    };
    fs.mkdirSync(require('node:path').dirname(userTranscriptGlossaryFile(uid)), { recursive: true });
    fs.writeFileSync(userTranscriptGlossaryFile(uid), JSON.stringify(v1), 'utf8');

    const loaded = loadGlossary(uid);
    // 当前文件版本 = 3（v2 加了候选区）。老文件升到新版本，但**不造占位候选**。
    expect(loaded.version).toBe(3);
    expect(loaded.candidates).toEqual([]);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].action).toBe('replace');
    expect(loaded.entries[0].scope.global).toBe(true);
    expect(loaded.entries[0].scope.scenarioTags).toEqual(['组会']);
    expect(loaded.entries[0].replacedIn).toEqual([]);
    expect(loaded.meta.lastReconcileAt).toBe(9);
    expect(JSON.parse(fs.readFileSync(userTranscriptGlossaryFile(uid), 'utf8')).version).toBe(3);
  });

  it('纯函数迁移不依赖磁盘', () => {
    const migrated = migrateGlossaryV1ToV2({ entries: [{ wrong: 'a', correct: 'b', scenarioTags: ['部分语境'] }] }, 'u1');
    expect(migrated.entries[0].riskLevel).toBe('high');
    expect(migrated.uid).toBe('u1');
  });

  it('uid 不匹配的文件被忽略（防拷错目录把别人的词表当自己的）', () => {
    const foreign = { version: 2, uid: 'u_someone_else', entries: [], meta: { lastReconcileAt: 0, ownerNote: '' } };
    fs.mkdirSync(require('node:path').dirname(userTranscriptGlossaryFile(uid)), { recursive: true });
    fs.writeFileSync(userTranscriptGlossaryFile(uid), JSON.stringify(foreign), 'utf8');
    expect(loadGlossary(uid).entries).toHaveLength(0);
  });

  it('JSON 损坏 → 降级空表且不抛错', () => {
    fs.mkdirSync(require('node:path').dirname(userTranscriptGlossaryFile(uid)), { recursive: true });
    fs.writeFileSync(userTranscriptGlossaryFile(uid), '{not json', 'utf8');
    expect(() => loadGlossary(uid)).not.toThrow();
    expect(loadGlossary(uid).entries).toHaveLength(0);
  });

  it('落盘字段被手工改坏时逐字段收敛', () => {
    fs.mkdirSync(require('node:path').dirname(userTranscriptGlossaryFile(uid)), { recursive: true });
    fs.writeFileSync(userTranscriptGlossaryFile(uid), JSON.stringify({
      version: 2, uid,
      entries: [{ wrong: 'coxy', correct: 'Cogseed', kind: 'nonsense', riskLevel: 'whatever', scope: { global: 'yes' }, contextDeny: ['ok', 42, ''] }],
      meta: {},
    }), 'utf8');
    const entry = listEntries(uid)[0];
    expect(entry.kind).toBe('term');
    expect(entry.riskLevel).toBe('low');
    expect(entry.scope.global).toBe(false);
    expect(entry.contextDeny).toEqual(['ok']);
  });
});

describe('导入导出', () => {
  it('导出默认剔除人名类；includePeople 才导出', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    upsertEntry(uid, { wrong: '张旗康', correct: '张启康', kind: 'people' });
    expect(exportGlossary(uid).entries).toHaveLength(1);
    expect(exportGlossary(uid, { includePeople: true }).entries).toHaveLength(2);
  });

  it('merge 导入保留既有词条；replace 模式先清空', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    const bundle = { version: 2, entries: [{ wrong: '示例人物', correct: 'SpeakerA', kind: 'product' }] };
    expect(importGlossary(uid, bundle).imported).toBe(1);
    expect(listEntries(uid)).toHaveLength(2);
    expect(importGlossary(uid, bundle, { mode: 'replace' }).imported).toBe(1);
    expect(listEntries(uid)).toHaveLength(1);
    expect(listEntries(uid)[0].wrong).toBe('示例人物');
  });

  it('非法 payload 抛错而不是静默清空', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    expect(() => importGlossary(uid, { entries: 'nope' })).toThrow();
    expect(listEntries(uid)).toHaveLength(1);
  });
});

describe('entryId', () => {
  it('同 wrong+correct 稳定；correct 不同则不同（同形多解可并存）', () => {
    expect(entryId('coxy', 'Cogseed')).toBe(entryId('COXY', 'cogseed'));
    expect(entryId('kstar', 'KSTAR')).not.toBe(entryId('kstar', 'K-Star'));
  });

  it('保存时截断超量词条（上限保护）', () => {
    const file = loadGlossary(uid);
    file.entries = Array.from({ length: 2100 }, (_, i) => ({
      id: `g_${i}`, wrong: `w${i}`, correct: `c${i}`, action: 'replace' as const, kind: 'term' as const,
      riskLevel: 'low' as const, boundary: 'word' as const, contextDeny: [], scope: { docIds: [], scenarioTags: [], global: true },
      freq: 0, source: 'manual' as const, status: 'active' as const, ownerScope: 'personal' as const,
      replacedIn: [], createdBy: 'manual' as const, createdAt: 1, updatedAt: 1, lastVerifiedAt: 1,
    }));
    saveGlossary(uid, file);
    expect(loadGlossary(uid).entries.length).toBe(2000);
  });
});

/**
 * 候选区（模型候选）——本任务的核心不变量。
 *
 * 绊线测试：**模型候选绝不允许进入扫描**。哪天有人图省事把候选塞进
 * `entries`（或给 `scanText` 喂候选数组），下面第一条就会红。
 */
describe('模型候选区：只待核，不进扫描', () => {
  const cand = (wrong: string, correct: string, extra: Record<string, unknown> = {}) => ({
    wrong, correct, confidence: 0.9, reason: '读音相近', context: `…${wrong}…`, kind: 'people', ...extra,
  });

  it('绊线：候选落盘后，扫描结果、listEntries、导出包里都没有它', () => {
    recordCandidates(uid, [cand('roadmap', 'SpeakerA'), cand('coxyx', 'Cogseed')]);
    // 落盘了、也确实在候选区里
    expect(countPendingCandidates(uid)).toBe(2);
    // 但词的"生效"视图里一条都没有
    expect(listEntries(uid, { status: 'active' })).toEqual([]);
    expect(listEntries(uid)).toEqual([]);
    const scan = scanText('这块是 roadmap 在跟，语速有点快。', listEntries(uid, { status: 'active' }));
    expect(scan.candidates).toHaveLength(0);
    // 导出包只带词条，候选不外泄
    expect(exportGlossary(uid, { includePeople: true }).entries).toEqual([]);
    // 磁盘上候选与词条是两个数组：候选不可能被当成词条读回来
    const onDisk = JSON.parse(fs.readFileSync(userTranscriptGlossaryFile(uid), 'utf8'));
    expect(onDisk.version).toBe(3);
    expect(onDisk.candidates).toHaveLength(2);
    expect(onDisk.entries).toEqual([]);
  });

  it('候选也不会借 includePaused 之类的逃生口混进扫描（结构隔离，不靠 status 过滤）', () => {
    recordCandidates(uid, [cand('roadmap', 'SpeakerA')]);
    const entries = listEntries(uid, { status: 'active' });
    expect(scanText('这块是 roadmap 在跟', entries, { includePaused: true }).candidates).toHaveLength(0);
    // 即便有人把整个文件对象当 entries 传，候选数组也不是 GlossaryEntry[]
    const file = loadGlossary(uid);
    expect(file.candidates[0]).not.toHaveProperty('status');
    expect(file.candidates[0]).not.toHaveProperty('scope');
  });

  it('采纳是候选能影响扫描的唯一通道：采纳前 0 命中，采纳后才命中', () => {
    recordCandidates(uid, [cand('roadmap', 'SpeakerA')]);
    const before = listCandidates(uid, { state: 'pending' });
    expect(before).toHaveLength(1);
    expect(scanText('这块是 roadmap 在跟', listEntries(uid, { status: 'active' })).candidates).toHaveLength(0);

    const adopted = adoptCandidate(uid, before[0].id);
    expect(adopted.entry).not.toBeNull();
    expect(adopted.entry?.wrong).toBe('roadmap');
    // 人拍的板 → 按人工词条入册，并留下追溯链路
    expect(adopted.entry?.source).toBe('manual');
    expect(adopted.entry?.createdBy).toBe('manual');
    expect(adopted.candidate?.state).toBe('adopted');
    expect(adopted.candidate?.adoptedEntryId).toBe(adopted.entry?.id);

    const after = scanText('这块是 roadmap 在跟', listEntries(uid, { status: 'active' }));
    expect(after.candidates).toHaveLength(1);
    expect(after.candidates[0].correct).toBe('SpeakerA');
    // 采纳过的候选不再是待核
    expect(countPendingCandidates(uid)).toBe(0);
  });

  it('已经处理过的候选不能再采纳一次（终态不可回退）', () => {
    recordCandidates(uid, [cand('roadmap', 'SpeakerA'), cand('kstar', 'KSTAR')]);
    const target = listCandidates(uid, { state: 'pending' }).find((c) => c.wrong === 'roadmap')!;
    expect(adoptCandidate(uid, target.id).entry).not.toBeNull();
    // 已采纳 → 再点一次不该重复入册
    expect(adoptCandidate(uid, target.id)).toMatchObject({ entry: null, skippedReason: 'not_pending' });
    // 丢弃过的同样不可回退
    const second = listCandidates(uid, { state: 'pending' })[0];
    discardCandidate(uid, second.id);
    expect(adoptCandidate(uid, second.id)).toMatchObject({ entry: null, skippedReason: 'not_pending' });
    // 不存在的 id 如实回报，不静默成功
    expect(adoptCandidate(uid, 'c_not_exist')).toMatchObject({ entry: null, skippedReason: 'not_found' });
    expect(listEntries(uid, { status: 'active' })).toHaveLength(1);
  });

  it('丢弃是终态：模型下一轮再报同一对不会重新翻出来', () => {
    recordCandidates(uid, [cand('coxyx', 'Cogseed')]);
    const target = listCandidates(uid, { state: 'pending' })[0];
    expect(discardCandidate(uid, target.id)?.state).toBe('discarded');
    const again = recordCandidates(uid, [cand('coxyx', 'Cogseed')]);
    expect(again).toMatchObject({ added: 0, updated: 0, pending: 0 });
    expect(again.skipped[0]).toMatchObject({ why: 'already_discarded' });
    expect(listEntries(uid, { status: 'active' })).toEqual([]);
  });

  it('同一对重复上报只留一条，置信取更高的一次', () => {
    expect(recordCandidates(uid, [cand('roadmap', 'SpeakerA', { confidence: 0.5 })])).toMatchObject({ added: 1, pending: 1 });
    expect(recordCandidates(uid, [cand('ROADMAP', 'speakera', { confidence: 0.8 })])).toMatchObject({ added: 0, updated: 1, pending: 1 });
    const list = listCandidates(uid);
    expect(list).toHaveLength(1);
    expect(list[0].confidence).toBe(0.8);
  });

  it('挡掉：空目标 / 自反 / 纯数字变体 / 已在词表中的对', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    const result = recordCandidates(uid, [
      { wrong: '', correct: 'X' },
      cand('same', 'same'),
      cand('2024', 'Cogseed'),
      cand('coxy', 'Cogseed'),
    ]);
    expect(result.added).toBe(0);
    expect(result.skipped.map((s) => s.why)).toEqual([
      'empty_target', 'identical_pair', 'pure_digit_variant', 'already_in_glossary',
    ]);
  });

  it('落盘往返：候选的置信/理由/上下文/来源文档/是否名单外都保住', () => {
    recordCandidates(uid, [cand('roadmap', '某位老师', {
      confidence: 0.42, reason: '读音接近', context: '上下文片段', docId: 'doc_1',
      start: 12, inAllowlist: false,
    })]);
    const [saved] = listCandidates(uid, { state: 'pending' });
    expect(saved).toMatchObject({
      wrong: 'roadmap', correct: '某位老师', confidence: 0.42, reason: '读音接近',
      context: '上下文片段', docId: 'doc_1', start: 12, inAllowlist: false,
      kind: 'people', origin: 'llm', state: 'pending',
    });
    // 重新从磁盘读一遍（模拟重启）
    expect(listCandidates(uid, { state: 'pending' })[0].id).toBe(saved.id);
  });

  it('旧文件（v2，没有候选区）照常读得回来，不因缺字段丢词条', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    const file = userTranscriptGlossaryFile(uid);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.candidates;
    raw.version = 2;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
    const reloaded = loadGlossary(uid);
    expect(reloaded.candidates).toEqual([]);
    expect(reloaded.entries).toHaveLength(1);
  });

  it('候选区独立限长：候选再多也挤不掉词条', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    recordCandidates(uid, Array.from({ length: 600 }, (_, i) => cand(`w${i}`, `c${i}`)));
    expect(listEntries(uid, { status: 'active' })).toHaveLength(1);
    expect(listCandidates(uid).length).toBeLessThanOrEqual(500);
  });

  it('清空候选：默认只清终态，显式才连待核一起清', () => {
    recordCandidates(uid, [cand('a1', 'b1')]);
    const done = listCandidates(uid, { state: 'pending' })[0];
    adoptCandidate(uid, done.id);
    recordCandidates(uid, [cand('a2', 'b2')]);
    expect(clearCandidates(uid)).toBe(1);
    expect(countPendingCandidates(uid)).toBe(1);
    expect(clearCandidates(uid, { includePending: true })).toBe(1);
    expect(listCandidates(uid)).toEqual([]);
  });
});

describe('新词条默认作用域（不得静默成为全局规则）', () => {
  it('给了 docId → 仅本文档', () => {
    const created = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', source: 'manual', docId: 'doc-A' });
    expect(created.created).toBe(true);
    expect(created.entry!.scope).toEqual({ docIds: ['doc-A'], scenarioTags: [], global: false });
  });

  it('只给场景标签 → 仅本场景（空白标签被丢弃，保留会永久失配）', () => {
    const created = upsertEntry(uid, {
      wrong: 'kstar', correct: 'K star', source: 'manual', scenarioTags: ['教研会', '   '],
    });
    expect(created.entry!.scope).toEqual({ docIds: [], scenarioTags: ['教研会'], global: false });
  });

  it('docId 与标签都没有（如本体同步）才退到全局', () => {
    const created = upsertEntry(uid, { wrong: 'foo term', correct: 'Foo Term', source: 'ontology_seed' });
    expect(created.entry!.scope.global).toBe(true);
  });

  it('调用方显式给 scope 时以调用方为准', () => {
    const created = upsertEntry(uid, {
      wrong: 'bar term', correct: 'Bar Term', scope: { docIds: [], scenarioTags: ['x'], global: false },
    });
    expect(created.entry!.scope).toEqual({ docIds: [], scenarioTags: ['x'], global: false });
  });

  it('更新已有词条不因一次编辑就把作用域放宽成全局', () => {
    const first = upsertEntry(uid, { wrong: 'baz term', correct: 'Baz Term', docId: 'doc-A' }).entry!;
    expect(first.scope.global).toBe(false);
    // 同词条再 upsert 一次，且这次不带任何创建上下文
    const again = upsertEntry(uid, { wrong: 'baz term', correct: 'Baz Term' }).entry!;
    expect(again.id).toBe(first.id);
    expect(again.scope).toEqual({ docIds: ['doc-A'], scenarioTags: [], global: false });
  });
});
