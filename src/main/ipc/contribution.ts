/**
 * IPC handlers for the client-side Skill contribution flow.
 * Renderer reaches these via `window.cogseed.invoke('contribution.*', payload)`.
 *
 *   contribution.preflight   → { identity, components }      开始前的两道门，不建副本
 *   contribution.start       → { token, admission, completion, preview }
 *   contribution.complete    → { completion, admission, preview }   补齐后自动重检
 *   contribution.recheck     → { admission, completion, preview }   副本被外部改动后重检
 *   contribution.readFile    → { content, binary, size }      预览中打开单个文件
 *   contribution.terms       → { state }                      条款全文与生效版本
 *   contribution.declare     → { declarations, missing }       三项声明之一
 *   contribution.confirm     → { confirmed }                  贡献者确认预览
 *   contribution.cancel      → { cancelled }                  销毁副本
 *   contribution.endAll      → { ended }                      登出/切号时终止全部会话
 *
 * ## 三条设计约束
 *
 * 1. **判定结论不跨调用沿用**。`complete` 与 `recheck` 都在写入后立即重跑准入并重建
 *    预览，而不是把"要重跑"这件事交给渲染层记得调用——`C-FR-004c` 的要求是机械的，
 *    不该依赖调用方自律。
 *
 * 2. **`token` 不是授权凭据**。每个 handler 都用 `ctx.userId` 取会话，跨账号取不到。
 *    token 随机只保证不可猜，不等于可以当凭据用。
 *
 * 3. **任何阻断都不返回内容**。`admission` 里只有规则 id、包内相对路径与修复建议
 *    （`toUploadableIssue` 已剥掉 `Violation.snippet` 命中原文）；`preview` 只在
 *    准入通过后才构建——阻断时渲染层拿不到文件清单，也就没有"先看到再说"的路径。
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../logger';
import {
  createStaging, cleanupOrphanedStaging, type ContributionStaging,
} from '../features/contribution/staging';
import { admitContribution, toUploadableIssue } from '../features/contribution/admission';
import {
  inspectCompletion, applyCompletion, applySecurityQuestionnaire, type SecurityQuestionnaire,
} from '../features/contribution/completion';
import { buildPreview, checkLimits } from '../features/contribution/preview';
import { contributionComponents, componentsReady } from '../features/contribution/components';
import { gateIdentity } from '../features/contribution/identity';
import {
  createSession, getSession, endSession, endAllSessions, invalidate,
} from '../features/contribution/session';
import { fetchTerms, type ContributionTerms } from '../features/contribution/terms';
import {
  declareOrigin, acceptTerms, confirmMaintenance, missingDeclarations, isOriginType, parseManualForkedFrom,
  prefillOrigin, termsStale,
} from '../features/contribution/declarations';
import { buildPackage } from '../features/contribution/package';
import {
  createSubmission, getSubmission, withdrawSubmission, listMine,
  createWithdrawalRequest, listWithdrawalRequests, clientAppVersion, ContributionApiError,
} from '../features/contribution/hub-client';
import { contributionTarget, localSkillUuid, mergeMine, readContributionStore, safeStoreView } from '../features/contribution/store';
import { buildSubmissionUploadManifest, submissionMetadata } from '../features/contribution/upload-manifest';
import { isHigherSemVer, parseSemVer } from '../features/contribution/version';

const log = createLogger('ipc/contribution');

function assertToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{12}$/.test(value)) throw new Error('invalid token');
  return value;
}

function assertHubId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

function renderableApiError(err: unknown) {
  if (!(err instanceof ContributionApiError)) throw err;
  return {
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      request_id: err.requestId,
      details: err.details,
      delivery: err.status >= 400 && err.status < 500 ? 'arrived_rejected' : 'not_confirmed',
    },
  };
}

/**
 * 把准入结论整理成**渲染层安全**的形状。
 *
 * 只出 `rule_id` / 包内相对路径 / 修复建议，绝不出 `Violation.snippet`——它的类型
 * 注释逐字是「Quoted excerpt of the offending content」，把它送到渲染层就等于把
 * 要拦的东西渲染出来，而阻断理由本身并不需要它。
 */
function renderableAdmission(a: Awaited<ReturnType<typeof admitContribution>>) {
  return {
    outcome: a.outcome,
    reason: a.reason ?? null,
    ...(a.componentsBlocking ? { componentsBlocking: a.componentsBlocking } : {}),
    issues: a.report.violations.map(toUploadableIssue),
    components: {
      ruleset: a.components.ruleset,
      sentry: a.components.sentry,
      declaration: a.components.declaration,
      ontologyVersion: a.components.ontologyVersion,
    },
    scan: a.scan ? {
      outcome: a.scan.outcome,
      recommendation: a.scan.recommendation ?? null,
      rulesDegraded: a.scan.rulesDegraded === true,
      isolated: a.scan.isolated,
      instructionRisk: a.scan.instructionRisk?.status ?? null,
    } : null,
    declaration: a.declaration ? {
      outcome: a.declaration.outcome,
      reason: a.declaration.reason ?? null,
      findings: a.declaration.findings,
    } : null,
  };
}

/** 准入通过才构建预览：阻断时渲染层不该拿到文件清单。 */
async function evaluate(staging: ContributionStaging) {
  const admission = await admitContribution(staging);
  const completion = inspectCompletion(staging);
  const preview = admission.outcome === 'pass' ? buildPreview(staging) : null;
  return {
    admission,
    payload: {
      admission: renderableAdmission(admission),
      completion,
      preview: preview ? { ...preview, limits: checkLimits(preview) } : null,
    },
  };
}

async function syncMine(userId: string, updatedSince?: string): Promise<Record<string, unknown>> {
  const items: unknown[] = [];
  let page = 1;
  let generatedAt: unknown = null;
  let total = Number.POSITIVE_INFINITY;
  while (items.length < total && page <= 100) {
    const response = await listMine(userId, { page, size: 100, updatedSince });
    const batch = Array.isArray(response.items) ? response.items : [];
    items.push(...batch);
    generatedAt = response.generated_at ?? generatedAt;
    total = typeof response.total === 'number' && response.total >= 0 ? response.total : items.length;
    if (batch.length === 0 || batch.length < 100) break;
    page += 1;
  }
  return { generated_at: generatedAt, total: Number.isFinite(total) ? total : items.length, items };
}

export const invokeHandlers = {
  /**
   * 开始前的两道门：身份与组件。**不建副本**——身份或组件不过关时建副本只会留垃圾。
   *
   * 渲染层据此决定弹登录提示、提示能力未开放、还是提示检查组件异常。
   */
  'contribution.preflight': async (_payload: unknown, ctx: { userId: string }) => {
    const identity = await gateIdentity(ctx.userId);
    const components = contributionComponents();
    const readiness = componentsReady(components);
    return {
      identity,
      components: {
        ruleset: components.ruleset,
        sentry: components.sentry,
        declaration: components.declaration,
        ontologyVersion: components.ontologyVersion,
        ready: readiness.ready,
        blocking: readiness.blocking,
      },
    };
  },

  'contribution.start': async (payload: { skill_id?: unknown; defer_check?: unknown }, ctx: { userId: string }) => {
    const skillId = typeof payload?.skill_id === 'string' ? payload.skill_id.trim() : '';
    if (!skillId) throw new Error('missing skill_id');

    // 身份门前置：未登录/无显示名时不建副本，直接让渲染层走引导。
    const identity = await gateIdentity(ctx.userId);
    if (identity.outcome !== 'ready') return { identity, token: null };

    // 每次开始前顺手清理孤儿副本：进程被杀时留下的副本没有恢复价值。
    cleanupOrphanedStaging(ctx.userId);

    const staging = await createStaging(ctx.userId, skillId);
    const session = createSession(ctx.userId, staging);
    const originPrefill = prefillOrigin(staging);
    if (originPrefill.locked && originPrefill.forked_from) {
      session.declarations.origin = declareOrigin('derived_from_hub', '', originPrefill.forked_from);
    }
    if (payload?.defer_check === true) {
      return {
        identity,
        token: session.token,
        originPrefill,
        declarations: session.declarations,
        admission: { outcome: 'pending', issues: [] },
        completion: inspectCompletion(staging),
        preview: null,
      };
    }
    const { admission, payload: out } = await evaluate(staging);
    session.admission = admission;
    log.info('contribution started', { token: session.token, outcome: admission.outcome });
    return {
      identity,
      token: session.token,
      originPrefill,
      declarations: session.declarations,
      ...out,
    };
  },

  /** 写入补齐值并**立即重检**。重检不交给渲染层调用——`C-FR-004c` 是机械要求。 */
  'contribution.complete': async (
    payload: {
      token?: unknown; name?: unknown; description?: unknown; version?: unknown;
      security_manifest?: unknown; security_declaration?: unknown;
    },
    ctx: { userId: string },
  ) => {
    const token = assertToken(payload?.token);
    const session = getSession(ctx.userId, token);
    if (!session) throw new Error('session not found');

    applyCompletion(session.staging, {
      ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
      ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
      ...(typeof payload.version === 'string' ? { version: payload.version } : {}),
      ...(typeof payload.security_manifest === 'string' ? { security_manifest: payload.security_manifest } : {}),
    });
    if (payload.security_declaration !== undefined) {
      if (!payload.security_declaration || typeof payload.security_declaration !== 'object'
        || Array.isArray(payload.security_declaration)) throw new Error('invalid security_declaration');
      const identity = await gateIdentity(ctx.userId);
      if (identity.outcome !== 'ready' || !identity.displayName) throw new Error(identity.reason || 'identity unavailable');
      applySecurityQuestionnaire(
        session.staging,
        payload.security_declaration as Partial<SecurityQuestionnaire>,
        identity.displayName,
      );
    }
    invalidate(session);

    const { admission, payload: out } = await evaluate(session.staging);
    session.admission = admission;
    return out;
  },

  /** 副本被外部改动（贡献者在本机改了原 Skill 后重新发起）时的显式重检。 */
  'contribution.recheck': async (payload: { token?: unknown }, ctx: { userId: string }) => {
    const token = assertToken(payload?.token);
    const session = getSession(ctx.userId, token);
    if (!session) throw new Error('session not found');
    invalidate(session);
    const { admission, payload: out } = await evaluate(session.staging);
    session.admission = admission;
    return out;
  },

  /**
   * 读取预览中的单个文件（`C-FR-004`「每个文件可打开的只读内容」）。
   *
   * 三条约束：
   * 1. **路径必须来自本次预览清单**——不接受任意相对路径。否则一个构造过的路径
   *    就能把副本目录之外的文件读出来，而副本目录在用户数据区内。
   * 2. **只读**，没有对应的写接口。预览内不可编辑是 `C-FR-004` 的要求：要改内容
   *    得退出预览、在本机改完重新发起。
   * 3. 二进制文件**不返回内容**，只回大小。`C-FR-004` 的边界情况要求二进制以
   *    「二进制文件，{size}」提示，而把字节塞进 IPC 既无用又放大内存。
   */
  'contribution.readFile': async (
    payload: { token?: unknown; path?: unknown },
    ctx: { userId: string },
  ) => {
    const token = assertToken(payload?.token);
    const rel = typeof payload?.path === 'string' ? payload.path : '';
    const session = getSession(ctx.userId, token);
    if (!session) throw new Error('session not found');

    // 只认当前预览清单里的路径。用 includes 而非路径拼接校验：清单是唯一真相，
    // 自己再写一遍"什么算合法相对路径"就是第二套规则，而两套规则里弱的那套说了算。
    const preview = buildPreview(session.staging);
    const entry = preview.files.find((f) => f.path === rel);
    if (!entry) throw new Error('path not in preview');

    const full = path.join(session.staging.dir, ...rel.split('/'));
    const buf = await fsp.readFile(full);
    // NUL 字节是判二进制最省事且够用的判据；文本文件里不会出现。
    const binary = buf.includes(0);
    return binary
      ? { binary: true, size: entry.size, content: null }
      : { binary: false, size: entry.size, content: buf.toString('utf8') };
  },

  /**
   * 取当前生效条款（`C-FR-007`）。
   *
   * 三态原样透出：`open` / `closed` / `unavailable`。**不把后两者合并**——
   * 「暂未开放」是产品状态，「无法获取」是故障且可重试，合并会让一次服务端
   * 故障看起来像产品状态。
   */
  'contribution.terms': async () => ({ state: await fetchTerms() }),

  /**
   * 记录三项声明之一（`C-FR-005`～`C-FR-008`）。
   *
   * 条款版本**不从参数取**：只收 Hub 当前返回的条款对象，由主进程重新拉取。
   * 让渲染层传 version 进来，就等于让它能声称接受了一个别的版本
   * （`C-FR-004b`：条款版本不可由 Skill 包或手工输入替代）。
   */
  'contribution.declare': async (
    payload: { token?: unknown; kind?: unknown; origin_type?: unknown; note?: unknown; forked_from?: unknown },
    ctx: { userId: string },
  ) => {
    const token = assertToken(payload?.token);
    const session = getSession(ctx.userId, token);
    if (!session) throw new Error('session not found');

    const kind = payload?.kind;
    if (kind === 'origin') {
      if (!isOriginType(payload?.origin_type)) throw new Error('invalid origin_type');
      const locked = prefillOrigin(session.staging);
      if (locked.locked && payload.origin_type !== 'derived_from_hub') throw new Error('forked_from_locked');
      let forkedFrom = locked.locked ? locked.forked_from : null;
      if (!locked.locked && payload.origin_type === 'derived_from_hub') {
        forkedFrom = parseManualForkedFrom(payload.forked_from);
      }
      session.declarations.origin = declareOrigin(
        payload.origin_type,
        typeof payload?.note === 'string' ? payload.note : '',
        forkedFrom,
      );
    } else if (kind === 'terms') {
      const state = await fetchTerms();
      if (state.status !== 'open') {
        return { declarations: session.declarations, missing: missingDeclarations(session.declarations), terms_state: state };
      }
      session.declarations.terms = acceptTerms(state.terms);
    } else if (kind === 'maintenance') {
      session.declarations.maintenance = confirmMaintenance();
    } else {
      throw new Error('invalid kind');
    }

    return {
      declarations: session.declarations,
      missing: missingDeclarations(session.declarations),
    };
  },

  /**
   * 贡献者确认预览。
   *
   * 确认的是**一份具体的 digest**，不是"我看过了"这个动作。提交时若副本的 digest
   * 与此处记下的不一致，必须回到重检（`C-FR-012a`）。
   */
  'contribution.confirm': async (payload: { token?: unknown; digest?: unknown }, ctx: { userId: string }) => {
    const token = assertToken(payload?.token);
    const digest = typeof payload?.digest === 'string' ? payload.digest : '';
    const session = getSession(ctx.userId, token);
    if (!session) throw new Error('session not found');
    if (!session.admission || session.admission.outcome !== 'pass') {
      throw new Error('admission not passed');
    }
    // 三项声明缺一不得确认（`C-FR-005`），且要**指出缺项**而不只是拒绝。
    const missing = missingDeclarations(session.declarations);
    if (missing.length) return { confirmed: false, reason: 'declarations_missing', missing };
    // 条款可能在贡献者停留期间改版：让他知道要重新确认的是条款而不是内容。
    const termsState = await fetchTerms();
    const currentTerms: ContributionTerms | null = termsState.status === 'open' ? termsState.terms : null;
    if (termsStale(session.declarations.terms, currentTerms)) {
      session.declarations.terms = null;
      return { confirmed: false, reason: 'terms_stale', terms_state: termsState };
    }
    const current = buildPreview(session.staging);
    if (!digest || digest !== current.digest) {
      // 不是错误而是状态：渲染层据此重新展示预览并要求再次确认。
      return { confirmed: false, reason: 'digest_mismatch', preview: current };
    }
    session.confirmedPreview = current;
    session.confirmedPackage = buildPackage(session.staging, current);
    session.idempotencyKey = randomUUID();
    return { confirmed: true };
  },

  /** Submit the exact bytes captured by contribution.confirm. */
  'contribution.submit': async (
    payload: { token?: unknown; target_content_id?: unknown; replace_confirmed?: unknown },
    ctx: { userId: string },
  ) => {
    const token = assertToken(payload?.token);
    const session = getSession(ctx.userId, token);
    if (!session?.confirmedPreview || !session.confirmedPackage || !session.idempotencyKey) {
      throw new Error('preview_not_confirmed');
    }
    const now = buildPreview(session.staging);
    if (now.digest !== session.confirmedPreview.digest) return { ok: false, reason: 'snapshot_drift' };
    const identity = await gateIdentity(ctx.userId);
    if (identity.outcome !== 'ready' || !identity.accountId) return { ok: false, reason: identity.reason };
    const completion = inspectCompletion(session.staging);
    if (completion.missing.length || completion.conflicts.length) return { ok: false, reason: 'metadata_incomplete', completion };
    // 只发契约白名单三键：`completion.present` 是**超集**（带 `security_manifest`），
    // 整包发出去会被 Hub 按 UNEXPECTED_FIELD（`metadata.security_manifest`）拒绝。
    const metadata = submissionMetadata(completion.present);
    const target = payload.target_content_id == null || payload.target_content_id === ''
      ? null : assertHubId(payload.target_content_id, 'target_content_id');
    if (!parseSemVer(metadata.version)) return { ok: false, reason: 'invalid_semver' };
    if (target) {
      const targetState = contributionTarget(ctx.userId, identity.accountId, target);
      if (!targetState?.currentVersion) return { ok: false, reason: 'target_version_unavailable' };
      if (!isHigherSemVer(metadata.version, targetState.currentVersion)) {
        return { ok: false, reason: 'version_not_higher', current_version: targetState.currentVersion };
      }
      if (targetState.pendingSubmissionId && payload.replace_confirmed !== true) {
        return { ok: false, reason: 'replacement_confirmation_required' };
      }
    }
    const report = session.admission?.report;
    const warnings = (report?.violations || [])
      .filter((v) => (v.original_level || v.level) !== 'EXTREME')
      .map(toUploadableIssue);
    try {
      const uploadController = new AbortController();
      session.uploadController = uploadController;
      const result = await createSubmission(ctx.userId, {
        idempotencyKey: session.idempotencyKey,
        manifest: buildSubmissionUploadManifest({
          declarations: session.declarations as unknown as Record<string, unknown>,
          fileList: session.confirmedPackage.fileList,
          localCheck: {
            // 与 `X-CogSeed-Client-Version` 同源（C03 §1：客户端侧 checker.version = app 版本）
            checker: { side: 'client', version: clientAppVersion() },
            blocking: [],
            warnings,
          },
          localSkillId: localSkillUuid(ctx.userId, identity.accountId, session.staging.sourceSkillId),
          packageDigest: session.confirmedPackage.digest,
          packageSize: session.confirmedPackage.size,
          present: completion.present,
          targetContentId: target,
        }),
        packageBytes: session.confirmedPackage.bytes,
        signal: uploadController.signal,
      });
      session.uploadController = null;
      await endSession(ctx.userId, token);
      return { ok: true, delivery: 'arrived', result };
    } catch (err) {
      const cancelled = session.uploadController?.signal.aborted === true;
      session.uploadController = null;
      if (cancelled) return { ok: false, reason: 'upload_cancelled', retryable: true, delivery: 'not_confirmed' };
      return renderableApiError(err);
    }
  },

  /** 中止当前上传尝试但保留确认副本和幂等键，以便同键同字节重试。 */
  'contribution.abortUpload': async (payload: { token?: unknown }, ctx: { userId: string }) => {
    const session = getSession(ctx.userId, assertToken(payload?.token));
    if (!session) return { cancelled: false };
    session.uploadController?.abort();
    return { cancelled: true };
  },

  'contribution.submission': async (payload: { submission_id?: unknown }, ctx: { userId: string }) => {
    try { return { ok: true, result: await getSubmission(ctx.userId, assertHubId(payload?.submission_id, 'submission_id')) }; }
    catch (err) { return renderableApiError(err); }
  },

  'contribution.withdrawPending': async (payload: { submission_id?: unknown }, ctx: { userId: string }) => {
    try { return { ok: true, result: await withdrawSubmission(ctx.userId, assertHubId(payload?.submission_id, 'submission_id')) }; }
    catch (err) { return renderableApiError(err); }
  },

  'contribution.mine': async (payload: { refresh?: unknown }, ctx: { userId: string }) => {
    const identity = await gateIdentity(ctx.userId);
    if (identity.outcome !== 'ready' || !identity.accountId) return { ok: false, reason: identity.reason };
    const cached = readContributionStore(ctx.userId, identity.accountId);
    try {
      const result = await syncMine(ctx.userId, payload?.refresh === true ? undefined : cached.generated_at || undefined);
      return { ok: true, stale: false, cache: safeStoreView(mergeMine(ctx.userId, identity.accountId, result)) };
    } catch (err) {
      const safe = renderableApiError(err);
      return { ...safe, stale: true, cache: safeStoreView(cached) };
    }
  },

  'contribution.requestWithdrawal': async (
    payload: { content_id?: unknown; reason?: unknown }, ctx: { userId: string },
  ) => {
    const contentId = assertHubId(payload?.content_id, 'content_id');
    const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
    if (!reason || reason.length > 2000) throw new Error('invalid reason');
    try { return { ok: true, result: await createWithdrawalRequest(ctx.userId, contentId, reason) }; }
    catch (err) { return renderableApiError(err); }
  },

  'contribution.withdrawalHistory': async (payload: { content_id?: unknown }, ctx: { userId: string }) => {
    try { return { ok: true, result: await listWithdrawalRequests(ctx.userId, assertHubId(payload?.content_id, 'content_id')) }; }
    catch (err) { return renderableApiError(err); }
  },

  'contribution.cancel': async (payload: { token?: unknown }, ctx: { userId: string }) => {
    const token = assertToken(payload?.token);
    await endSession(ctx.userId, token);
    return { cancelled: true };
  },

  /** 登出 / 切号时由账号层调用：进行中的检查与预览立即终止（`C-FR-003` 边界情况）。 */
  'contribution.endAll': async (_payload: unknown, ctx: { userId: string }) => ({
    ended: await endAllSessions(ctx.userId),
  }),
};
