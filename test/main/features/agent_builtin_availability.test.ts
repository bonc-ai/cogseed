/**
 * 内置能力在本机是否具备：开放清单内 + 系统 Skill 已就位 + 客户端版本够。任何一项不满足都不具备。
 * 路径指向真实临时目录，要测的正是"盘上有没有、版本够不够"。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;

vi.mock('../../../src/main/paths', () => ({
  userMarketplaceAgentSkillsDir: (uid: string, id: string) => path.join(root, uid, 'mp-agents', id, 'skills'),
  userMarketplaceSkillDir: (uid: string, id: string) => path.join(root, uid, 'mp-skills', id),
  userSkillsDir: (uid: string) => path.join(root, uid, 'skills'),
  userSystemSkillDir: (uid: string, id: string) => path.join(root, uid, 'system', id),
}));
vi.mock('../../../src/main/features/marketplace/installed-version', () => ({
  readContentStatus: () => ({ raw: '', availability: 'available' }),
}));

import { builtinCapabilityAvailable, readAgentDependencyState } from '../../../src/main/features/agent_dependency_state';

const installSystemSkill = (name: string): void => {
  const dir = path.join(root, 'u1', 'system', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-avail-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('builtinCapabilityAvailable', () => {
  it('系统 Skill 已就位且版本够 → 具备', () => {
    installSystemSkill('coding');
    expect(builtinCapabilityAvailable('u1', 'coding', '1.3.0')).toBe(true);
    expect(builtinCapabilityAvailable('u1', 'coding', '2.0.0')).toBe(true);
  });

  it('客户端版本低于引入版本 → 不具备', () => {
    installSystemSkill('coding');
    expect(builtinCapabilityAvailable('u1', 'coding', '1.2.9')).toBe(false);
  });

  it('版本未知（空串）→ 不具备（失败关闭）', () => {
    installSystemSkill('coding');
    expect(builtinCapabilityAvailable('u1', 'coding', '')).toBe(false);
  });

  it('系统 Skill 没就位 → 不具备', () => {
    expect(builtinCapabilityAvailable('u1', 'coding', '1.3.0')).toBe(false);
  });

  it('不在开放清单内，即使系统 Skill 在盘上也不具备', () => {
    installSystemSkill('package-installer');
    expect(builtinCapabilityAvailable('u1', 'package-installer', '9.9.9')).toBe(false);
    expect(builtinCapabilityAvailable('u1', 'nope', '9.9.9')).toBe(false);
  });
});

describe('readAgentDependencyState 与内置能力', () => {
  it('引用的内置能力具备 → ready', () => {
    installSystemSkill('grounded-material-qa');
    expect(readAgentDependencyState('u1', 'agent1', ['builtin:grounded-material-qa'], '1.3.0')).toEqual({ status: 'ready', ids: [] });
  });

  it('引用的内置能力本机没有 → deps_blocked，并指出是哪个', () => {
    expect(readAgentDependencyState('u1', 'agent1', ['builtin:coding'], '1.3.0')).toEqual({ status: 'deps_blocked', ids: ['builtin:coding'] });
  });

  it('不传版本时一律不具备', () => {
    installSystemSkill('coding');
    expect(readAgentDependencyState('u1', 'agent1', ['builtin:coding']).status).toBe('deps_blocked');
  });
});
