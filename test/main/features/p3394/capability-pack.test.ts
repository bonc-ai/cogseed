import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-cp';
const MOD = '../../../../src/main/features/p3394/capability-pack';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-capability-pack-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules(); // paths.ts WS_ROOT 模块加载时求值
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import(MOD);
}

const mainSkill = { asset_id: 'sk-handoff', version: '1.0.0', content_hash: 'a'.repeat(64) };

describe('capability-pack › 组装与读取', () => {
  it('组装最小能力包：只装引用、含溯源、默认 24h 有效期', async () => {
    const m = await loadMod();
    const pack = await m.buildCapabilityPack(UID, {
      purpose: '把项目从 Agent A 接续到 Agent B',
      mainSkillRef: mainSkill,
      ruleRefs: ['rule:sk-rule-1', 'rule:sk-rule-2'],
      templateRefs: ['template:sk-tpl-1'],
      ontologySliceRefs: ['projection:proj-1'],
      artifactVersionRefs: ['artifact:doc-1@v3'],
      targetAgent: 'agent-b',
      scope: 'workspace:sp_x',
      permissions: ['read:task_snapshot'],
    });
    expect(pack.pack_id).toMatch(/^cp_/);
    expect(pack.main_skill_ref.asset_id).toBe('sk-handoff');
    expect(pack.asset_ids).toContain('sk-handoff');
    expect(pack.asset_ids).toContain('sk-rule-1');
    // 溯源去重：Main Skill + 2 规则 + 1 模板 + 1 本体 + 1 artifact
    expect(pack.asset_ids.length).toBeGreaterThanOrEqual(5);
    const diff = new Date(pack.expires_at).getTime() - new Date(pack.created_at).getTime();
    expect(Math.abs(diff - 24 * 3_600_000)).toBeLessThan(5_000); // nowIso 与 Date.now 允许毫秒偏差

    const back = await m.readCapabilityPack(UID, pack.pack_id);
    expect(back?.purpose).toContain('接续');
    expect(back?.target_agent).toBe('agent-b');
  });

  it('引用不复制：pack 内无资产正文内容（仅 id/version）', async () => {
    const m = await loadMod();
    const pack = await m.buildCapabilityPack(UID, {
      purpose: '验证不复制',
      mainSkillRef: mainSkill,
      ruleRefs: ['rule:sk-rule-9'],
      targetAgent: 'agent-b',
    });
    const raw = JSON.stringify(pack);
    expect(raw).not.toContain('capabilityStatement');
    expect(raw).not.toContain('SKILL.md');
  });

  it('非法入参抛错：缺 purpose / 非法 main skill ref / 缺 target agent', async () => {
    const m = await loadMod();
    await expect(m.buildCapabilityPack(UID, {
      purpose: '', mainSkillRef: mainSkill, targetAgent: 'agent-b',
    })).rejects.toThrow('requires purpose');
    await expect(m.buildCapabilityPack(UID, {
      purpose: 'x', mainSkillRef: { asset_id: 'bad id!', version: '1' }, targetAgent: 'agent-b',
    })).rejects.toThrow('invalid main skill ref');
    await expect(m.buildCapabilityPack(UID, {
      purpose: 'x', mainSkillRef: mainSkill, targetAgent: '',
    })).rejects.toThrow('requires target agent');
  });

  it('过期判定：默认 24h 未过期；短有效期过期', async () => {
    const m = await loadMod();
    const pack = await m.buildCapabilityPack(UID, {
      purpose: '过期测试', mainSkillRef: mainSkill, targetAgent: 'agent-b',
    });
    expect(m.isCapabilityPackExpired(pack)).toBe(false);
    const expired = { ...pack, expires_at: new Date(Date.now() - 1000).toISOString() };
    expect(m.isCapabilityPackExpired(expired)).toBe(true);
  });

  it('不存在/非法 id → null', async () => {
    const m = await loadMod();
    expect(await m.readCapabilityPack(UID, 'cp_missing')).toBeNull();
    expect(await m.readCapabilityPack(UID, 'bad id')).toBeNull();
  });
});
