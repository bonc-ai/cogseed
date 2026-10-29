/**
 * Agent 贡献准入：用真实暂存副本 + 注入的扫描器替身，验证"什么情况下不得提交"。
 * 扫描器本身（深扫、声明门）已有各自的测试，这里只验证 Agent 层的汇总口径。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { admitAgentContribution } from '../../../../src/main/features/contribution/agent-admission';
import { stageAgent } from '../../../../src/main/features/contribution/agent-staging';
import type { ContributionAdmission } from '../../../../src/main/features/contribution/admission';
import type { ValidationReport } from '../../../../src/main/quality';

let root: string;
const write = (rel: string, content: string): void => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const sources = () => ({
  agentDir: path.join(root, 'cloud/agents/my-expense'),
  userSkillsDir: path.join(root, 'cloud/skills'),
  stagingRoot: path.join(root, 'cache'),
});

const SKILL_MD = '---\nname: ocr\ndescription: d\n---\nbody\n';
const agent = {
  agent_id: 'my-expense', name: '报销助手', description_zh: '核对材料', workflow: '1. 读', category: 'office',
  skill_list: ['a3f09c21b7e4', 'invoice-ocr'],
};

const okReport: ValidationReport = { ok: true, violations: [], validated_at: 'x', validator_version: 'x' };
const admission = (outcome: 'pass' | 'blocked' | 'incomplete', reason?: string): ContributionAdmission =>
  ({ outcome, ...(reason ? { reason } : {}) } as unknown as ContributionAdmission);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-admission-'));
  write('cloud/agents/my-expense/agent.json', JSON.stringify(agent));
  write('cloud/skills/invoice-ocr/SKILL.md', SKILL_MD);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const deps = (over: Record<string, unknown> = {}) => ({
  admitSkill: vi.fn(async () => admission('pass')),
  validateAgentSpec: vi.fn(() => okReport),
  ...over,
});

describe('通过路径', () => {
  it('Agent 合法、随包 Skill 都通过 → pass，且每个随包 Skill 各跑一次准入', async () => {
    const d = deps();
    const s = await stageAgent('my-expense', sources());
    const r = await admitAgentContribution(s, d);
    expect(r.outcome).toBe('pass');
    expect(r.blocking).toEqual([]);
    expect(d.admitSkill).toHaveBeenCalledTimes(1);
    const arg = (d.admitSkill.mock.calls[0] as unknown[])[0] as { dir: string; sourceSkillId: string };
    expect(arg.sourceSkillId).toBe('invoice-ocr');
    expect(arg.dir.endsWith(path.join('skills', 'invoice-ocr'))).toBe(true);
    expect(r.skills).toEqual([{ name: 'invoice-ocr', outcome: 'pass' }]);
  });

  it('没有随包 Skill 时不跑 Skill 准入', async () => {
    write('cloud/agents/my-expense/agent.json', JSON.stringify({ ...agent, skill_list: ['a3f09c21b7e4'] }));
    const d = deps();
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), d);
    expect(r.outcome).toBe('pass');
    expect(d.admitSkill).not.toHaveBeenCalled();
  });
});

describe('阻断路径（任何一项都不得提交）', () => {
  it('一个随包 Skill 被阻断 → 整个 Agent 被阻断，并指出是哪个 Skill', async () => {
    const d = deps({ admitSkill: vi.fn(async () => admission('blocked', 'declaration_absent')) });
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), d);
    expect(r.outcome).toBe('blocked');
    const issue = r.blocking.find((i) => i.code === 'PRIVATE_SKILL_CHECK_FAILED');
    expect(issue?.skill).toBe('invoice-ocr');
    expect(issue?.rule).toBe('skill.declaration_absent');
  });

  it('多个随包 Skill：一个通过一个阻断，只报阻断的那个', async () => {
    write('cloud/agents/my-expense/agent.json', JSON.stringify({ ...agent, skill_list: ['invoice-ocr', 'second'] }));
    write('cloud/skills/second/SKILL.md', SKILL_MD);
    const admitSkill = vi.fn(async (s: { sourceSkillId: string }) => (s.sourceSkillId === 'second' ? admission('blocked', 'local_red_lines') : admission('pass')));
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), deps({ admitSkill }));
    expect(r.outcome).toBe('blocked');
    expect(r.blocking.filter((i) => i.code === 'PRIVATE_SKILL_CHECK_FAILED').map((i) => i.skill)).toEqual(['second']);
    expect(r.skills.map((s) => [s.name, s.outcome])).toEqual([['invoice-ocr', 'pass'], ['second', 'blocked']]);
  });

  it('随包 Skill 结论为 incomplete（如声明待补）→ 整体 incomplete，不是 pass', async () => {
    const d = deps({ admitSkill: vi.fn(async () => admission('incomplete')) });
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), d);
    expect(r.outcome).toBe('incomplete');
    expect(r.blocking).toEqual([]);
  });

  it('宿主专有 / 外接运行时 / crown → 阻断，规则名可定位', async () => {
    write('cloud/agents/my-expense/agent.json', JSON.stringify({ ...agent, management_surface: 'x', icon: 'crown' }));
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), deps());
    expect(r.outcome).toBe('blocked');
    expect(r.blocking.map((i) => i.rule)).toEqual(expect.arrayContaining(['agent.host_only', 'agent.icon_not_distributable']));
  });

  it('本机缺少被引用的私有 Skill → 阻断', async () => {
    fs.rmSync(path.join(root, 'cloud/skills/invoice-ocr'), { recursive: true });
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), deps());
    expect(r.outcome).toBe('blocked');
    expect(r.blocking.map((i) => i.rule)).toContain('skill_ref.local_missing');
  });

  it('skill_list 里 builtin: 在开放清单内 → 通过（不随包、不阻断）', async () => {
    write('cloud/agents/my-expense/agent.json', JSON.stringify({ ...agent, skill_list: ['builtin:grounded-material-qa'] }));
    const d = deps();
    const s = await stageAgent('my-expense', sources());
    expect(s.builtinRefs).toEqual(['builtin:grounded-material-qa']);
    expect(s.bundledSkills).toEqual([]);
    const r = await admitAgentContribution(s, d);
    expect(r.outcome).toBe('pass');
    expect(d.admitSkill).not.toHaveBeenCalled();
  });

  it('skill_list 里 builtin: 不在开放清单内 → 阻断，原因是清单外而不是笼统的不支持', async () => {
    write('cloud/agents/my-expense/agent.json', JSON.stringify({ ...agent, skill_list: ['builtin:package-installer'] }));
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), deps());
    expect(r.outcome).toBe('blocked');
    expect(r.blocking.map((i) => i.rule)).toContain('skill_ref.builtin_unknown');
  });

  it('Agent 本体红线（EXTREME）→ 阻断；上行信息不含命中原文', async () => {
    const report: ValidationReport = {
      ok: false, validated_at: 'x', validator_version: 'x',
      violations: [{ level: 'EXTREME', rule: 'private_key_block', field: 'workflow', snippet: '-----BEGIN PRIVATE KEY-----SECRET', suggested_fix: 'remove it' }],
    } as unknown as ValidationReport;
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), deps({ validateAgentSpec: vi.fn(() => report) }));
    expect(r.outcome).toBe('blocked');
    const issue = r.blocking.find((i) => i.code === 'AGENT_RED_LINE');
    expect(issue?.rule).toBe('private_key_block');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('非 EXTREME 红线不阻断', async () => {
    const report: ValidationReport = {
      ok: false, validated_at: 'x', validator_version: 'x',
      violations: [{ level: 'MEDIUM', rule: 'some_rule', field: 'workflow', snippet: 's', suggested_fix: 'f' }],
    } as unknown as ValidationReport;
    const r = await admitAgentContribution(await stageAgent('my-expense', sources()), deps({ validateAgentSpec: vi.fn(() => report) }));
    expect(r.outcome).toBe('pass');
  });

  it('包上限预检：文件数超限 → 阻断；上限来自注入配置而非写死', async () => {
    const s = await stageAgent('my-expense', sources());
    const tight = { maxCompressedBytes: 1 << 20, maxFiles: 1, maxUnpackedBytes: 1 << 20, maxEntryCompressionRatio: 100 };
    const r = await admitAgentContribution(s, deps({ limits: tight }));
    expect(r.outcome).toBe('blocked');
    expect(r.blocking.map((i) => i.rule)).toContain('package.too_many_files');

    const loose = { ...tight, maxFiles: 500 };
    expect((await admitAgentContribution(s, deps({ limits: loose }))).outcome).toBe('pass');
  });
});
