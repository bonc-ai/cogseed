// 身份、发言与文件名均为合成测试样例；时间仅用于解析和顺序断言。
/**
 * transcript_glossary — 词表模型/归一化/风险分级/迁移/台账
 *
 * 使用合成身份与词条，覆盖以下数据契约：
 *   - 全角/大小写归一化后仍能 1:1 定位（否则扫描器 span 会整体错位）；
 *   - 高危短词分级（`for`/`model`/`cloud` 等合法英文词不能被静默全局替换）；
 *   - 纯数字变体 / 单姓敬称拒绝入册（避免将局部名称变体当作全局规则）；
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
  updateEntry,
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

  it('删除型口癖条目填上写法 → action 翻成 replace（否则 correct 存了也永远不用）', () => {
    const filler = upsertEntry(uid, { wrong: '嗯嗯', correct: '', action: 'delete', kind: 'filler' }).entry!;
    expect(filler.action).toBe('delete');

    const after = retargetEntry(uid, filler.id, '嗯')!;
    expect(after.action).toBe('replace');
    expect(after.correct).toBe('嗯');
    // 错形与台账不动（同"写法修正"口径）
    expect(after.wrong).toBe(filler.wrong);
    expect(after.freq).toBe(filler.freq);
    // 行为随之改变：扫描里它不再是删除，而是替换
    const scan = scanText('嗯嗯 这个方案', [after], { docId: 'd1', includeDelete: true });
    const hit = scan.candidates.find((c) => c.entryRef === after.id);
    expect(hit?.action).toBe('replace');
    expect(hit?.correct).toBe('嗯');
  });

  it('替换型条目重复填同一个写法时保持 no-op（不动 action、不报错）', () => {
    const entry = upsertEntry(uid, { wrong: 'kstar', correct: 'K star', kind: 'term' }).entry!;
    const same = retargetEntry(uid, entry.id, 'K star')!;
    expect(same.action).toBe('replace');
    expect(same.updatedAt).toBe(entry.updatedAt);
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

    // 高危词条拒绝全局：拒绝项如实回报，且原作用域不变
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
    expect(deriveRiskLevel({ wrong: '朱老师', correct: '示例甲', action: 'replace' })).toBe('high');
    expect(isSingleSurnameHonorific('王总')).toBe(true);
    expect(isSingleSurnameHonorific('王总工')).toBe(false);
    expect(isPureDigits('00000000000042')).toBe(true);
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
    const res = upsertEntry(uid, { wrong: '00000000000042', correct: '某学号' });
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
  it('v1 文件 → 当前版本（补作用域/风险/台账，且落盘为新版本）', () => {
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
    // 当前文件版本 = 4（v3 的候选区已移除）。老文件升到新版本即可。
    expect(loaded.version).toBe(4);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].action).toBe('replace');
    expect(loaded.entries[0].scope.global).toBe(true);
    expect(loaded.entries[0].scope.scenarioTags).toEqual(['组会']);
    expect(loaded.entries[0].replacedIn).toEqual([]);
    expect(loaded.meta.lastReconcileAt).toBe(9);
    expect(JSON.parse(fs.readFileSync(userTranscriptGlossaryFile(uid), 'utf8')).version).toBe(4);
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
    upsertEntry(uid, { wrong: '示例加', correct: '示例甲', kind: 'people' });
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

describe('历史会议纠错词条继续按作用域读取和应用', () => {
  it('原有 meeting_accept 词条只命中原文档，不改变词表', () => {
    const original = upsertEntry(uid, { wrong: '例加', correct: '例甲', source: 'manual', docId: 'doc_1' }).entry!;
    const file = loadGlossary(uid);
    file.entries.find(entry => entry.id === original.id)!.source = 'meeting_accept';
    saveGlossary(uid, file);
    const before = JSON.stringify(loadGlossary(uid));
    const entries = listEntries(uid);
    const text = '这个方案要例加老师确认。';
    expect(scanText(text, entries, { docId: 'doc_1' }).candidates.map(c => [c.wrong, c.correct])).toEqual([['例加', '例甲']]);
    expect(scanText(text, entries, { docId: 'doc_2' }).candidates).toEqual([]);
    expect(JSON.stringify(loadGlossary(uid))).toBe(before);
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

/**
 * updateEntry —— 词表面板的「编辑」入口（方案 §七人工维护）。
 *
 * 真实反馈（2026-10-15）：「发现有个地方明显有问题，但其实不能改，那这个路径是不通的」。
 * 守的不变量：
 *   - 编辑必须原子（一次读写），不能出现"删掉了但没建成"的中间态；
 *   - 身份没变时走 retargetEntry 的语义（写法修正 ≠ 一次新确认，台账/统计不许动）；
 *   - 身份变了时台账与统计必须跟着走（用户是在改这一条，不是新建一条）；
 *   - 风险等级只升不降；
 *   - 撞已有词条要拒绝，不静默合并。
 */
describe('updateEntry：编辑一条已有词条', () => {
  it('只改正确写法 → 原地更新，id/createdAt 不变，台账与 freq 不动', () => {
    const created = upsertEntry(uid, { wrong: '健全', correct: '鉴权', docId: 'doc-A' }).entry!;
    recordReplacement(uid, [created.id], { docId: 'doc-A', runId: 'r1' });
    const before = findEntry(uid, created.id)!;
    expect(before.freq).toBe(1);

    const res = updateEntry(uid, created.id, { correct: '权限校验' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replacedId).toBeNull();
    expect(res.entry.id).toBe(created.id);
    expect(res.entry.correct).toBe('权限校验');
    expect(res.entry.wrong).toBe('健全');
    expect(res.entry.createdAt).toBe(before.createdAt);
    // 写法修正不等于一次新确认：台账与统计必须原样
    expect(res.entry.freq).toBe(1);
    expect(res.entry.replacedIn.length).toBe(before.replacedIn.length);
  });

  it('改了错误写法 → 换身份，台账/freq/createdAt 全部继承过来', () => {
    const created = upsertEntry(uid, { wrong: '章浩', correct: '张浩', docId: 'doc-A' }).entry!;
    recordReplacement(uid, [created.id], { docId: 'doc-A', runId: 'r1' });
    const before = findEntry(uid, created.id)!;

    const res = updateEntry(uid, created.id, { wrong: '阿浩' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replacedId).toBe(created.id);
    expect(res.entry.wrong).toBe('阿浩');
    expect(res.entry.correct).toBe('张浩');
    // 是"改这一条"，不是"新建一条"：统计与台账跟着走
    expect(res.entry.freq).toBe(before.freq);
    expect(res.entry.replacedIn.length).toBe(before.replacedIn.length);
    expect(res.entry.createdAt).toBe(before.createdAt);
    // 旧身份必须消失，不能新旧并存
    expect(listEntries(uid).filter((e) => e.wrong === '章浩')).toHaveLength(0);
    expect(listEntries(uid)).toHaveLength(1);
  });

  it('风险等级只升不降：把高危短词改成更危险的形态，等级跟着升', () => {
    const created = upsertEntry(uid, { wrong: 'redmi', correct: 'README', docId: 'doc-A' }).entry!;
    expect(created.riskLevel).toBe('high');
    const res = updateEntry(uid, created.id, { wrong: '模型' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 中文两字必然是 high；不允许降到 low/medium
    expect(res.entry.riskLevel).toBe('high');
  });

  it('用户显式改风险 → 按用户选择保存（可以调低）', () => {
    const created = upsertEntry(uid, { wrong: '健全', correct: '鉴权', docId: 'doc-A' }).entry!;
    expect(created.riskLevel).toBe('high');
    const lowered = updateEntry(uid, created.id, { riskLevel: 'low' });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.entry.riskLevel).toBe('low');

    const raised = updateEntry(uid, created.id, { riskLevel: 'high' });
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    expect(raised.entry.riskLevel).toBe('high');
  });

  it('非法风险值 → invalid_risk，不改动原词条', () => {
    const created = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', docId: 'doc-A' }).entry!;
    const res = updateEntry(uid, created.id, { riskLevel: 'critical' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('invalid_risk');
    expect(findEntry(uid, created.id)!.riskLevel).toBe(created.riskLevel);
  });

  it('人工新增可以用 riskOverride 指定低风险；导入路径仍保留安全下限', () => {
    const manual = upsertEntry(uid, { wrong: '健全', correct: '鉴权', riskLevel: 'low', riskOverride: true }).entry!;
    expect(manual.riskLevel).toBe('low');
    const imported = upsertEntry(uid, { wrong: '完善', correct: '完成', riskLevel: 'low' }).entry!;
    expect(imported.riskLevel).toBe('high');
  });

  it('改出来的新身份撞上已有词条 → 拒绝，不静默合并', () => {
    const a = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', docId: 'doc-A' }).entry!;
    upsertEntry(uid, { wrong: 'cox', correct: 'Cogseed', docId: 'doc-A' });
    const res = updateEntry(uid, a.id, { wrong: 'cox' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('duplicate');
    // 原词条必须原样还在
    expect(findEntry(uid, a.id)!.wrong).toBe('coxy');
  });

  it('纯数字变体被拒（与 upsert 同一条红线），且原词条不受影响', () => {
    const created = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', docId: 'doc-A' }).entry!;
    const res = updateEntry(uid, created.id, { wrong: '12345' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('pure_digit_variant');
    expect(findEntry(uid, created.id)!.wrong).toBe('coxy');
  });

  it('词条不存在 → not_found（不抛异常，界面好处理）', () => {
    const res = updateEntry(uid, 'no-such-id', { correct: 'X' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('not_found');
  });

  it('改成空串 → empty，不落盘', () => {
    const created = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', docId: 'doc-A' }).entry!;
    const res = updateEntry(uid, created.id, { correct: '   ' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('empty');
    expect(findEntry(uid, created.id)!.correct).toBe('Cogseed');
  });

  it('只改类别 → 其余字段不动', () => {
    const created = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', kind: 'product', docId: 'doc-A' }).entry!;
    const res = updateEntry(uid, created.id, { kind: 'term' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.kind).toBe('term');
    expect(res.entry.wrong).toBe('coxy');
    expect(res.entry.correct).toBe('Cogseed');
    expect(res.entry.id).toBe(created.id);
  });

  it('原子性：被拒的编辑不产生任何中间态（词条数与内容都不变）', () => {
    const created = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', docId: 'doc-A' }).entry!;
    const snapshot = JSON.stringify(listEntries(uid));
    updateEntry(uid, created.id, { wrong: '999' });      // 纯数字，必被拒
    updateEntry(uid, created.id, { correct: '' });        // 空，必被拒
    updateEntry(uid, 'ghost', { correct: 'X' });          // 不存在
    expect(JSON.stringify(listEntries(uid))).toBe(snapshot);
  });
});
