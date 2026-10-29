/**
 * Agent 提交副本：用真实临时目录验证"副本里有什么、原件有没有被动过"。
 * 不 mock fs——要测的正是遍历与复制真实目录的结果。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_STAGING_PREFIX, AgentStagingError, destroyAgentStaging, stageAgent, stampOwnerAgent,
} from '../../../../src/main/features/contribution/agent-staging';
import { validateAgentJson } from '../../../../src/main/features/contribution/agent-package-rules';
import { buildPreview } from '../../../../src/main/features/contribution/preview';
import { CONTRIB_STAGING_PREFIX } from '../../../../src/main/features/contribution/staging';

let root: string;
let agentDir: string;
let userSkillsDir: string;
let stagingRoot: string;

const write = (base: string, rel: string, content: string): void => {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const read = (base: string, rel: string): string => fs.readFileSync(path.join(base, rel), 'utf8');
const sources = () => ({ agentDir, userSkillsDir, stagingRoot });

const SKILL_MD = '---\nname: 发票文字识别\ndescription: 识别发票图片\n---\n正文\n';
const baseAgent = {
  agent_id: 'my-expense',
  name: '报销助手',
  description_zh: '核对报销材料',
  workflow: '1. 读材料',
  category: 'office',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  enabled_connectors: ['conn-1'],
  skill_list: ['a3f09c21b7e4', 'invoice-ocr'],
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-staging-'));
  agentDir = path.join(root, 'cloud', 'agents', 'my-expense');
  userSkillsDir = path.join(root, 'cloud', 'skills');
  stagingRoot = path.join(root, 'cache');
  write(agentDir, 'agent.json', JSON.stringify(baseAgent));
  write(userSkillsDir, 'invoice-ocr/SKILL.md', SKILL_MD);
  write(userSkillsDir, 'invoice-ocr/scripts/run.py', 'print(1)\n');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('暂存目录', () => {
  it('前缀与 Skill 的暂存前缀一致，孤儿清理能覆盖到 Agent 副本', () => {
    expect(AGENT_STAGING_PREFIX).toBe(CONTRIB_STAGING_PREFIX);
  });
});

describe('生成副本', () => {
  it('副本里是剥离后的作者原文，且能通过校验', async () => {
    const s = await stageAgent('my-expense', sources());
    const staged = JSON.parse(read(s.dir, 'agent.json')) as Record<string, unknown>;
    expect(staged).not.toHaveProperty('created_at');
    expect(staged).not.toHaveProperty('updated_at');
    expect(staged).not.toHaveProperty('enabled_connectors');
    expect(validateAgentJson(staged).ok).toBe(true);
    expect(s.handled.map((h) => h.field).sort()).toEqual(['created_at', 'enabled_connectors', 'updated_at']);
    expect(path.basename(s.dir).startsWith(AGENT_STAGING_PREFIX)).toBe(true);
  });

  it('原 Agent 与原 Skill 字节不变（只作用于副本）', async () => {
    const beforeAgent = read(agentDir, 'agent.json');
    const beforeSkill = read(userSkillsDir, 'invoice-ocr/SKILL.md');
    await stageAgent('my-expense', sources());
    expect(read(agentDir, 'agent.json')).toBe(beforeAgent);
    expect(read(userSkillsDir, 'invoice-ocr/SKILL.md')).toBe(beforeSkill);
    expect(read(userSkillsDir, 'invoice-ocr/SKILL.md')).not.toContain('ownerAgent');
  });

  it('Hub 依赖不随包，本机自建 Skill 随包并写入 ownerAgent', async () => {
    const s = await stageAgent('my-expense', sources());
    expect(s.hubRefs).toEqual(['a3f09c21b7e4']);
    expect(s.bundledSkills).toEqual(['invoice-ocr']);
    expect(fs.existsSync(path.join(s.dir, 'skills', 'a3f09c21b7e4'))).toBe(false);
    expect(read(s.dir, 'skills/invoice-ocr/SKILL.md')).toContain('ownerAgent: my-expense');
    expect(read(s.dir, 'skills/invoice-ocr/scripts/run.py')).toBe('print(1)\n');
    expect(s.issues).toEqual([]);
  });

  it('包内不出现 _meta.json 与本机安装态文件', async () => {
    write(userSkillsDir, 'invoice-ocr/_install.json', '{}');
    const s = await stageAgent('my-expense', sources());
    const files = buildPreview({ dir: s.dir, sourceSkillId: 'x', token: 't' }).files.map((f) => f.path);
    expect(files).toContain('agent.json');
    expect(files).toContain('skills/invoice-ocr/SKILL.md');
    expect(files.some((f) => f.endsWith('_meta.json'))).toBe(false);
    expect(files.some((f) => f.endsWith('_install.json'))).toBe(false);
  });

  it('不跟随符号链接，链接到副本外的内容不会进包', async () => {
    const outside = path.join(root, 'secret.txt');
    fs.writeFileSync(outside, 'TOP SECRET');
    fs.symlinkSync(outside, path.join(userSkillsDir, 'invoice-ocr', 'leak.txt'));
    const s = await stageAgent('my-expense', sources());
    expect(fs.existsSync(path.join(s.dir, 'skills/invoice-ocr/leak.txt'))).toBe(false);
  });

  it('README.md 随包（可选）', async () => {
    write(agentDir, 'README.md', '# readme');
    const s = await stageAgent('my-expense', sources());
    expect(read(s.dir, 'README.md')).toBe('# readme');
  });

  it('同一份内容两次暂存，预览摘要一致（确定性）', async () => {
    const a = await stageAgent('my-expense', sources());
    const b = await stageAgent('my-expense', sources());
    const key = (d: string) => buildPreview({ dir: d, sourceSkillId: 'x', token: 't' }).digest;
    expect(key(a.dir)).toBe(key(b.dir));
  });
});

describe('异常与阻断', () => {
  it('本机缺少被引用的私有 Skill → 登记问题，不静默放行', async () => {
    fs.rmSync(path.join(userSkillsDir, 'invoice-ocr'), { recursive: true });
    const s = await stageAgent('my-expense', sources());
    expect(s.bundledSkills).toEqual([]);
    expect(s.issues.map((i) => i.rule)).toContain('skill_ref.local_missing');
  });

  it('私有 Skill 没有 frontmatter → 登记问题', async () => {
    write(userSkillsDir, 'invoice-ocr/SKILL.md', '没有 frontmatter');
    const s = await stageAgent('my-expense', sources());
    expect(s.issues.map((i) => i.rule)).toContain('private_skill.frontmatter');
  });

  it('有私有 Skill 但 agent.json 没有 agent_id → 登记问题', async () => {
    const noId: Record<string, unknown> = { ...baseAgent };
    delete noId.agent_id;
    write(agentDir, 'agent.json', JSON.stringify(noId));
    const s = await stageAgent('my-expense', sources());
    expect(s.issues.map((i) => i.rule)).toContain('private_skill.owner');
  });

  it('宿主专有 / 外接运行时 / crown 登记为阻断项', async () => {
    write(agentDir, 'agent.json', JSON.stringify({ ...baseAgent, management_surface: 'expense', runtime: { kind: 'cli' }, icon: 'crown' }));
    const s = await stageAgent('my-expense', sources());
    expect(s.blockers.map((b) => b.rule).sort()).toEqual([
      'agent.host_only', 'agent.icon_not_distributable', 'agent.runtime_not_distributable',
    ]);
  });

  it('Agent 不存在 / 不是 JSON / id 不安全 → 抛 AgentStagingError', async () => {
    await expect(stageAgent('nope', { ...sources(), agentDir: path.join(root, 'cloud/agents/nope') }))
      .rejects.toMatchObject({ code: 'agent_missing' });
    write(agentDir, 'agent.json', '{not json');
    await expect(stageAgent('my-expense', sources())).rejects.toBeInstanceOf(AgentStagingError);
    await expect(stageAgent('../etc', sources())).rejects.toMatchObject({ code: 'invalid_agent_id' });
  });

  it('失败不留半成品副本', async () => {
    write(agentDir, 'agent.json', '[]');
    await expect(stageAgent('my-expense', sources())).rejects.toBeInstanceOf(AgentStagingError);
    const leftovers = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : [];
    expect(leftovers).toEqual([]);
  });

  it('destroyAgentStaging 清掉副本且不抛错', async () => {
    const s = await stageAgent('my-expense', sources());
    await destroyAgentStaging(s);
    expect(fs.existsSync(s.dir)).toBe(false);
    await expect(destroyAgentStaging(s)).resolves.toBeUndefined();
  });
});

describe('stampOwnerAgent', () => {
  it('没有时插入，已有时替换，保留正文', () => {
    expect(stampOwnerAgent('---\nname: a\n---\nbody\n', 'ag1')).toBe('---\nname: a\nownerAgent: ag1\n---\nbody\n');
    expect(stampOwnerAgent('---\nname: a\nownerAgent: old\n---\nbody\n', 'ag1')).toBe('---\nname: a\nownerAgent: ag1\n---\nbody\n');
  });
  it('无 frontmatter 返回 null', () => {
    expect(stampOwnerAgent('# 无', 'ag1')).toBeNull();
  });
  it('保留 CRLF', () => {
    expect(stampOwnerAgent('---\r\nname: a\r\n---\r\nbody\r\n', 'ag1')).toBe('---\r\nname: a\r\nownerAgent: ag1\r\n---\r\nbody\r\n');
  });
});
