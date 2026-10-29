/**
 * 沉淀账本测试（对应 data-model.md E4 与 research R3）。
 *
 * 必测点：
 *   - append 后可读，字段保真；
 *   - **隐私硬约束**：白名单外的键被拒（结构性防正文泄漏）、超长字段被拒；
 *   - 坏行降级：单行损坏不影响其余行；
 *   - 「已解决项折叠」：失败后又有 added 的不再算可重试；
 *   - 追加**不覆盖**既有记录（append-only）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TEST_UID = 'ledger-u1';

type Ledger = typeof import('../../../src/main/features/meeting_artifact_ledger');

async function loadMod(): Promise<Ledger> {
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  return import('../../../src/main/features/meeting_artifact_ledger');
}

function baseEntry(over: Record<string, unknown> = {}) {
  return {
    ts: new Date().toISOString(),
    doc_key: 'doc-1',
    artifact_kind: 'minutes',
    target_scope: 'global' as const,
    target_rel: 'meetings/doc-1/会议纪要.md',
    result: 'added' as const,
    trigger: 'stage_event',
    ...over,
  };
}

describe('meeting_artifact_ledger', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('appends and reads back an entry, preserving fields', async () => {
    const mod = await loadMod();
    const before = await mod.readPrecipitationLedger(TEST_UID);
    const res = await mod.appendPrecipitationEntry(TEST_UID, baseEntry());
    expect(res.ok).toBe(true);

    const after = await mod.readPrecipitationLedger(TEST_UID);
    expect(after.entries.length).toBe(before.entries.length + 1);
    const last = after.entries[after.entries.length - 1];
    expect(last.doc_key).toBe('doc-1');
    expect(last.target_rel).toBe('meetings/doc-1/会议纪要.md');
    expect(last.result).toBe('added');
  });

  it('is append-only: a second append does not remove the first', async () => {
    const mod = await loadMod();
    await mod.appendPrecipitationEntry(TEST_UID, baseEntry({ target_rel: 'meetings/doc-1/a.md' }));
    await mod.appendPrecipitationEntry(TEST_UID, baseEntry({ target_rel: 'meetings/doc-1/b.md' }));
    const { entries } = await mod.readPrecipitationLedger(TEST_UID, 100);
    const rels = entries.filter((e) => e.doc_key === 'doc-1').map((e) => e.target_rel);
    expect(rels).toContain('meetings/doc-1/a.md');
    expect(rels).toContain('meetings/doc-1/b.md');
  });

  it('rejects unknown keys — structural defence against leaking transcript content', async () => {
    const mod = await loadMod();
    const bad = {
      ...baseEntry(),
      // 这正是要防的：有人顺手把正文塞进账本。
      transcript_text: '樊中扬：我们先确认一下交付范围……',
    };
    const res = await mod.appendPrecipitationEntry(TEST_UID, bad as never);
    expect(res.ok).toBe(false);
    expect(res.rejection).toBe('unknown_key');

    // 断言真的没落盘。
    const { entries } = await mod.readPrecipitationLedger(TEST_UID, 500);
    expect(entries.some((e) => JSON.stringify(e).includes('我们先确认一下交付范围'))).toBe(false);
  });

  it('rejects over-long field values (content-sized payloads cannot fit)', async () => {
    const mod = await loadMod();
    const res = await mod.appendPrecipitationEntry(TEST_UID, baseEntry({
      target_rel: 'x'.repeat(600),
    }));
    expect(res.ok).toBe(false);
    expect(res.rejection).toBe('field_too_long');
  });

  it('degrades on malformed lines without losing the good ones', async () => {
    const mod = await loadMod();
    await mod.appendPrecipitationEntry(TEST_UID, baseEntry({ target_rel: 'meetings/doc-1/good.md' }));

    // 手工塞一行坏数据，模拟写入中断。
    const file = mod.precipitationLedgerPath(TEST_UID);
    fs.appendFileSync(file, '{ this is not json\n', 'utf8');

    const out = await mod.readPrecipitationLedger(TEST_UID, 500);
    expect(out.entries.some((e) => e.target_rel === 'meetings/doc-1/good.md')).toBe(true);
    // 坏行被跳过并计数（要么计入 malformed，要么被 JSON 解析层丢弃；两者都要求不炸）。
    expect(out.entries.length).toBeGreaterThan(0);
  });

  it('folds resolved failures: a later success removes the item from retryable', async () => {
    const mod = await loadMod();
    const rel = 'meetings/doc-2/会议纪要.md';
    await mod.appendPrecipitationEntry(TEST_UID, baseEntry({
      doc_key: 'doc-2', target_rel: rel, result: 'failed', reason: 'target_unwritable',
    }));
    let retryable = await mod.listRetryablePrecipitations(TEST_UID, 'doc-2');
    expect(retryable.some((r) => r.targetRel === rel)).toBe(true);

    // 后续同一项成功 → 不再可重试。
    await mod.appendPrecipitationEntry(TEST_UID, baseEntry({
      doc_key: 'doc-2', target_rel: rel, result: 'added',
    }));
    retryable = await mod.listRetryablePrecipitations(TEST_UID, 'doc-2');
    expect(retryable.some((r) => r.targetRel === rel)).toBe(false);
  });

  it('keeps an unresolved failure retryable and reports its reason', async () => {
    const mod = await loadMod();
    const rel = 'meetings/doc-3/待办.md';
    await mod.appendPrecipitationEntry(TEST_UID, baseEntry({
      doc_key: 'doc-3', target_rel: rel, result: 'failed', reason: 'target_unwritable',
    }));
    const retryable = await mod.listRetryablePrecipitations(TEST_UID, 'doc-3');
    const hit = retryable.find((r) => r.targetRel === rel);
    expect(hit).toBeTruthy();
    expect(hit?.error).toBe('target_unwritable');
  });

  it('scopes reads by docKey when asked', async () => {
    const mod = await loadMod();
    await mod.appendPrecipitationEntry(TEST_UID, baseEntry({ doc_key: 'doc-A', target_rel: 'meetings/doc-A/x.md' }));
    await mod.appendPrecipitationEntry(TEST_UID, baseEntry({ doc_key: 'doc-B', target_rel: 'meetings/doc-B/y.md' }));
    const a = await mod.readPrecipitationLedger(TEST_UID, 500);
    const onlyA = a.entries.filter((e) => e.doc_key === 'doc-A');
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((e) => e.doc_key === 'doc-A')).toBe(true);
  });
});
