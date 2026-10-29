import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-001';
const SRC = '../../../../src/main/features/cognition_kernel/routing_rules';
let tmpDir = '';
let prevRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rules-'));
  prevRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  return import(SRC);
}

describe('cognition_kernel/routing_rules — 规则即数据', () => {
  it('没写过就是空规则，不抛错', async () => {
    const mod = await load();
    expect(mod.readRoutingRules(UID)).toEqual({ schemaVersion: 1, rules: [], corrections: [] });
  });

  it('用户的纠正被记下来，成为下次判定的样例（持久化可回读）', async () => {
    const mod = await load();
    const saved = mod.learnFromCorrection(UID, {
      statement: '本周上线支付网关',
      fromHome: 'personal_fact',
      toHome: 'task_local',
      note: '这是项目临时事实，别写进我的档案',
    });
    expect(saved?.toHome).toBe('task_local');
    const doc = mod.readRoutingRules(UID);
    expect(doc.corrections).toHaveLength(1);
    expect(doc.corrections[0]).toMatchObject({ statement: '本周上线支付网关', fromHome: 'personal_fact', toHome: 'task_local' });
    expect(fs.existsSync(mod.routingRulesPath(UID))).toBe(true);
  });

  it('用户显式给的归属规则可追加', async () => {
    const mod = await load();
    const rule = mod.addRoutingRule(UID, { home: 'rule', note: '凡是财务口径的约束都算规则' });
    expect(rule?.id).toBeTruthy();
    expect(mod.readRoutingRules(UID).rules).toHaveLength(1);
  });

  it('坏档按空规则处理（规则读不到只影响判定质量，不影响主链）', async () => {
    const mod = await load();
    fs.mkdirSync(path.dirname(mod.routingRulesPath(UID)), { recursive: true });
    fs.writeFileSync(mod.routingRulesPath(UID), '{ 这不是 JSON', 'utf8');
    expect(mod.readRoutingRules(UID)).toEqual({ schemaVersion: 1, rules: [], corrections: [] });
  });

  it('非法归属被拒，不落盘', async () => {
    const mod = await load();
    // @ts-expect-error 故意传非法 home
    expect(mod.learnFromCorrection(UID, { statement: 'x', toHome: 'nowhere' })).toBeNull();
    // @ts-expect-error 同上
    expect(mod.addRoutingRule(UID, { home: 'nowhere', note: 'x' })).toBeNull();
    expect(mod.readRoutingRules(UID).corrections).toHaveLength(0);
  });

  it('样例数量有上限（防无限膨胀）', async () => {
    const mod = await load();
    for (let i = 0; i < mod.MAX_CORRECTIONS + 5; i += 1) {
      mod.learnFromCorrection(UID, { statement: '样例 ' + i, toHome: 'rule' });
    }
    expect(mod.readRoutingRules(UID).corrections).toHaveLength(mod.MAX_CORRECTIONS);
  });
});
