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
  rememberConfirmedPairs,
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
 * 「勾选并应用 = 确认」的落表路径（D1=B：模型建议被采纳后成为词表规则）。
 *
 * 这里钉的是一个**真实陷阱**：`upsertEntry` 里 `source === 'meeting_accept'`
 * 只会把 `global` 置 false，却不动 `docIds` ⇒ 条目 `scopeAllows` 恒为 false，
 * 是一条永不命中的死规则（'meeting_accept' 一直没有调用方的原因）。
 */
describe('rememberConfirmedPairs：确认的对才进词表，且只对本文档生效', () => {
  it('按 meeting_accept 入册，作用域收窄到当前文档（不是全局）', () => {
    const r = rememberConfirmedPairs(uid, [{ wrong: '付平', correct: '傅平' }], { docId: 'doc_1' });
    expect(r).toMatchObject({ created: 1, skipped: 0 });
    const entry = listEntries(uid, { status: 'active' })[0];
    expect(entry).toMatchObject({ wrong: '付平', correct: '傅平', source: 'meeting_accept' });
    expect(entry.scope.global).toBe(false);
    expect(entry.scope.docIds).toEqual(['doc_1']);
  });

  it('该规则真的会命中本文档、且不影响别的文档（这条曾经是死规则）', () => {
    rememberConfirmedPairs(uid, [{ wrong: '付平', correct: '傅平' }], { docId: 'doc_1' });
    const entries = listEntries(uid, { status: 'active' });
    const text = '这个方案要付平老师确认。';
    const here = scanText(text, entries, { docId: 'doc_1' });
    expect(here.candidates.map((c) => [c.wrong, c.correct])).toEqual([['付平', '傅平']]);
    const other = scanText(text, entries, { docId: 'doc_2' });
    expect(other.candidates).toEqual([]);
  });

  it('没有 docId 时如实跳过，不写"永不命中"的死条目', () => {
    const r = rememberConfirmedPairs(uid, [{ wrong: 'a', correct: 'b' }], {});
    expect(r).toMatchObject({ created: 0, skipped: 1 });
    expect(listEntries(uid)).toEqual([]);
  });

  it('重复确认同一对是幂等更新，且同一批里的重复只算一条', () => {
    rememberConfirmedPairs(uid, [{ wrong: '付平', correct: '傅平' }], { docId: 'doc_1' });
    const again = rememberConfirmedPairs(uid, [
      { wrong: '付平', correct: '傅平' },
      { wrong: '付平', correct: '傅平' },
    ], { docId: 'doc_1' });
    expect(again).toMatchObject({ created: 0, updated: 1 });
    expect(listEntries(uid, { status: 'active' })).toHaveLength(1);
  });

  it('空目标不写脏数据，且不因单条不合法让整批失败', () => {
    const r = rememberConfirmedPairs(uid, [
      { wrong: '', correct: 'x' },
      { wrong: '付平', correct: '傅平' },
    ], { docId: 'doc_1' });
    expect(r).toMatchObject({ created: 1, skipped: 1 });
    expect(listEntries(uid, { status: 'active' })).toHaveLength(1);
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
