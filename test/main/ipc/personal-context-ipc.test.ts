import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalResource } from '../../../src/main/features/personal_context/contract';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pc-ipc-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UID = 'test-user-1';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

vi.mock('../../../src/main/features/personal_context/manager', () => ({
  beginAuthorize: vi.fn(),
  getStatus: vi.fn(),
  cancelAuthorize: vi.fn(),
  revoke: vi.fn(),
  healthCheck: vi.fn(),
  buildFeishuProvider: vi.fn(),
  ensureSyncScheduler: vi.fn(),
  syncNow: vi.fn(),
  stopSyncScheduler: vi.fn(),
}));

import * as managerMock from '../../../src/main/features/personal_context/manager';

type InvokeHandlers = Record<string, (payload: Record<string, unknown>, ctx: { userId: string }) => Promise<unknown> | unknown>;

/** 动态 import：registry 模块的 WS_ROOT 在 beforeEach 设置 env 后才绑定 */
async function loadRegistry() {
  const { PersonalContextRegistry } = await import('../../../src/main/features/personal_context/registry');
  return new PersonalContextRegistry();
}

function resource(overrides: Partial<ExternalResource> = {}): ExternalResource {
  return {
    resourceId: 'feishu:tenant-1:calendar:cal_001',
    resourceType: 'calendar',
    title: '主日历',
    observedAt: '2026-08-01T00:00:00.000Z',
    accessLabel: 'personal',
    retentionPolicy: 'source-linked',
    ...overrides,
  };
}

const rCalendar = resource();
const rDoc = resource({ resourceId: 'feishu:tenant-1:document:doc_001', resourceType: 'document', title: '课程大纲' });

async function loadHandlers(): Promise<InvokeHandlers> {
  const { invokeHandlers } = await import('../../../src/main/ipc/personal-context');
  return invokeHandlers;
}

function call(handlers: InvokeHandlers, channel: string, payload: Record<string, unknown>) {
  return handlers[channel](payload, { userId: UID });
}

describe('personal_context IPC 参数校验', () => {
  it('非法 providerId 拒绝三个新通道', async () => {
    const handlers = await loadHandlers();
    await expect(call(handlers, 'personal_context.discover_resources', { providerId: 'wechat' })).rejects.toThrow('unsupported');
    await expect(call(handlers, 'personal_context.set_scope', { providerId: 'wechat', resources: [] })).rejects.toThrow('unsupported');
    await expect(call(handlers, 'personal_context.get_scope', { providerId: 'wechat' })).rejects.toThrow('unsupported');
    await expect(call(handlers, 'personal_context.discover_resources', {})).rejects.toThrow('unsupported');
  });

  it('set_scope：resources 必须为数组', async () => {
    const handlers = await loadHandlers();
    await expect(call(handlers, 'personal_context.set_scope', { providerId: 'feishu', resources: 'oops' }))
      .rejects.toThrow('must be an array');
    await expect(call(handlers, 'personal_context.set_scope', { providerId: 'feishu' }))
      .rejects.toThrow('must be an array');
  });

  it('set_scope：resourceId 必须是 feishu 域幂等键', async () => {
    const handlers = await loadHandlers();
    await expect(call(handlers, 'personal_context.set_scope', {
      providerId: 'feishu',
      resources: [{ resourceId: 'wechat:tenant:chat:oc_1', resourceType: 'chat' }],
    })).rejects.toThrow(/must be a 'feishu' scoped key/);
    await expect(call(handlers, 'personal_context.set_scope', {
      providerId: 'feishu',
      resources: [{ resourceId: 'malformed', resourceType: 'calendar' }],
    })).rejects.toThrow(/must be a 'feishu' scoped key/);
    await expect(call(handlers, 'personal_context.set_scope', {
      providerId: 'feishu',
      resources: [{ resourceId: 42, resourceType: 'calendar' }],
    })).rejects.toThrow(/invalid resourceId/);
  });

  it('set_scope：resourceType 必须在 RESOURCE_TYPES 内', async () => {
    const handlers = await loadHandlers();
    await expect(call(handlers, 'personal_context.set_scope', {
      providerId: 'feishu',
      resources: [{ resourceId: 'feishu:tenant-1:calendar:cal_001', resourceType: 'hologram' }],
    })).rejects.toThrow(/invalid resourceType/);
  });

  it('set_scope：资源数量上限 200', async () => {
    const handlers = await loadHandlers();
    const many = Array.from({ length: 201 }, (_, i) => ({
      resourceId: `feishu:tenant-1:calendar:cal_${i}`,
      resourceType: 'calendar',
    }));
    await expect(call(handlers, 'personal_context.set_scope', { providerId: 'feishu', resources: many }))
      .rejects.toThrow(/too many resources/);
  });
});

describe('personal_context 发现/范围通道', () => {
  it('discover_resources：返回资源并登记进注册表', async () => {
    const handlers = await loadHandlers();
    const registry = await loadRegistry();
    vi.mocked(managerMock.buildFeishuProvider).mockResolvedValue({
      provider: { discoverResources: async () => [rCalendar, rDoc] } as never,
      registry,
      cursors: null as never,
      identity: { tenant: 'tenant-1', unionId: 'on_me' },
    });

    const result = await call(handlers, 'personal_context.discover_resources', { providerId: 'feishu' });
    expect(result.resources.map((r: ExternalResource) => r.resourceId)).toEqual([
      'feishu:tenant-1:calendar:cal_001',
      'feishu:tenant-1:document:doc_001',
    ]);
    // 发现即登记：注册表可读到资源（待勾选）
    expect(await registry.get(UID, rCalendar.resourceId)).not.toBeNull();
    expect((await registry.get(UID, rCalendar.resourceId))?.selected).toBe(false);
  });

  it('set_scope：保存清单并联动注册表选择', async () => {
    const handlers = await loadHandlers();
    // 先登记两个资源（模拟 discover 已登记）
    const registry = await loadRegistry();
    await registry.upsert(UID, rCalendar);
    await registry.upsert(UID, rDoc);

    const result = await call(handlers, 'personal_context.set_scope', {
      providerId: 'feishu',
      resources: [rCalendar],
    });
    expect(result.changed).toBe(true);
    expect(result.scope.entries.map((e: { resourceId: string }) => e.resourceId)).toEqual(['feishu:tenant-1:calendar:cal_001']);

    const selected = await registry.list(UID, { selectedOnly: true });
    expect(selected.map((e) => e.resource.resourceId)).toEqual(['feishu:tenant-1:calendar:cal_001']);
    // 未勾选的 rDoc 联动取消
    expect((await registry.get(UID, rDoc.resourceId))?.selected).toBe(false);
  });

  it('set_scope：幂等（无变化）返回 changed:false', async () => {
    const handlers = await loadHandlers();
    await call(handlers, 'personal_context.set_scope', { providerId: 'feishu', resources: [rCalendar] });
    const again = await call(handlers, 'personal_context.set_scope', { providerId: 'feishu', resources: [rCalendar] });
    expect(again.changed).toBe(false);
  });

  it('get_scope：返回已保存的接入范围', async () => {
    const handlers = await loadHandlers();
    await call(handlers, 'personal_context.set_scope', { providerId: 'feishu', resources: [rCalendar, rDoc] });

    const result = await call(handlers, 'personal_context.get_scope', { providerId: 'feishu' });
    expect(result.scope.entries.map((e: { resourceId: string }) => e.resourceId)).toEqual([
      'feishu:tenant-1:calendar:cal_001',
      'feishu:tenant-1:document:doc_001',
    ]);
    expect(result.scope.updatedAt).toBeTruthy();
  });

  it('get_scope：未保存时返回空清单', async () => {
    const handlers = await loadHandlers();
    const result = await call(handlers, 'personal_context.get_scope', { providerId: 'feishu' });
    expect(result.scope.entries).toEqual([]);
  });
});
