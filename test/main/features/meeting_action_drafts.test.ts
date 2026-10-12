/**
 * meeting_action_drafts — 草稿待办实体与状态机（specs/013 · US-503 / T040~T042）
 *
 * 钉住的验收（tasks.md 原文）：
 *   T040 ① 默认 draft；② 状态迁移只允许 draft→confirmed / draft→discarded
 *        （非法迁移被拒）；③ 幂等（同输入不新增）。
 *   T041 draft 态调落点 ⇒ 抛错且**无任何写入**；confirmed 态才通过；
 *        源码级断言"落点写入点只有一个且都过 assertActionDraftSendable"。
 *   T042 写入 draft → 重新加载模块（模拟重启）⇒ 草稿仍在、status 仍 draft、
 *        confirmedTarget 缺失；读盘断言"正式落点记录数 0"；源码级断言无
 *        定时器 / 生命周期钩子（只落盘，不做超时状态迁移）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  actionDraftId,
  applyActionDraftTarget,
  assertActionDraftSendable,
  confirmActionDraft,
  discardActionDraft,
  listActionDrafts,
  saveActionDraft,
} from '../../../src/main/features/meeting_action_drafts';
import { docKeyForDocId } from '../../../src/main/features/meeting_doc';
import { userMeetingActionDraftsDir } from '../../../src/main/paths';

const DOC = 'kb/meeting-0925.md';

let uid = '';
beforeEach(() => {
  uid = `u_action_drafts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  fs.rmSync(userMeetingActionDraftsDir(uid), { recursive: true, force: true });
});

function storeFile(): string {
  return path.join(userMeetingActionDraftsDir(uid), `${docKeyForDocId(DOC)}.json`);
}

function readStoreRaw(): { drafts?: Array<{ status?: string; confirmedTarget?: unknown }> } {
  return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
}

function anchor(blockIndex: number) {
  return { utteranceId: `U${String(blockIndex + 1).padStart(4, '0')}`, blockIndex, from: 0, to: 12 };
}

describe('T040：草稿实体与状态机', () => {
  it('① 默认 draft：save 后 status === "draft"，无 confirmedAt/confirmedTarget', () => {
    const draft = saveActionDraft(uid, {
      docId: DOC,
      summary: '下周三前把排期表发给付平老师',
      owner: { speaker: '付平', anchor: anchor(3) },
      transcriptRefs: [anchor(3)],
      assetRefs: [{ assetId: 'ast_cogseed', version: '3', title: 'Cogseed 术语表', type: 'personal' }],
    });
    expect(draft.status).toBe('draft');
    expect(draft.confirmedAt).toBeUndefined();
    expect(draft.confirmedTarget).toBeUndefined();
    expect(draft.id).toMatch(/^ma_[0-9a-f]{24}$/);
  });

  it('① id 确定性派生：同输入同 id；摘要空白归一后同输入仍同 id', () => {
    const a = actionDraftId({ docId: DOC, summary: '下周 排期', blockIndex: 2 });
    const b = actionDraftId({ docId: DOC, summary: '下周排期', blockIndex: 2 });
    const c = actionDraftId({ docId: DOC, summary: '下周排期', blockIndex: 3 });
    const d = actionDraftId({ docId: 'kb/other.md', summary: '下周排期', blockIndex: 2 });
    expect(a).toBe(b);        // 归一化摘要：空白不改变身份
    expect(a).not.toBe(c);    // 不同段落 = 不同待办
    expect(a).not.toBe(d);    // 不同文档 = 不同待办
  });

  it('② 合法迁移：draft→confirmed、draft→discarded 各自成立', () => {
    const first = saveActionDraft(uid, { docId: DOC, summary: '待办一' });
    const confirmed = confirmActionDraft(uid, DOC, first.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt).toBeTruthy();

    const second = saveActionDraft(uid, { docId: DOC, summary: '待办二' });
    const discarded = discardActionDraft(uid, DOC, second.id);
    expect(discarded.status).toBe('discarded');
  });

  it('② 非法迁移被拒：重复确认 / 丢弃已确认 / 复活已丢弃 / 重复丢弃全部 invalid_status_transition', () => {
    const a = saveActionDraft(uid, { docId: DOC, summary: '待办A' });
    confirmActionDraft(uid, DOC, a.id);
    expect(() => confirmActionDraft(uid, DOC, a.id)).toThrowError(
      expect.objectContaining({ code: 'invalid_status_transition' }),
    );
    expect(() => discardActionDraft(uid, DOC, a.id)).toThrowError(
      expect.objectContaining({ code: 'invalid_status_transition' }),
    );

    const b = saveActionDraft(uid, { docId: DOC, summary: '待办B' });
    discardActionDraft(uid, DOC, b.id);
    expect(() => confirmActionDraft(uid, DOC, b.id)).toThrowError(
      expect.objectContaining({ code: 'invalid_status_transition' }),
    );
    expect(() => discardActionDraft(uid, DOC, b.id)).toThrowError(
      expect.objectContaining({ code: 'invalid_status_transition' }),
    );
    // 被拒的迁移不留半态：盘上仍是原状态（a=confirmed、b=discarded）
    const onDisk = readStoreRaw().drafts ?? [];
    expect(onDisk.find((d) => d.status === 'confirmed')).toBeDefined();
    expect(onDisk.find((d) => d.status === 'discarded')).toBeDefined();
    expect(onDisk.find((d) => d.status === 'draft')).toBeUndefined();
  });

  it('③ 幂等：同输入 save 两次只有一条，且盘上零变化（updatedAt 不动）', () => {
    const input = { docId: DOC, summary: '同一个待办', owner: { speaker: '张磊' }, transcriptRefs: [anchor(1)] };
    const first = saveActionDraft(uid, input);
    const before = fs.readFileSync(storeFile(), 'utf8');
    const second = saveActionDraft(uid, input);
    const after = fs.readFileSync(storeFile(), 'utf8');
    expect(second.id).toBe(first.id);
    expect(listActionDrafts(uid, DOC)).toHaveLength(1);
    expect(after).toBe(before); // 完整幂等：内容一致就不写盘
  });

  it('③ draft 态同 id（同摘要同段落）刷新引用/来源不新增条目；确认后不重发', () => {
    const base = { docId: DOC, summary: '排期待办', transcriptRefs: [anchor(2)] };
    const first = saveActionDraft(uid, base);
    const refreshed = saveActionDraft(uid, {
      ...base,
      owner: { speaker: '傅平' },
      assetRefs: [{ assetId: 'ast_a', version: '1', title: 'A', type: 'fact' }],
    });
    expect(refreshed.id).toBe(first.id);
    expect(listActionDrafts(uid, DOC)).toHaveLength(1);
    expect(refreshed.owner).toEqual({ speaker: '傅平' });

    // 确认后再 save 同 id：不重发（摘要/引用一概不动，原样返回）
    confirmActionDraft(uid, DOC, first.id);
    const afterConfirm = saveActionDraft(uid, {
      ...base,
      owner: { speaker: '别人' },
      assetRefs: [{ assetId: 'ast_b', version: '9', title: 'B', type: 'rule' }],
    });
    expect(afterConfirm.status).toBe('confirmed');
    expect(afterConfirm.owner).toEqual({ speaker: '傅平' }); // 确认后的内容字段未被覆盖
    expect(afterConfirm.assetRefs.some((r) => r.assetId === 'ast_b')).toBe(false);
  });

  it('listActionDrafts 可按状态过滤；未知文档返回空数组', () => {
    saveActionDraft(uid, { docId: DOC, summary: '甲' });
    const b = saveActionDraft(uid, { docId: DOC, summary: '乙' });
    confirmActionDraft(uid, DOC, b.id);
    expect(listActionDrafts(uid, DOC, { status: 'draft' })).toHaveLength(1);
    expect(listActionDrafts(uid, DOC, { status: 'confirmed' })).toHaveLength(1);
    expect(listActionDrafts(uid, DOC)).toHaveLength(2);
    expect(listActionDrafts(uid, 'kb/none.md')).toEqual([]);
  });

  it('脏输入在门口拒：空摘要 / 空 docId 不落盘', () => {
    expect(() => saveActionDraft(uid, { docId: DOC, summary: '   ' })).toThrowError(
      expect.objectContaining({ code: 'invalid_summary' }),
    );
    expect(() => saveActionDraft(uid, { docId: '', summary: 'x' })).toThrowError(
      expect.objectContaining({ code: 'invalid_doc_id' }),
    );
    expect(fs.existsSync(storeFile())).toBe(false);
  });
});

describe('T041：外发闸唯一处（SC-003）', () => {
  it('assertActionDraftSendable：draft 与 discarded 都抛 draft_not_confirmed；confirmed 通过', () => {
    const draft = saveActionDraft(uid, { docId: DOC, summary: '闸测试' });
    expect(() => assertActionDraftSendable(draft)).toThrowError(
      expect.objectContaining({ code: 'draft_not_confirmed' }),
    );
    expect(() => assertActionDraftSendable(undefined)).toThrowError(
      expect.objectContaining({ code: 'draft_not_confirmed' }),
    );
    const confirmed = confirmActionDraft(uid, DOC, draft.id);
    expect(assertActionDraftSendable(confirmed)).toBeUndefined();
    const discardedDraft = saveActionDraft(uid, { docId: DOC, summary: '丢弃的' });
    discardActionDraft(uid, DOC, discardedDraft.id);
    expect(() => assertActionDraftSendable({ ...discardedDraft, status: 'discarded' })).toThrowError(
      expect.objectContaining({ code: 'draft_not_confirmed' }),
    );
  });

  it('draft 态调落点 ⇒ 抛 draft_not_confirmed 且无任何写入（盘上零变化、无 confirmedTarget）', () => {
    const draft = saveActionDraft(uid, { docId: DOC, summary: '未确认的外发' });
    const before = fs.readFileSync(storeFile(), 'utf8');
    expect(() => applyActionDraftTarget(uid, DOC, draft.id, { kind: 'local', ref: 'todo://1' })).toThrowError(
      expect.objectContaining({ code: 'draft_not_confirmed' }),
    );
    expect(fs.readFileSync(storeFile(), 'utf8')).toBe(before); // 一字节都没动
    expect(readStoreRaw().drafts?.[0].confirmedTarget).toBeUndefined();
  });

  it('discarded 态调落点同样被闸拦（非 confirmed 一律拒）', () => {
    const draft = saveActionDraft(uid, { docId: DOC, summary: '丢弃后的外发' });
    discardActionDraft(uid, DOC, draft.id);
    expect(() => applyActionDraftTarget(uid, DOC, draft.id, { kind: 'local' })).toThrowError(
      expect.objectContaining({ code: 'draft_not_confirmed' }),
    );
  });

  it('confirmed 态才通过：落点写入 confirmedTarget；同落点重试幂等；换落点被拒', () => {
    const draft = saveActionDraft(uid, { docId: DOC, summary: '确认后的外发' });
    confirmActionDraft(uid, DOC, draft.id);
    const applied = applyActionDraftTarget(uid, DOC, draft.id, { kind: 'local', ref: 'todo://42' });
    expect(applied.confirmedTarget).toEqual({ kind: 'local', ref: 'todo://42' });
    const retry = applyActionDraftTarget(uid, DOC, draft.id, { kind: 'local', ref: 'todo://42' });
    expect(retry.confirmedTarget).toEqual({ kind: 'local', ref: 'todo://42' }); // 幂等
    expect(() => applyActionDraftTarget(uid, DOC, draft.id, { kind: 'session_task' })).toThrowError(
      expect.objectContaining({ code: 'target_already_set' }),
    );
    expect(() => applyActionDraftTarget(uid, DOC, 'ma_missing', { kind: 'local' })).toThrowError(
      expect.objectContaining({ code: 'draft_not_found' }),
    );
  });

  it('源码级断言：confirmedTarget 的写入点全 src/main 唯一，且先过 assertActionDraftSendable', () => {
    const srcMain = path.resolve(__dirname, '..', '..', '..', 'src', 'main');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name === 'node_modules') continue;
          walk(full);
        } else if (/\.(ts|js)$/.test(name)) files.push(full);
      }
    };
    walk(srcMain);
    const writePattern = /confirmedTarget\s*(?::\s*\{|=)/;
    const writers: Array<{ file: string; line: number }> = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (writePattern.test(line) && !/confirmedTarget\?/.test(line)) {
          writers.push({ file, line: index + 1 });
        }
      });
    }
    // "落点写入点只有一个"：全 src/main 仅 meeting_action_drafts.ts 一处赋值
    expect(writers).toHaveLength(1);
    expect(writers[0].file.endsWith('meeting_action_drafts.ts')).toBe(true);
    // "且都过该函数"：写入行落在 applyActionDraftTarget 内，且闸调用在其之前
    const source = fs.readFileSync(writers[0].file, 'utf8');
    const fnStart = source.indexOf('export function applyActionDraftTarget');
    const gateAt = source.indexOf('assertActionDraftSendable(draft)', fnStart);
    const lines = source.split('\n').slice(0, writers[0].line).join('\n');
    const writeAt = lines.length;
    expect(fnStart).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(fnStart);
    expect(gateAt).toBeLessThan(writeAt);
  });
});

describe('T042：中断可续办（只落盘，无超时/会话结束迁移）', () => {
  it('写入 draft → 重新加载模块（模拟重启）⇒ 草稿仍在、status 仍 draft、confirmedTarget 缺失；正式落点记录数 0', async () => {
    saveActionDraft(uid, { docId: DOC, summary: '重启后还能续办', owner: { speaker: '张磊' } });
    const before = fs.readFileSync(storeFile(), 'utf8');
    // 模拟重启：模块图重置后重新加载（模块无内存状态，一切以盘为准）
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/meeting_action_drafts');
    const drafts = reloaded.listActionDrafts(uid, DOC);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('draft');
    expect(drafts[0].summary).toBe('重启后还能续办');
    expect(drafts[0].confirmedTarget).toBeUndefined();
    // 读盘断言：正式落点记录数 0（没有任何条目带 confirmedTarget）
    const store = readStoreRaw();
    expect(store.drafts?.filter((d) => d.confirmedTarget)).toHaveLength(0);
    // 重启期间也无任何后台迁移：盘内容逐字未变
    expect(fs.readFileSync(storeFile(), 'utf8')).toBe(before);
  });

  it('源码级断言：模块内无定时器、无 Electron 生命周期钩子（不做超时/会话结束的状态迁移）', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'src', 'main', 'features', 'meeting_action_drafts.ts'),
      'utf8',
    );
    const banned = ['setTimeout', 'setInterval', 'setImmediate', 'process.on(', 'powerMonitor', 'will-quit', 'before-quit', 'session-end'];
    for (const marker of banned) {
      expect(source.includes(marker)).toBe(false);
    }
  });
});
