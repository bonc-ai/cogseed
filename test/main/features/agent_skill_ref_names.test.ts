import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const UID = 'u-agent-skill-ref-names';
/**
 * 合成长中文名技能：`safeId`（仅 ASCII）过不了，正是这条用例要覆盖的形态。
 *
 * **不依赖随包内容**（2026-10-21 起随包不再包含中文名技能）：夹具在本机技能目录里现场生成。
 * id 仍取 12 位十六进制，保持与市场技能同一形态。
 */
const CN_SKILL_ID = '36867a076129';
const CN_SKILL_NAME = '中文名测试技能';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-skillref-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const paths = await import('../../../src/main/paths');
  const dest = path.join(paths.userMarketplaceSkillsDir(UID), CN_SKILL_ID);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, 'SKILL.md'),
    `---\nname: ${CN_SKILL_NAME}\ndescription: 合成夹具\n---\n\n# ${CN_SKILL_NAME}\n`,
    'utf8',
  );
  const reg = await import('../../../src/main/model/core-agent/skill-registry');
  await reg.invalidateSkills();
  const agents = await import('../../../src/main/features/agents');
  const created = await agents.createCustomAgentForUser(UID, {
    name: 'SkillRefTester', description: 'd', workflow: 'w', category: 'office',
  } as never);
  return { agents, agentId: (created as { agent_id: string }).agent_id };
}

describe('Agent 的 skill_list：按名字引用技能', () => {
  it('中文名技能按名字写入，保存为它的 id（此前被静默丢成空数组）', async () => {
    const { agents, agentId } = await setup();
    const saved = await agents.updateCustomAgentForUser(UID, agentId, { skill_list: [CN_SKILL_NAME] } as never);
    expect((saved as { skill_list?: string[] }).skill_list).toEqual([CN_SKILL_ID]);
  });

  it('按 id 写入仍然可用', async () => {
    const { agents, agentId } = await setup();
    const saved = await agents.updateCustomAgentForUser(UID, agentId, { skill_list: [CN_SKILL_ID] } as never);
    expect((saved as { skill_list?: string[] }).skill_list).toEqual([CN_SKILL_ID]);
  });

  it('名字和 id 指向同一个技能时只保存一份', async () => {
    const { agents, agentId } = await setup();
    const saved = await agents.updateCustomAgentForUser(UID, agentId, { skill_list: [CN_SKILL_NAME, CN_SKILL_ID] } as never);
    expect((saved as { skill_list?: string[] }).skill_list).toEqual([CN_SKILL_ID]);
  });

  it('本机没有的技能名不会保存', async () => {
    const { agents, agentId } = await setup();
    const saved = await agents.updateCustomAgentForUser(UID, agentId, { skill_list: [CN_SKILL_NAME, 'no-such-skill', '不存在的技能'] } as never);
    expect((saved as { skill_list?: string[] }).skill_list).toEqual([CN_SKILL_ID]);
  });
});

describe('unresolvedSkillRefsForAgent：告诉用户哪些没保存', () => {
  it('只报本机解析不出来的（ASCII 与中文名都算），已存在的不报', async () => {
    const { agents, agentId } = await setup();
    const dropped = await agents.unresolvedSkillRefsForAgent(UID, agentId, [CN_SKILL_NAME, CN_SKILL_ID, 'no-such-skill', '不存在的技能']);
    expect(dropped).toEqual(['no-such-skill', '不存在的技能']);
  });

  it('内置能力（builtin:）不在这里报；非数组与空值返回空', async () => {
    const { agents, agentId } = await setup();
    expect(await agents.unresolvedSkillRefsForAgent(UID, agentId, ['builtin:coding'])).toEqual([]);
    expect(await agents.unresolvedSkillRefsForAgent(UID, agentId, undefined)).toEqual([]);
    expect(await agents.unresolvedSkillRefsForAgent(UID, agentId, 'x')).toEqual([]);
    expect(await agents.unresolvedSkillRefsForAgent(UID, agentId, ['', '  '])).toEqual([]);
  });
});
