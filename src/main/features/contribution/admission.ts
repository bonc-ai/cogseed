/**
 * 贡献准入判定 —— 对**提交副本**跑，判定后不落地。
 *
 * ## 与安装准入的关系：复用判定，不复用结论
 *
 * 本模块复用 `validateSkillDir`（本地红线）与 `scanSkillDir`（深扫 + 指令审计）两个
 * **纯判定**入口，但**不**复用 `scanVerdictBlocksInstall` / `resolveInstallDecision`
 * 的阻断口径。原因是两个场景的风险方向相反：
 *
 * | | 安装 | 贡献 |
 * |---|---|---|
 * | 内容去向 | 进本机 | **出本机，进公开 Hub** |
 * | 风险承担方 | 用户自己 | **其他用户与平台** |
 * | 误拦代价 | 装不上 | 改一下重试 |
 * | 漏放代价 | 一台机器 | **公开目录里的一份恶意内容** |
 *
 * 代价不对称，判据就该不同。逐条差异见下方各 `RULE_*` 常量的注释。
 *
 * ## 为什么不叫 `scanVerdictBlocksContribution` 放进 sentry-adapter
 *
 * 那会让一个安全判据有两个出口，而 `sentry-adapter` 的注释已经记过同类教训：
 * 「With a fifth outcome now in the union, those comparisons would each silently
 * admit `scanner_absent` by simply not matching it」。贡献判据放在贡献模块里，
 * 新增 outcome 时两边各自 fail closed，不会有一边靠"没匹配上"默默放行。
 */
import { validateSkillDir, type Level, type ValidationReport, type Violation } from '../../quality';
import { scanSkillDir, type SentryScanResult, type ScanOutcome } from '../security/sentry-adapter';
import { createLogger } from '../../logger';
import { gateDeclaration, type DeclarationGateResult, type DeclarationBlockReason } from './declaration';
import { contributionComponents, componentsReady, type ContributionComponents } from './components';
import type { ContributionStaging } from './staging';

const log = createLogger('contribution/admission');

/** 贡献准入结论。`pass` 之外一律不得上传任何 Skill 内容（`C-FR-003a`）。 */
export type ContributionOutcome = 'pass' | 'blocked' | 'incomplete';

/** 阻断原因。机器可读，UI 据此选引导文案。 */
export type ContributionBlockReason =
  | 'local_red_lines'      // 本地 EXTREME 红线
  | 'scan_refused'         // 深扫判定拒绝（blocked）
  | 'scan_restricted'      // CAUTION → restricted，贡献侧拦（R-1）
  | 'scan_unavailable'     // unknown：检查该跑而没跑成
  | 'scanner_absent'       // 本构建未含深扫组件（R-3）
  | 'rules_degraded'       // 规则集降级，结论不可采信（R-7）
  | 'instruction_risk'     // 指令审计判为可疑（R-4）
  | 'instruction_unavailable'  // 指令审计未能完成（R-4）
  | 'components_not_ready'     // 检查组件缺失/被篡改/pin 不符，结论不可采信
  | DeclarationBlockReason;    // 社区安全声明门（Hub FR-010 要求随包必需）

export interface ContributionAdmission {
  outcome: ContributionOutcome;
  reason?: ContributionBlockReason;
  /** 本地红线报告。始终存在——它是第一道且无条件跑。 */
  report: ValidationReport;
  /** 深扫结果。本地红线就拦下时为 `null`（没跑）。 */
  scan: SentryScanResult | null;
  /** 声明门结果。走到该步之前拦下时为 `null`。 */
  declaration: DeclarationGateResult | null;
  /** 组件版本与就绪快照。始终存在——它是第一道门。 */
  components: ContributionComponents;
  /** 组件未就绪时的阻塞项，供 UI 逐条说明。 */
  componentsBlocking?: string[];
}
/**
 * R-1：`restricted`（引擎 `CAUTION`）在贡献侧**阻断**。
 *
 * `scan_gate.py:168-173` 把 `CAUTION` 判成 `restricted` 并放行安装，注释理由是
 * 「CAUTION 是个宽桶……一刀切拒绝会让普通社区内容**装不上**」——那是安装场景的理由。
 * 贡献侧拦住的代价是贡献者按 findings 改完重试；不拦的代价是一份带风险的内容进了
 * 公开目录，而 Hub 接受时还会再跑一次社区档检查（Hub `FR-015`），等于把返工推到更晚。
 *
 * ⚠️ 不提供 override（R-2）。`scanVerdictAllowsOverride` 的产品理由逐字是
 * 「the user owns their machine and gets the final say」——内容离开本机后这个理由不成立，
 * 点穿的人和承担后果的人不是同一批。
 */
const RULE_BLOCK_RESTRICTED = true;

/**
 * R-3：`scanner_absent` 在贡献侧**阻断**。
 *
 * 该状态是受支持的产品形态（精简开源构建刻意不带引擎），安装侧放行是对的——
 * 本地红线仍在跑，`scanner_absent` 意味着"覆盖减少"而非"未检查"。但往公开 Hub 发东西
 * 不能在缺少深扫的前提下进行，否则客户端等于声称"检查过了"而实际没有。
 */
const RULE_BLOCK_SCANNER_ABSENT = true;

/**
 * R-7：`rulesDegraded` 在贡献侧**阻断**。
 *
 * PyYAML 不可用时引擎**静默**回退到更小的内置规则集（`SentryScanResult.rulesSource`
 * 注释记了实测：同一 SSH-key 外泄样本，无 PyYAML `ALLOW/100`，有 PyYAML `DO_NOT_INSTALL/20`）。
 * 降级规则集产出的 `pass` 与真 `pass` 外观完全相同，安装侧有风险卡兜底，贡献侧没有。
 */
const RULE_BLOCK_RULES_DEGRADED = true;

/**
 * R-4：`instructionRisk` 纳入贡献阻断判据。
 *
 * `instruction-audit.ts` 模块文档明写「**It does not block**」——安装侧只呈现不拦，
 * 因为「攻击需要用户配合，误判教学类 skill 的代价不该是装不上」。
 *
 * 贡献侧相反。该文档记的三个实测样本在深扫下全部 `pass`/score 100：
 * 诱导粘贴 AWS Key 并 POST、诱导把 `scanVerdictBlocksInstall` 改成 `false`、
 * 偷发会话摘要不告知用户。**这正是最不该进公开目录的东西**，而代码层完全看不见。
 *
 * `unavailable` 同样阻断：按 `C-FR-003d`「必需检查未完成 → 停止提交」。注意它与
 * `clean` 的区别是 `_withInstructionRisk` 刻意维持的——「passages were recalled and
 * nobody read them」不等于"没问题"。
 */
const RULE_BLOCK_INSTRUCTION_SUSPICIOUS = true;

/** `_blocked` 的同义构造器，仅供组件门那一步用展开语法附加 `componentsBlocking`。 */
const _blockedShape = (
  reason: ContributionBlockReason,
  report: ValidationReport,
  scan: SentryScanResult | null,
  components: ContributionComponents,
): ContributionAdmission => _blocked(reason, report, scan, components);

function _blocked(
  reason: ContributionBlockReason,
  report: ValidationReport,
  scan: SentryScanResult | null,
  components: ContributionComponents,
  declaration: DeclarationGateResult | null = null,
): ContributionAdmission {
  return { outcome: 'blocked', reason, report, scan, declaration, components };
}

/**
 * 对提交副本执行贡献准入判定。
 *
 * 顺序承重，与 `custom-skill-admission.ts` 同一依据：本地红线与深扫先判**作者内容**。
 * 该模块注释记了实测——用干净模板稀释可疑 Skill 会把 `chmod 777` + env-driven POST
 * 从 `restricted` 抬到 `pass`。所以贡献流程的资料补齐（名称/说明/版本/声明）必须在本
 * 判定**之后**，且补齐后要重跑本判定（`C-FR-004c`），不能靠补齐冲淡结论。
 *
 * 永不抛错：任何基础设施问题都落到 `blocked` + 具体 reason，不让贡献流程以未捕获异常收场。
 */
export async function admitContribution(staging: ContributionStaging): Promise<ContributionAdmission> {
  // ⓪ 组件门。放在最前：任一检查组件缺失、被篡改或 pin 不符时，后面每一步得到的
  //    结论都不能采信，而贡献者会把它读成"检查过了"。宁可不开始，也不给一个
  //    看起来像通过的结果。
  const components = contributionComponents();
  const readiness = componentsReady(components);
  const emptyReport: ValidationReport = {
    ok: false, violations: [], validated_at: new Date().toISOString(), validator_version: 'n/a',
  };
  if (!readiness.ready) {
    log.warn('contribution blocked: components not ready', {
      token: staging.token, blocking: readiness.blocking,
    });
    return {
      ..._blockedShape('components_not_ready', emptyReport, null, components),
      componentsBlocking: readiness.blocking,
    };
  }

  // ① 本地红线，无条件先跑。EXTREME 即拦，不进深扫。
  const report = validateSkillDir(staging.dir, { enforceSkillRunner: false });
  if (!report.ok) {
    log.warn('contribution blocked by local red lines', {
      token: staging.token,
      rules: report.violations
        .filter((v) => (v.original_level || v.level) === 'EXTREME')
        .map((v) => v.rule),
    });
    return _blocked('local_red_lines', report, null, components);
  }

  // ② 深扫 + 指令审计。`scanSkillDir` 永不抛错，失败一律落 `unknown`。
  //
  //    `source` 传 'community' 只为**记录与展示**：`scanSkillDir` 的文档明写
  //    「no longer changes the verdict: the threshold lives in scan_gate.py and
  //    applies equally to every tier」。所以贡献侧的收紧**不能**靠档位表达，
  //    只能靠下面这组显式判据——这也是 `C-FR-003c/003d` 需要改写的原因。
  const scan = await scanSkillDir(staging.dir, 'community');

  if (RULE_BLOCK_RULES_DEGRADED && scan.rulesDegraded === true) {
    log.warn('contribution blocked: ruleset degraded', { token: staging.token, rulesSource: scan.rulesSource });
    return _blocked('rules_degraded', report, scan, components);
  }

  const outcomeBlock = _blockReasonForOutcome(scan.outcome);
  if (outcomeBlock) {
    log.warn('contribution blocked by scan outcome', { token: staging.token, outcome: scan.outcome });
    return _blocked(outcomeBlock, report, scan, components);
  }

  if (RULE_BLOCK_INSTRUCTION_SUSPICIOUS) {
    const status = scan.instructionRisk?.status;
    if (status === 'suspicious') {
      log.warn('contribution blocked by instruction risk', { token: staging.token });
      return _blocked('instruction_risk', report, scan, components);
    }
    // 审计没跑成 ≠ 干净。`_withInstructionRisk` 刻意区分了这两者。
    if (status === 'unavailable' || status === undefined) {
      log.warn('contribution blocked: instruction audit unavailable', {
        token: staging.token,
        reason: scan.instructionRisk?.unavailableReason,
      });
      return _blocked('instruction_unavailable', report, scan, components);
    }
  }

  // ③ 社区安全声明门。放在深扫之后：声明描述的是"这个 Skill 会做什么"，
  //    而深扫看的是"它实际写了什么"。先确认内容本身不危险，再看声明是否如实。
  //    顺序反过来会让一份危险内容因为"声明写得齐全"而先过一道门。
  const declaration = await gateDeclaration(staging);
  if (declaration.outcome === 'blocked') {
    log.warn('contribution blocked by declaration gate', {
      token: staging.token, reason: declaration.reason,
    });
    return _blocked(declaration.reason!, report, scan, components, declaration);
  }

  return { outcome: 'pass', report, scan, declaration, components };
}

/**
 * 把扫描结论映射到贡献侧的阻断原因，`null` 表示放行。
 *
 * 显式穷举而非 `if (blocks)`：新增 outcome 时必须在这里做一次决定，不能靠"没匹配上"
 * 默认放行——那正是 `sentry-adapter` 注释里记过的坑。
 */
function _blockReasonForOutcome(outcome: ScanOutcome): ContributionBlockReason | null {
  switch (outcome) {
    case 'pass':
      return null;
    case 'blocked':
      return 'scan_refused';
    case 'unknown':
      return 'scan_unavailable';
    case 'restricted':
      return RULE_BLOCK_RESTRICTED ? 'scan_restricted' : null;
    case 'scanner_absent':
      return RULE_BLOCK_SCANNER_ABSENT ? 'scanner_absent' : null;
    default: {
      // 联合被穷举时不可达；新增 outcome 必须 fail closed。
      const _exhaustive: never = outcome;
      void _exhaustive;
      return 'scan_unavailable';
    }
  }
}

/**
 * 把一条本地红线整理成**可上行**的形态。
 *
 * ⚠️ `Violation.snippet` 的类型注释逐字是「**Quoted excerpt of the offending content**」——
 * 命中原文。而跨端契约 C-03 明确规定上行 `Issue.message` 不得包含命中原文、本机绝对路径、
 * 凭据、任务正文、Prompt 或私人实例 ID。原样上行等于把要拦的东西亲手发出去。
 *
 * 所以上行只保留：规则 id、级别、包内相对路径、脱敏后的修复建议。`snippet` **只留本机**。
 *
 * **`level` 必须有**（C-03 §1 的 `Issue` 结构：`blocking[]` 恒 `EXTREME`、`warnings[]`
 * 只能是 `MEDIUM` / `LOW`）。缺了它 Hub 会把整条提交按 `INVALID_REQUEST`（`级别必填`）拒绝——
 * 也就是说本机只要有一条非 `EXTREME` 命中，贡献就发不出去。取 `original_level || level`
 * 与上行前的过滤判据一致（`ipc/contribution.ts` 用同一表达式排除 original 为 `EXTREME` 的项），
 * 因此进入 `warnings` 的条目必然是 `MEDIUM` / `LOW`；同时如实保留「被上下文降级前的级别」，
 * 不让降级在展示与审计里消失。
 */
export function toUploadableIssue(v: Violation): { rule_id: string; level: Level; path?: string; message: string } {
  // `field` 形如 "<relpath>" / "<relpath>:<line>" / "frontmatter:<key>"。
  // 取相对路径部分；`frontmatter:` 前缀不是文件路径，按规则级问题处理（省略 path）。
  const field = String(v.field || '');
  const isFrontmatter = field.startsWith('frontmatter:');
  const relpath = isFrontmatter ? undefined : field.split(':')[0] || undefined;
  return {
    rule_id: v.rule,
    level: v.original_level || v.level,
    ...(relpath ? { path: relpath } : {}),
    // 只用修复建议，不用 snippet。建议是写给人读的规则说明，不含命中内容。
    message: String(v.suggested_fix || v.rule).slice(0, 500),
  };
}
