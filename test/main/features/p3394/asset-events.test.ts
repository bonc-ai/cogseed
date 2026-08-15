import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-events';
const ROOT_PREFIX = 'p3394-asset-events-test-';

let testRoot: string;
let prevWs: string | undefined;

beforeEach(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = testRoot;
  vi.resetModules(); // paths.ts 的 WS_ROOT 是模块加载时求值常量
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});
afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

async function loadEvents() {
  return import('../../../../src/main/features/p3394/asset-events');
}

async function loadReceipt() {
  return import('../../../../src/main/features/p3394/audit-receipt');
}

async function loadView() {
  return import('../../../../src/main/features/p3394/asset-view');
}

describe('asset-events › 追加与读取', () => {
  it('appendAssetEvent 追加成功：文件存在、字段完整、msgIndex 单调', async () => {
    const { appendAssetEvent, listAssetEvents, assetEventLogPath } = await loadEvents();
    const r1 = await appendAssetEvent(UID, {
      assetId: 'sk-001', version: '1.0.0', eventType: 'asset_user_confirmed', actor: 'user',
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.appended).toBe(true);
    expect(r1.event.event_id).toMatch(/^evt_/);
    expect(r1.event.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const r2 = await appendAssetEvent(UID, {
      assetId: 'sk-001', version: '1.0.0', eventType: 'asset_transfer_verified', actor: 'system',
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const events = await listAssetEvents(UID, 'sk-001');
    expect(events.length).toBe(2);
    expect(events[0].event_type).toBe('asset_user_confirmed');
    expect(events[1].event_type).toBe('asset_transfer_verified');
    expect(fs.existsSync(assetEventLogPath(UID, 'sk-001'))).toBe(true);
  });

  it('幂等：同 event_id 二次追加 → appended=false，文件只有一条', async () => {
    const { appendAssetEvent, listAssetEvents } = await loadEvents();
    const eventId = 'evt_fixed001';
    const r1 = await appendAssetEvent(UID, {
      assetId: 'sk-002', version: '1.0.0', eventType: 'asset_created', eventId,
    });
    expect(r1.ok && r1.appended).toBe(true);
    const r2 = await appendAssetEvent(UID, {
      assetId: 'sk-002', version: '1.0.0', eventType: 'asset_created', eventId,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.appended).toBe(false);
    expect((await listAssetEvents(UID, 'sk-002')).length).toBe(1);
  });

  it('失败注入：事件目录不可写 → { ok:false, reason: write_failed }', async () => {
    const { appendAssetEvent, assetEventLogPath } = await loadEvents();
    // 预创建目录并设为只读（append 将 EACCES）
    const file = assetEventLogPath(UID, 'sk-003');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.chmodSync(path.dirname(file), 0o555);
    try {
      const r = await appendAssetEvent(UID, {
        assetId: 'sk-003', version: '1.0.0', eventType: 'asset_created',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('write_failed');
    } finally {
      fs.chmodSync(path.dirname(file), 0o755);
    }
  });

  it('非法 event_type 抛错（受控枚举，禁止自由文本）', async () => {
    const { appendAssetEvent } = await loadEvents();
    await expect(appendAssetEvent(UID, {
      assetId: 'sk-004', version: '1.0.0', eventType: 'anything_else' as never,
    })).rejects.toThrow('invalid asset event type');
  });
});

describe('asset-view › 账本重放派生', () => {
  it('多事件重放：derived_state 取最后一次状态变化、versions 去重保序', async () => {
    const { appendAssetEvent } = await loadEvents();
    const { replayAssetView } = await loadView();
    await appendAssetEvent(UID, { assetId: 'sk-010', version: '1.0.0', eventType: 'asset_user_confirmed', actor: 'user' });
    await appendAssetEvent(UID, { assetId: 'sk-010', version: '1.0.0', eventType: 'asset_transfer_verified', actor: 'system' });
    await appendAssetEvent(UID, { assetId: 'sk-010', version: '2.0.0', eventType: 'asset_scope_changed', actor: 'user' });

    const view = await replayAssetView(UID, 'sk-010');
    // scope_changed 映射为 'unchanged'，不覆盖最后一次成熟度变化（transfer_verified）
    expect(view.derived_state).toBe('transfer_verified');
    expect(view.versions).toEqual(['1.0.0', '2.0.0']);
    expect(view.last_state_event?.event_type).toBe('asset_transfer_verified');
    expect(view.events.length).toBe(3);
    expect(view.last_updated_at).toBeDefined();
  });

  it('无事件 → derived_state=none、versions 空', async () => {
    const { replayAssetView } = await loadView();
    const view = await replayAssetView(UID, 'sk-011');
    expect(view.derived_state).toBe('none');
    expect(view.versions).toEqual([]);
    expect(view.events).toEqual([]);
  });
});

describe('audit-receipt › 生成与读取', () => {
  it('createAuditReceipt 落盘后可读，before/after refs 完整', async () => {
    const { appendAssetEvent } = await loadEvents();
    const { createAuditReceipt, readAuditReceipt } = await loadReceipt();
    const ev = await appendAssetEvent(UID, { assetId: 'sk-020', version: '1.0.0', eventType: 'asset_user_confirmed', actor: 'user' });
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    const rcpt = await createAuditReceipt(UID, {
      eventId: ev.event.event_id,
      subjectRef: 'sk-020',
      action: 'asset_user_confirmed',
      beforeRef: 'candidate:cand-020',
      afterRef: 'asset:sk-020@1.0.0',
      actor: 'user',
    });
    expect(rcpt.receipt_id).toMatch(/^rcpt_/);
    const back = await readAuditReceipt(UID, rcpt.receipt_id);
    expect(back?.event_ref).toBe(ev.event.event_id);
    expect(back?.after_ref).toBe('asset:sk-020@1.0.0');
  });
});
