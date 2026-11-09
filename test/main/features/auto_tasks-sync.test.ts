import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'auto-task-sync-user';

let tmpDir: string;
let prevWs: string | undefined;
let dirty: Array<{ domain: string; relPath: string }>;
let deleted: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-auto-sync-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  dirty = [];
  deleted = [];
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('auto tasks sync dirty notifications', () => {
  it('marks task config mutations dirty', async () => {
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    autoTasks._setSyncDirtyNotifierForTest((domain, relPath) => dirty.push({ domain, relPath }));
    autoTasks._setSyncDeletedNotifierForTest((relPath) => deleted.push(relPath));

    const created = await autoTasks.createTask(UID, {
      id: 'at_1234abcd',
      content: 'hello',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    await autoTasks.updateTask(UID, 'at_1234abcd', { title: 'Greeting' });
    await autoTasks.setTaskEnabled(UID, 'at_1234abcd', false);
    await autoTasks.deleteTask(UID, 'at_1234abcd');
    autoTasks.stopScheduler();

    expect(dirty).toEqual([
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_1234abcd/config.json' },
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_1234abcd/config.json' },
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_1234abcd/config.json' },
    ]);
    expect(deleted).toEqual(['cloud/auto_tasks/at_1234abcd/config.json']);
  });

  it('marks task attachment mutations dirty', async () => {
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    autoTasks._setSyncDirtyNotifierForTest((domain, relPath) => dirty.push({ domain, relPath }));
    autoTasks._setSyncDeletedNotifierForTest((relPath) => deleted.push(relPath));

    await autoTasks.uploadAttachment(UID, 'at_abcdef12', 'brief.txt', Buffer.from('brief'));
    await autoTasks.deleteAttachment(UID, 'at_abcdef12', 'brief.txt');
    autoTasks.stopScheduler();

    expect(dirty).toEqual([
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_abcdef12/attachments/brief.txt' },
    ]);
    expect(deleted).toEqual(['cloud/auto_tasks/at_abcdef12/attachments/brief.txt']);
  });

  it('keeps template_origin, requirements and enabled_at in the synced config', async () => {
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    autoTasks._setSyncDirtyNotifierForTest((domain, relPath) => dirty.push({ domain, relPath }));

    const templateOrigin = { template_id: 'task-tpl-b', version: '1.0.0', request_id: 'req_sync_0001' };
    const requirements = {
      agent: { source: 'hub' as const, kind: 'agent' as const, id: 'bbbbbbbbbbb1' },
      skills: [{ source: 'hub' as const, kind: 'skill' as const, id: 'aaaaaaaaaaa1' }],
      connector_types: ['tencent-meeting'],
    };
    // 直接以启用态建任务：模板任务再启用会复检依赖（FR-050），而这份 fixture 的
    // hub 引用在本机不可解析，走 setTaskEnabled 只会被正确地挡住。本用例管的是
    // 三个字段随 config.json 同步，不是那道闸。
    const created = await autoTasks.createTask(UID, {
      id: 'at_0badc0de', content: 'hello', enabled: true,
      schedule: { type: 'daily', hour: 9, minute: 0 },
      template_origin: templateOrigin, requirements,
    });
    expect(created.ok).toBe(true);
    autoTasks.stopScheduler();

    // 另一台设备读同步下来的 config.json：三个字段都要还在。
    vi.resetModules();
    const fresh = await import('../../../src/main/features/auto_tasks');
    const saved = await fresh.getTask(UID, 'at_0badc0de');
    fresh.stopScheduler();
    expect(saved).toMatchObject({ enabled: true, template_origin: templateOrigin, requirements });
    expect(typeof saved?.enabled_at).toBe('string');
  });
});
