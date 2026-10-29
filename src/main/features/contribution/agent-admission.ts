/**
 * Agent 贡献准入 —— 对 Agent **提交副本**跑，判定后不落地。
 *
 * 做的事（任何一项未通过都不得上传）：
 * 1. 暂存阶段登记的阻断项与问题（宿主专有、外接运行时、`crown`、本机缺少被引用的私有 Skill 等）；
 * 2. `agent.json` 严格校验（`validateAgentJson`，多余字段拒绝而非忽略）；
 * 3. 包上限预检（文件数、解包大小；压缩后与压缩比在打包后判，见 `agent-submission-request`）；
 * 4. Agent 本体文本走 `src/main/quality` 红线（私钥、读取凭据、`curl | sh` 等）；
 * 5. **每个随包私有 Skill 各跑一次**现有 `admitContribution`（本地红线 + 深扫 + 社区安全声明门）。
 *    Hub 2026-10-12 已定：随包 Skill 与独立社区 Skill 同标准，每个都须带
 *    `references/security-manifest.yaml`；因此这里不另写一套规则，复用判定、逐个汇总。
 *
 * 上行的问题**不含命中原文与本机绝对路径**（C-03）：Agent 红线只留规则 id、级别与字段名。
 *
 * 依赖通过 `deps` 注入：默认值延迟加载，测试可替换，不必拉起扫描器与 Electron。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ValidationReport } from '../../quality';
import type { ContributionAdmission, ContributionOutcome } from './admission';
import {
  checkPackageLimits, DEFAULT_PACKAGE_LIMITS, validateAgentJson, type PackageLimits,
} from './agent-package-rules';
import type { AgentStaging } from './agent-staging';
import { buildPreview } from './preview';
import type { ContributionStaging } from './staging';

export type AgentAdmissionOutcome = 'pass' | 'blocked' | 'incomplete';

/** 一条检查问题。不含命中原文与本机路径，可直接展示与上行。 */
export interface AgentCheckIssue {
  /** 域内码：对应 Hub `server_check.blocking[].code`，或本机专有码。 */
  code: string;
  rule: string;
  /** 包内相对路径或字段路径。 */
  path?: string;
  /** 问题出在哪个随包 Skill；Agent 本体的问题为空。 */
  skill?: string;
  message: string;
}

export interface AgentSkillAdmission {
  name: string;
  outcome: ContributionOutcome;
  reason?: string;
}

export interface AgentAdmission {
  outcome: AgentAdmissionOutcome;
  /** 阻断项：非空即不得提交。 */
  blocking: AgentCheckIssue[];
  /** 逐个随包 Skill 的结论，供预览页展示。 */
  skills: AgentSkillAdmission[];
}

export interface AgentAdmissionDeps {
  admitSkill?: (staging: ContributionStaging) => Promise<ContributionAdmission>;
  validateAgentSpec?: (args: { agentJson: unknown; enforceSkillRunner?: boolean }) => ValidationReport;
  limits?: Readonly<PackageLimits>;
}

async function resolveDeps(deps: AgentAdmissionDeps): Promise<Required<AgentAdmissionDeps>> {
  return {
    admitSkill: deps.admitSkill ?? (await import('./admission')).admitContribution,
    validateAgentSpec: deps.validateAgentSpec ?? (await import('../../quality')).validateAgentSpec,
    limits: deps.limits ?? DEFAULT_PACKAGE_LIMITS,
  };
}

export async function admitAgentContribution(
  staging: AgentStaging,
  deps: AgentAdmissionDeps = {},
): Promise<AgentAdmission> {
  const d = await resolveDeps(deps);
  const blocking: AgentCheckIssue[] = [];

  for (const b of staging.blockers) {
    blocking.push({ code: 'AGENT_NOT_DISTRIBUTABLE', rule: b.rule, path: b.field, message: b.message });
  }
  for (const i of staging.issues) {
    blocking.push({ code: i.code, rule: i.rule, path: i.path, message: i.message });
  }

  // agent.json 严格校验
  let agentJson: unknown = null;
  try {
    agentJson = JSON.parse(fs.readFileSync(path.join(staging.dir, 'agent.json'), 'utf8'));
  } catch {
    blocking.push({ code: 'AGENT_SCHEMA_INVALID', rule: 'agent.json.unreadable', path: 'agent.json', message: 'agent.json is missing or not valid JSON' });
  }
  if (agentJson !== null) {
    const validated = validateAgentJson(agentJson);
    if (validated.ok === false) {
      for (const i of validated.issues) blocking.push({ code: i.code, rule: i.rule, path: i.path, message: i.message });
    }

    // Agent 本体文本红线。上行只留规则与级别，不留 snippet。
    const report = d.validateAgentSpec({ agentJson, enforceSkillRunner: false });
    if (!report.ok) {
      for (const v of report.violations) {
        if ((v.original_level || v.level) !== 'EXTREME') continue;
        blocking.push({ code: 'AGENT_RED_LINE', rule: v.rule, path: v.field, message: v.suggested_fix || v.rule });
      }
    }
  }

  // 包上限预检（压缩后与压缩比在打包后判）
  const preview = buildPreview(staging);
  for (const v of checkPackageLimits({ fileCount: preview.files.length, unpackedBytes: preview.totalBytes }, d.limits)) {
    blocking.push({ code: 'PACKAGE_LIMIT', rule: `package.${v.kind}`, message: `${v.kind}: ${v.actual} > ${v.limit}` });
  }

  // 逐个随包 Skill 跑现有准入
  const skills: AgentSkillAdmission[] = [];
  for (const name of staging.bundledSkills) {
    const skillStaging: ContributionStaging = {
      dir: path.join(staging.dir, 'skills', name), sourceSkillId: name, token: staging.token,
    };
    const a = await d.admitSkill(skillStaging);
    skills.push({ name, outcome: a.outcome, ...(a.reason ? { reason: a.reason } : {}) });
  }

  const skillBlocked = skills.filter((s) => s.outcome === 'blocked');
  for (const s of skillBlocked) {
    blocking.push({
      code: 'PRIVATE_SKILL_CHECK_FAILED', rule: `skill.${s.reason ?? 'blocked'}`, skill: s.name,
      path: `skills/${s.name}`, message: `bundled skill ${s.name} did not pass the contribution check`,
    });
  }

  let outcome: AgentAdmissionOutcome = 'pass';
  if (blocking.length > 0) outcome = 'blocked';
  else if (skills.some((s) => s.outcome === 'incomplete')) outcome = 'incomplete';
  return { outcome, blocking, skills };
}
