/**
 * 社区安全声明门 —— 贡献侧语义。
 *
 * ## 复用了什么
 *
 * `skill_reverify.checkDeclaration(dir, id)` 已经把整条链路做完了：`references/security-manifest.yaml`
 * 存在性 → `validateSkillDeclaration(dir, 'PREVALIDATION')` → 退出码与报告映射 →
 * findings 过滤掉 INFO 并整理成 `{ ruleId, severity, message }`。**本模块不重做任何一段**，
 * 只把它的 6 种状态翻译成贡献侧的放行/阻断。
 *
 * ## 为什么贡献侧的语义与安装侧不同
 *
 * 安装侧 `checkDeclaration` 的结果只进 receipt 供展示——`absent` 不拦安装，因为迭代一
 * 的官方内容本来就不强制带声明。贡献侧相反：Hub `FR-010` 明写「社区安全声明**随包必需**，
 * Hub 对可验证缺失、不完整和冲突独立拒绝」。客户端在本地先拦，是把一次注定失败的
 * 上传提前到不花网络的地方。
 *
 * ## 引擎版本 ≠ 本体版本
 *
 * `skill-declaration-core` 的引擎版本是 `1.3.0`，它加载的本体是 `cogseed.security.skill@1.1.1`。
 * 两个版本号不是一回事，报告与上行都不得以其一冒充另一（跨端已确认口径）。
 */
import { createLogger } from '../../logger';
import { checkDeclaration } from '../skill_reverify';
import type { ContributionStaging } from './staging';

const log = createLogger('contribution/declaration');

/** 声明门结论。`pass` / `pass_with_warnings` 之外一律阻断上传。 */
export type DeclarationGateOutcome = 'pass' | 'pass_with_warnings' | 'blocked';

export type DeclarationBlockReason =
  | 'declaration_absent'      // 无 references/security-manifest.yaml；Hub FR-010 要求随包必需
  | 'declaration_needs_input' // 必填项缺失
  | 'declaration_mismatch'    // 声明与实际内容树冲突
  | 'declaration_unavailable'; // 引擎未能完成判定

export interface DeclarationGateResult {
  outcome: DeclarationGateOutcome;
  reason?: DeclarationBlockReason;
  /** 引擎原始结果串，诊断用。 */
  engineResult?: string;
  /** 已脱敏的 findings（`skill_reverify` 已过滤 INFO 并只保留 ruleId/severity/message）。 */
  findings: Array<{ ruleId: string; severity: string; message: string }>;
}
/**
 * 对提交副本执行声明门。
 *
 * 永不抛错：任何异常落 `declaration_unavailable`，与「检查未完成即停止提交」一致。
 */
export async function gateDeclaration(staging: ContributionStaging): Promise<DeclarationGateResult> {
  let check: Awaited<ReturnType<typeof checkDeclaration>>;
  try {
    check = await checkDeclaration(staging.dir, staging.sourceSkillId);
  } catch (err) {
    log.warn('declaration gate threw', { token: staging.token, error: (err as Error).message });
    return { outcome: 'blocked', reason: 'declaration_unavailable', findings: [] };
  }

  // `checkDeclaration` 在自身出错时返回 undefined；按未完成处理，不按通过。
  if (!check) {
    return { outcome: 'blocked', reason: 'declaration_unavailable', findings: [] };
  }

  const findings = check.findings ?? [];
  const common = {
    ...(check.engineResult ? { engineResult: check.engineResult } : {}),
    findings,
  };

  switch (check.status) {
    case 'pass':
      return { outcome: 'pass', ...common };
    case 'pass_with_warnings':
      // 警告不拦，但必须随预览展示——贡献者有权在发出前看到它们。
      return { outcome: 'pass_with_warnings', ...common };
    case 'absent':
      return { outcome: 'blocked', reason: 'declaration_absent', ...common };
    case 'needs_input':
      return { outcome: 'blocked', reason: 'declaration_needs_input', ...common };
    case 'mismatch':
      return { outcome: 'blocked', reason: 'declaration_mismatch', ...common };
    case 'unavailable':
      return { outcome: 'blocked', reason: 'declaration_unavailable', ...common };
    default: {
      // 新增状态必须 fail closed，不得靠"没匹配上"默认放行。
      const _exhaustive: never = check.status;
      void _exhaustive;
      return { outcome: 'blocked', reason: 'declaration_unavailable', ...common };
    }
  }
}
