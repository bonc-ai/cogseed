/**
 * Agent 贡献主流程 —— 开始、确认预览、提交。业务逻辑在这里，`ipc/contribution.ts` 只做转发。
 *
 * 语义与 Skill 的 `contribution.start / confirm / submit` 对齐（同一套会话、声明、预览确认、
 * 幂等键与"同键同字节重试"），差异只有：
 * - 副本是 `agent-package-v1` 形态（`agent-staging`），准入走 `agent-admission`（逐个随包 Skill）；
 * - 版本号由贡献者提交时给出（`agent.json` 不带 `version`，Hub 发布时写 `_meta.json`）；
 * - 请求体走叶模块 `agent-submission-request`，`content_type: 'agent'`。
 *
 * 所有外部能力（身份门、条款、网络、目录解析、存储）经 `deps` 注入：`ipc/contribution.ts` 是组装点，
 * 测试可替换，不必拉起 Electron、Hub 与扫描器。
 *
 * ## 提交前不变量（任一不满足都不发出）
 * 1. 副本摘要与确认过的预览一致（预览即发出，C-FR-004a / 012a）；
 * 2. 准入 `pass`；三项声明齐全；条款未改版；
 * 3. 打包后四段上限通过（压缩后、文件数、解包、压缩比）；
 * 4. 身份门通过（登录且有社区显示名）；
 * 5. 新版本时：版本号高于已发布版本，且有待审提交时必须显式确认替换。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentAdmission, AgentAdmissionDeps } from './agent-admission';
import { admitAgentContribution } from './agent-admission';
import { checkPackageLimits, DEFAULT_PACKAGE_LIMITS, type PackageLimits } from './agent-package-rules';
import { scanFilesForHints, type SensitiveHint } from './agent-sensitive-hints';
import { buildAgentSubmissionManifest } from './agent-submission-request';
import {
  stageAgent, type AgentStaging, type AgentStagingSources,
} from './agent-staging';
import { missingDeclarations, termsStale, type DeclarationKind } from './declarations';
import type { IdentityGateResult } from './identity';
import { buildPackage } from './package';
import { buildPreview, type PreviewManifest } from './preview';
import {
  createSession, endSession, getSession, type ContributionSession,
} from './session';
import type { ContributionTerms, TermsState } from './terms';
import { isHigherSemVer, parseSemVer } from './version';

/** 外部能力。真实实现由 `ipc/contribution.ts` 注入。 */
export interface AgentContributionDeps {
  gateIdentity: (uid: string) => Promise<IdentityGateResult>;
  /** 按 uid 解析本机 Agent、本机 Skill 与暂存根目录。 */
  resolveSources: (uid: string, agentId: string) => AgentStagingSources;
  /** 清理上次被中断留下的暂存副本。 */
  cleanupOrphans: (uid: string) => void;
  fetchTerms: () => Promise<TermsState>;
  createSubmission: (userId: string, args: {
    idempotencyKey: string;
    manifest: Record<string, unknown>;
    packageBytes: Buffer;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  contributionTarget: (userId: string, accountId: string, contentId: string) => {
    currentVersion: string; pendingSubmissionId: string | null;
  } | null;
  localAgentUuid: (userId: string, accountId: string, agentId: string) => string;
  /** 本机已装的 Skill 显示名；取不到返回 null（预览退回显示 ID）。 */
  skillDisplayName?: (uid: string, skillId: string) => string | null;
  clientVersion: () => string;
  newIdempotencyKey: () => string;
  /** 包上限，来自契约；缺省用契约默认值，不在业务代码里写死。 */
  limits?: Readonly<PackageLimits>;
  /** 测试注入扫描器替身。 */
  admission?: AgentAdmissionDeps;
}

export type StartResult =
  | { identity: IdentityGateResult; token: null }
  | {
    identity: IdentityGateResult;
    token: string;
    declarations: ContributionSession['declarations'];
    admission: AgentAdmission;
    /** 仅准入通过后才给出：阻断时渲染层拿不到文件清单，没有"先看到再说"的路径。 */
    preview: PreviewManifest | null;
    /** 本机处理项，只给本机预览看，不上传。 */
    handled: AgentStaging['handled'];
    bundledSkills: string[];
    hubRefs: string[];
    /** 客户端内置能力（`builtin:<name>`），不随包提交。 */
    builtinRefs: string[];
    /** 预览里可能含本机路径或疑似凭据的位置，只提示不改；有提示时确认预览须明确确认已看过。 */
    hints: SensitiveHint[];
    /** Hub 依赖的显示名（仅本机已装的有），键为 12 位 ID。 */
    hubRefNames: Record<string, string>;
  };

/**
 * 开始一次 Agent 贡献。身份门前置：未登录或无显示名时不建副本。
 * 阻断（含阻断项）时仍返回会话 token，渲染层据 `admission.blocking` 展示原因并可取消。
 */
export async function startAgentContribution(uid: string, agentId: string, deps: AgentContributionDeps): Promise<StartResult> {
  const identity = await deps.gateIdentity(uid);
  if (identity.outcome !== 'ready') return { identity, token: null };

  deps.cleanupOrphans(uid);
  const staging = await stageAgent(agentId, deps.resolveSources(uid, agentId));
  const session = createSession(uid, { dir: staging.dir, sourceSkillId: agentId, token: staging.token }, staging);
  const admission = await admitAgentContribution(staging, { ...deps.admission, limits: deps.limits ?? deps.admission?.limits });
  session.agent!.admission = admission;
  const preview = admission.outcome === 'pass' ? buildPreview(staging) : null;
  // Look only at what would actually be sent. A read failure just means no hint for that file.
  const hints = preview
    ? scanFilesForHints(preview.files, (rel) => fs.readFileSync(path.join(staging.dir, ...rel.split('/'))))
    : [];
  session.agent!.hints = hints;
  return {
    identity,
    token: session.token,
    declarations: session.declarations,
    admission,
    preview,
    handled: staging.handled,
    bundledSkills: staging.bundledSkills,
    hubRefs: staging.hubRefs,
    builtinRefs: staging.builtinRefs,
    hints,
    hubRefNames: Object.fromEntries(staging.hubRefs.flatMap((id) => {
      const name = deps.skillDisplayName?.(uid, id);
      return name ? [[id, name]] : [];
    })),
  };
}

export type ConfirmResult =
  | { confirmed: true }
  | { confirmed: false; reason: 'declarations_missing'; missing: DeclarationKind[] }
  | { confirmed: false; reason: 'terms_stale'; terms_state: TermsState }
  | { confirmed: false; reason: 'digest_mismatch'; preview: PreviewManifest }
  | { confirmed: false; reason: 'package_limits'; violations: ReturnType<typeof checkPackageLimits> }
  /** 预览里有可能含本机信息的位置，用户还没明确确认已看过。 */
  | { confirmed: false; reason: 'hints_unacknowledged'; count: number };

function requireAgentSession(uid: string, token: string): ContributionSession {
  const session = getSession(uid, token);
  if (!session?.agent) throw new Error('session not found');
  return session;
}

/**
 * 贡献者确认预览：确认的是**一份具体的 digest**，不是"我看过了"这个动作。
 * 确认时就打包并绑定字节，提交只发这份字节（同键同字节重试的前提）。
 */
export async function confirmAgentPreview(
  uid: string, token: string, digest: string, deps: AgentContributionDeps,
  opts: { acknowledgeHints?: boolean } = {},
): Promise<ConfirmResult> {
  const session = requireAgentSession(uid, token);
  if (session.agent!.admission?.outcome !== 'pass') throw new Error('admission not passed');

  const missing = missingDeclarations(session.declarations);
  if (missing.length) return { confirmed: false, reason: 'declarations_missing', missing };

  // Content that may carry local paths or credential-like text is sent only after the user has
  // said they looked at those spots. Nothing is rewritten for them: what they confirm is what goes.
  const hintCount = session.agent!.hints.length;
  if (hintCount > 0 && opts.acknowledgeHints !== true) return { confirmed: false, reason: 'hints_unacknowledged', count: hintCount };

  const termsState = await deps.fetchTerms();
  const currentTerms: ContributionTerms | null = termsState.status === 'open' ? termsState.terms : null;
  if (termsStale(session.declarations.terms, currentTerms)) {
    session.declarations.terms = null;
    return { confirmed: false, reason: 'terms_stale', terms_state: termsState };
  }

  const current = buildPreview(session.staging);
  if (!digest || digest !== current.digest) return { confirmed: false, reason: 'digest_mismatch', preview: current };

  const limits = deps.limits ?? DEFAULT_PACKAGE_LIMITS;
  // 不让 buildPackage 自行按压缩后上限抛错：统一交给 checkPackageLimits 判定，才能给出真实数值
  const pkg = buildPackage(session.staging, current, { maxCompressedBytes: Number.MAX_SAFE_INTEGER });
  const violations = checkPackageLimits(pkg.stats, limits);
  if (violations.length) return { confirmed: false, reason: 'package_limits', violations };

  session.confirmedPreview = current;
  session.confirmedPackage = pkg;
  session.idempotencyKey = deps.newIdempotencyKey();
  return { confirmed: true };
}

export interface SubmitPayload {
  /** 本次提交的 SemVer，由贡献者给出（`agent.json` 不带版本）。 */
  version: string;
  targetContentId: string | null;
  replaceConfirmed?: boolean;
}

export type SubmitResult =
  | { ok: true; delivery: 'arrived'; result: unknown }
  | { ok: false; reason: string; [extra: string]: unknown }
  /** 网络/接口错误，原样交给 IPC 层转成可渲染错误；保留幂等键与字节，可同键重试。 */
  | { ok: false; apiError: unknown };

export async function submitAgentContribution(
  uid: string, token: string, payload: SubmitPayload, deps: AgentContributionDeps,
): Promise<SubmitResult> {
  const session = requireAgentSession(uid, token);
  if (!session.confirmedPreview || !session.confirmedPackage || !session.idempotencyKey) {
    throw new Error('preview_not_confirmed');
  }
  const now = buildPreview(session.staging);
  if (now.digest !== session.confirmedPreview.digest) return { ok: false, reason: 'snapshot_drift' };

  const identity = await deps.gateIdentity(uid);
  if (identity.outcome !== 'ready' || !identity.accountId) return { ok: false, reason: identity.reason ?? 'identity_unavailable' };

  if (!parseSemVer(payload.version)) return { ok: false, reason: 'invalid_semver' };
  if (payload.targetContentId) {
    const target = deps.contributionTarget(uid, identity.accountId, payload.targetContentId);
    if (!target?.currentVersion) return { ok: false, reason: 'target_version_unavailable' };
    if (!isHigherSemVer(payload.version, target.currentVersion)) {
      return { ok: false, reason: 'version_not_higher', current_version: target.currentVersion };
    }
    if (target.pendingSubmissionId && payload.replaceConfirmed !== true) {
      return { ok: false, reason: 'replacement_confirmation_required' };
    }
  }

  const agentJson = JSON.parse(fs.readFileSync(path.join(session.staging.dir, 'agent.json'), 'utf8')) as Record<string, unknown>;
  const manifest = buildAgentSubmissionManifest({
    agent: agentJson,
    declarations: session.declarations as unknown as Record<string, unknown>,
    fileList: session.confirmedPackage.fileList,
    // 阻断项已在准入阶段拦下，能走到这里的 blocking 恒为空；与 Skill 的 checker.version 同源
    localCheck: { checker: { side: 'client', version: deps.clientVersion() }, blocking: [], warnings: [] },
    localAgentId: deps.localAgentUuid(uid, identity.accountId, session.staging.sourceSkillId),
    packageDigest: session.confirmedPackage.digest,
    packageSize: session.confirmedPackage.size,
    targetContentId: payload.targetContentId,
    version: payload.version,
  });

  const controller = new AbortController();
  session.uploadController = controller;
  try {
    const result = await deps.createSubmission(uid, {
      idempotencyKey: session.idempotencyKey,
      manifest,
      packageBytes: session.confirmedPackage.bytes,
      signal: controller.signal,
    });
    session.uploadController = null;
    await endSession(uid, token);
    return { ok: true, delivery: 'arrived', result };
  } catch (err) {
    const cancelled = session.uploadController?.signal.aborted === true;
    session.uploadController = null;
    if (cancelled) return { ok: false, reason: 'upload_cancelled', retryable: true, delivery: 'not_confirmed' };
    return { ok: false, apiError: err };
  }
}
