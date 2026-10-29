import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u1';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ck-gap-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePoDoc(): void {
  const dir = path.join(tmpDir, UID, 'cloud', 'cognition');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'personal-ontology.json'),
    JSON.stringify({
      schemaVersion: 2,
      groups: [
        {
          id: 'g1',
          kind: 'user',
          title: '关于我',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
          fields: [
            { id: 'f1', name: '姓名', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
            { id: 'f2', name: '联系偏好', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
          ],
          values: [
            { id: 'v1', fieldId: 'f1', text: '示例用户甲', source: 'manual', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
          ],
          entries: [],
        },
      ],
      trash: [],
      updatedAt: '2026-09-01T00:00:00Z',
    }),
    'utf8',
  );
}

function mods() {
  return Promise.all([
    import('../../../../src/main/features/cognition_kernel/gap'),
    import('../../../../src/main/features/cognition_kernel/store'),
  ]).then(([gap, store]) => ({ gap, store }));
}

const PACK = { id: 'synthetic_task', title: '合成任务', fields: [
  { fieldName: '姓名', required: true },
  { fieldName: '联系偏好', required: true },
] } as const;

describe('cognition_kernel/gap — 体检（缺口计算）', () => {
  it('内置注册表仅保留周报包，其他任务标识不解析', async () => {
    const { TASK_FIELD_PACKS, getTaskFieldPack } = await import('../../../../src/main/features/cognition_kernel/task_field_packs');
    expect(Object.keys(TASK_FIELD_PACKS)).toEqual(['weekly_report']);
    expect(getTaskFieldPack('weekly_report')).toMatchObject({ id: 'weekly_report', title: '周报' });
    expect(getTaskFieldPack('synthetic_task')).toBeUndefined();
  });

  it('旧账有值→bound；缺的→gap 带提问与动作', async () => {
    writePoDoc();
    const { gap } = await mods();
    const check = await gap.checkTaskFields(UID, PACK);
    expect(check.boundCount).toBe(1);
    expect(check.gaps).toHaveLength(1);
    expect(check.gaps[0]).toMatchObject({ fieldName: '联系偏好', reason: 'no_value', action: 'answer' });
    expect(check.gaps[0].question).toContain('联系偏好');
  });

  it('非必需字段缺失不进缺口（但仍如实记录在 resolution.missing）', async () => {
    const { gap } = await mods();
    const check = await gap.checkTaskFields(UID, { id: 'p', title: 'p', fields: [{ fieldName: '联系偏好', required: false }] });
    expect(check.gaps).toHaveLength(0);
    expect(check.resolution.missing).toHaveLength(1);
  });
});
