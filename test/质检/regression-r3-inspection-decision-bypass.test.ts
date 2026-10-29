/** 巡检处置拒绝非法 decision 与 findingKey，不能静默撤销既有处置。
 * 枚举外值、非字符串及超长键在写入前抛错，原 dismissed 状态保留。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'probe-r3-insp';

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r3insp-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function mod() {
  return import('../../src/main/features/recall/asset-inspection-service');
}

describe('巡检处置参数入口校验', () => {
  it('对照组：合法 dismissed/deferred 处置互斥生效', async () => {
    const svc = await mod();
    await svc.decideInspectionFinding(UID, 'asset:aa-x:confidence', 'dismissed');
    let settings = await svc.readInspectionSettings(UID);
    expect(settings.dismissedFindingKeys).toContain('asset:aa-x:confidence');
    await svc.decideInspectionFinding(UID, 'asset:aa-y:stale', 'deferred');
    settings = await svc.readInspectionSettings(UID);
    expect(settings.deferredFindingKeys).toContain('asset:aa-y:stale');
  });

  it('回归：非法 decision（拼写错/任意值）被入口拒绝，既有 dismissed 处置不被静默撤销', async () => {
    const svc = await mod();
    await svc.decideInspectionFinding(UID, 'asset:aa-z:stale', 'dismissed');
    expect((await svc.readInspectionSettings(UID)).dismissedFindingKeys).toContain('asset:aa-z:stale');

    // 'dismiss'（漏 ed）等非法值在入口抛错，不再静默双移除。
    await expect(svc.decideInspectionFinding(UID, 'asset:aa-z:stale', 'dismiss' as never))
      .rejects.toThrow(/invalid inspection decision/);
    // 既有处置保留：key 仍在 dismissed 数组（待办不复活）。
    expect((await svc.readInspectionSettings(UID)).dismissedFindingKeys).toContain('asset:aa-z:stale');
  });

  it('回归：findingKey 超 1024 字符被入口拒绝，不落盘', async () => {
    const svc = await mod();
    const huge = `k:${'x'.repeat(10_000)}`;
    await expect(svc.decideInspectionFinding(UID, huge, 'dismissed'))
      .rejects.toThrow(/invalid inspection finding key/);
    expect((await svc.readInspectionSettings(UID)).dismissedFindingKeys.some((k) => k.length > 1024)).toBe(false);
  });
});
