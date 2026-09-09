/**
 * Host-owned two-confirmation orchestration for Agent 创建师 governed mode.
 *
 * The model may propose a container, but it never owns a lifecycle transition.
 * This module is the only place that moves a draft through sandbox → verify →
 * approval → publish → materialize → activate. `bus.ts` only calls these
 * bounded entry points and renders the returned message.
 */

import type { ExtractedFields } from '../agents';
import { buildCreatorCapabilityCatalog, type CreatorCapabilityDescriptor } from '../creator/catalog';
import { createCreatorLifecycleService, type CreatorLifecycleService } from '../creator/lifecycle-service';
import type { materializeCreatorPreset } from '../creator/materializer';
import { creatorManifestDigest, verifyCreatorPreset, type CreatorVerificationReport } from '../creator/verification-service';
import { readCreatorDraft, saveCreatorDraft, type CreatorPresetDraft } from '../creator/store';
import { runAgentSmokeTest, type AgentSmokeRunResult } from './agent-smoke-run';
import { containerToCreatorDraft } from './agent-builder-governed';
import {
  BUILDER_FLOW_TTL_MS,
  isExpired,
  readBuilderFlow,
  type BuilderFlowState,
  type BuilderStateDeps,
  withBuilderFlowLock,
} from './agent-builder-state';

const CONFIRM_RE = /^(?:确认|确认配置|开始验证|继续|confirm|yes|y|ok|okay)$/iu;
const FINAL_CONFIRM_RE = /^(?:确认落地|确认发布|发布|落地|确认并发布|publish|approve|deploy)$/iu;
const CANCEL_RE = /^(?:取消|取消创建|停止|停下|stop|cancel|abort)$/iu;

export interface GovernedFlowDependencies {
  state?: BuilderStateDeps;
  containerToDraft?: typeof containerToCreatorDraft;
  saveDraft?: typeof saveCreatorDraft;
  readDraft?: typeof readCreatorDraft;
  buildCatalog?: (userId: string) => Promise<CreatorCapabilityDescriptor[]>;
  verify?: typeof verifyCreatorPreset;
  smoke?: typeof runAgentSmokeTest;
  materialize?: typeof materializeCreatorPreset;
  lifecycle?: CreatorLifecycleService;
  lifecycleFactory?: typeof createCreatorLifecycleService;
  now?: () => string;
  id?: () => string;
}

export interface GovernedFlowResult {
  handled: boolean;
  stage?: BuilderFlowState['stage'];
  message?: string;
  draft?: CreatorPresetDraft;
  verification?: CreatorVerificationReport;
  smoke?: AgentSmokeRunResult;
}

function nowIso(deps: GovernedFlowDependencies): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function expiration(now: string): string {
  return new Date(Date.parse(now) + BUILDER_FLOW_TTL_MS).toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'governed flow failed';
}

function confirmText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function flowMessage(prefix: string, detail?: string): string {
  return detail ? `${prefix}\n\n${detail}` : prefix;
}

function capabilityPlanSummary(draft: CreatorPresetDraft): string {
  const tools = draft.manifest.permissions.tools;
  const skills = draft.manifest.capabilities
    .filter((item) => item.capabilityId.startsWith("skill."))
    .map((item) => item.capabilityId);
  const capabilityCount = tools.length + skills.length;
  const risk = capabilityCount === 0 ? "低" : "需治理";
  return [
    "能力与风险摘要：",
    `- tools: ${tools.length ? tools.join(", ") : "[]"}`,
    `- skills: ${skills.length ? skills.join(", ") : "[]"}`,
    `- 风险：${risk}`,
    `- 创建路径：${capabilityCount === 0 ? "direct" : "governed"}`,
  ].join("\n");
}

function manifestAgentForSmoke(draft: CreatorPresetDraft): {
  name: string;
  workflow: string;
  skill_list: string[];
  inputs: Array<{ id: string }>;
} {
  const skillIds = draft.manifest.capabilities
    .filter((item) => item.capabilityId.startsWith('skill.'))
    .map((item) => item.capabilityId.slice('skill.'.length));
  return {
    name: draft.manifest.displayName,
    workflow: draft.manifest.prompt.systemSections.join('\n\n'),
    skill_list: skillIds,
    inputs: (draft.manifest.agent?.inputs ?? []).map((input) => ({ id: input.id })),
  };
}

function assertActiveState(state: BuilderFlowState | null, now: string): BuilderFlowState | null {
  if (!state) return null;
  if (isExpired(state, new Date(now)) && state.stage !== 'expired' && state.stage !== 'done') {
    return { ...state, stage: 'expired', updatedAt: now, failureReason: 'flow expired after 24 hours' };
  }
  return state;
}

function lifecycle(deps: GovernedFlowDependencies): CreatorLifecycleService {
  return deps.lifecycle ?? (deps.lifecycleFactory ?? createCreatorLifecycleService)();
}

async function defaultMaterializeCreatorPreset(
  userId: string,
  presetRef: Parameters<typeof materializeCreatorPreset>[1],
): Promise<Awaited<ReturnType<typeof materializeCreatorPreset>>> {
  // Keep materializer (and its Agent feature dependency) off the group-chat
  // module's eager import path. Only the final user-confirmed transition
  // needs it; lazy loading also keeps connector/tool-only sessions isolated
  // from creator persistence mocks.
  const { materializeCreatorPreset: materialize } = await import('../creator/materializer');
  return materialize(userId, presetRef);
}

/** Start a governed flow from one parsed `<agent>` container. */
export async function startGovernedAgentBuilderFlow(input: {
  userId: string;
  cid: string;
  agentId: string;
  fields: ExtractedFields;
  sourceSessionId: string;
  projectId?: string;
}, deps: GovernedFlowDependencies = {}): Promise<GovernedFlowResult> {
  const stateDeps = deps.state ?? {};
  const now = nowIso(deps);
  return withBuilderFlowLock(input.userId, input.cid, stateDeps, async (existing, write) => {
    const current = assertActiveState(existing, now);
    if (current && current.stage !== 'done' && current.stage !== 'expired' && current.stage !== 'failed') {
      return {
        handled: true,
        stage: current.stage,
        message: '当前会话已有一个 Agent 创建治理流程正在进行，请先完成、取消或等待它过期。',
      };
    }
    if (current?.stage === 'expired') {
      await write(current);
    }
    // Capability-bearing drafts are resolved against a host-owned catalog before
    // persistence. This makes an unknown or disabled tool/Skill fail at the
    // conversation boundary instead of waiting for the later verification gate.
    const needsCapabilityResolution =
      Boolean(input.fields.tools?.length) ||
      Boolean(input.fields.skill_list?.length);
    const catalog = needsCapabilityResolution
      ? await (deps.buildCatalog ?? buildCreatorCapabilityCatalog)(input.userId)
      : undefined;
    const draft = await (deps.containerToDraft ?? containerToCreatorDraft)(
      input.userId,
      input.fields,
      { sourceSessionId: input.sourceSessionId, ...(input.projectId ? { projectId: input.projectId } : {}) },
      { save: deps.saveDraft, ...(catalog ? { catalog } : {}) },
    );
    const state: BuilderFlowState = {
      version: 1,
      cid: input.cid,
      agentId: input.agentId,
      mode: 'governed',
      stage: 'awaiting_confirm',
      draftId: draft.draftId,
      expiresAt: expiration(now),
      updatedAt: now,
    };
    await write(state);
    return {
      handled: true,
      stage: state.stage,
      draft,
      message: flowMessage(
        `已生成 Agent「${draft.manifest.displayName}」的 Creator 草稿。`,
        `${capabilityPlanSummary(draft)}\n\n请检查上方配置单，回复“确认”开始 Creator 验证和无工具冒烟测试；回复“取消”放弃。`,
      ),
    };
  });
}

/**
 * Consume a subsequent user message for the flow in this cid. Non-confirmation
 * messages are handled too while a flow is pending, so an unrelated command
 * cannot accidentally bypass the two-confirmation gate.
 */
export async function continueGovernedAgentBuilderFlow(
  userId: string,
  cid: string,
  userText: string,
  signal?: AbortSignal,
  deps: GovernedFlowDependencies = {},
): Promise<GovernedFlowResult> {
  const stateDeps = deps.state ?? {};
  const now = nowIso(deps);
  const state = await readBuilderFlow(userId, cid, stateDeps);
  const current = state?.cid === cid ? assertActiveState(state, now) : null;
  if (!current) return { handled: false };
  if (current.stage === 'done') return { handled: false };
  if (current.stage === 'expired') {
    if (!state || state.stage !== 'expired') {
      await withBuilderFlowLock(userId, cid, stateDeps, async (_old, write) => { await write(current); });
    }
    return {
      handled: true,
      stage: 'expired',
      message: '这个 Agent 创建治理流程已于 24 小时后过期。请重新提交配置单开始新的流程。',
    };
  }
  if (current.stage === 'failed') {
    return {
      handled: false,
      stage: current.stage,
      message: current.failureReason,
    };
  }

  const text = confirmText(userText);
  if (CANCEL_RE.test(text)) {
    await withBuilderFlowLock(userId, cid, stateDeps, async (latest, write) => {
      if (latest && latest.stage !== 'done') {
        await write({ ...latest, stage: 'failed', updatedAt: now, failureReason: 'cancelled by user' });
      }
    });
    return { handled: true, stage: 'failed', message: '已取消 Agent 创建治理流程；草稿保留，未发布、未材料化。' };
  }

  if (current.stage === 'awaiting_confirm') {
    if (!CONFIRM_RE.test(text)) {
      return {
        handled: true,
        stage: current.stage,
        message: '请回复“确认”开始验证和冒烟测试，或回复“取消”放弃本次创建。',
      };
    }
    if (signal?.aborted) return { handled: true, stage: current.stage, message: '治理流程已停止；草稿保留，未材料化。' };

    const reserved = await withBuilderFlowLock(userId, cid, stateDeps, async (latest, write) => {
      if (!latest || latest.draftId !== current.draftId || latest.stage !== 'awaiting_confirm') return null;
      const next = { ...latest, stage: 'verifying' as const, updatedAt: now };
      await write(next);
      return next;
    });
    if (!reserved) return { handled: true, stage: 'verifying', message: '治理流程已被另一条消息占用，请稍候。' };

    try {
      const storedDraft = await (deps.readDraft ?? readCreatorDraft)(userId, reserved.draftId);
      if (!storedDraft) throw new Error('creator_draft_not_found');
      const digest = creatorManifestDigest(storedDraft.manifest);
      const service = lifecycle(deps);
      await service.sandboxPreset(userId, reserved.draftId, digest);
      const catalog = await (deps.buildCatalog ?? buildCreatorCapabilityCatalog)(userId);
      const report = await (deps.verify ?? verifyCreatorPreset)(userId, {
        manifest: storedDraft.manifest,
        catalogSnapshot: catalog,
        signal,
      });
      const recorded = await service.recordVerification(userId, reserved.draftId, report);
      if (signal?.aborted || report.status === 'cancelled' || recorded.status !== 'verified') {
        const reason = signal?.aborted ? '治理流程已停止' : 'Creator 验证未通过';
        await markFlowFailed(userId, cid, stateDeps, reserved, reason);
        return {
          handled: true,
          stage: 'failed',
          draft: storedDraft,
          verification: report,
          message: flowMessage(`${reason}；草稿保留，未发布、未材料化。`, '请修改配置后重新提交，或回复“取消”结束流程。'),
        };
      }
      const smoke = await (deps.smoke ?? runAgentSmokeTest)(userId, manifestAgentForSmoke(storedDraft), { abortSignal: signal });
      if (signal?.aborted || smoke.status !== 'passed') {
        const reason = signal?.aborted ? '治理流程已停止' : `无工具冒烟测试未通过：${smoke.message ?? '无可用输出'}`;
        await markFlowFailed(userId, cid, stateDeps, reserved, reason);
        return { handled: true, stage: 'failed', draft: storedDraft, verification: report, smoke, message: flowMessage(`${reason}。草稿保留，未发布、未材料化。`, '请修订后重新提交。') };
      }
      const next: BuilderFlowState = {
        ...reserved,
        stage: 'awaiting_final_confirm',
        verificationRunId: report.runId,
        smokeRunId: smoke.runId,
        updatedAt: nowIso(deps),
        failureReason: undefined,
      };
      await withBuilderFlowLock(userId, cid, stateDeps, async (latest, write) => {
        if (!latest || latest.draftId !== reserved.draftId || latest.stage !== 'verifying') throw new Error('builder_flow_state_changed');
        await write(next);
      });
      return {
        handled: true,
        stage: next.stage,
        draft: storedDraft,
        verification: report,
        smoke,
        message: flowMessage(
          'Creator 验证和无工具冒烟测试均已通过。',
          `${capabilityPlanSummary(storedDraft)}\n\n回复“确认落地”后才会发布、材料化并激活；回复“取消”则保留草稿且不落地。`,
        ),
      };
    } catch (error) {
      const reason = signal?.aborted ? '治理流程已停止' : errorText(error);
      await markFlowFailed(userId, cid, stateDeps, reserved, reason);
      return { handled: true, stage: 'failed', message: flowMessage(`治理流程失败：${reason}`, '草稿保留，未发布、未材料化。') };
    }
  }

  if (current.stage === 'awaiting_final_confirm') {
    if (!FINAL_CONFIRM_RE.test(text)) {
      return { handled: true, stage: current.stage, message: '验证已通过。请回复“确认落地”发布并激活 Agent，或回复“取消”放弃落地。' };
    }
    if (signal?.aborted) return { handled: true, stage: current.stage, message: '治理流程已停止；尚未材料化。' };
    const reserved = await withBuilderFlowLock(userId, cid, stateDeps, async (latest, write) => {
      if (!latest || latest.draftId !== current.draftId || latest.stage !== 'awaiting_final_confirm') return null;
      const next = { ...latest, stage: 'materializing' as const, updatedAt: now };
      await write(next);
      return next;
    });
    if (!reserved) return { handled: true, stage: 'materializing', message: '治理流程已被另一条消息占用，请稍候。' };
    try {
      const draft = await (deps.readDraft ?? readCreatorDraft)(userId, reserved.draftId);
      if (!draft || !reserved.verificationRunId) throw new Error('creator_verification_required');
      const service = lifecycle(deps);
      const digest = creatorManifestDigest(draft.manifest);
      await service.approvePreset(userId, reserved.draftId, {
        draftId: reserved.draftId,
        manifestDigest: digest,
        verificationRunId: reserved.verificationRunId,
        actorId: 'user',
        confirmedAt: now,
        approved: true,
        approvedCapabilities: draft.manifest.capabilities.map((item) => item.capabilityId),
        approvedSideEffects: draft.manifest.permissions.sideEffects,
      });
      const published = await service.publishPreset(userId, reserved.draftId, {
        version: draft.manifest.version,
        manifestDigest: digest,
        verificationRunId: reserved.verificationRunId,
      });
      if (signal?.aborted) throw new Error('governed_flow_aborted_before_materialize');
      await (deps.materialize ?? defaultMaterializeCreatorPreset)(userId, {
        presetId: published.presetId,
        version: published.version ?? draft.manifest.version,
        manifestDigest: published.manifestDigest,
      });
      await service.activatePreset(userId, published.presetId, published.version ?? draft.manifest.version);
      const next = { ...reserved, stage: 'done' as const, updatedAt: nowIso(deps), failureReason: undefined };
      await withBuilderFlowLock(userId, cid, stateDeps, async (latest, write) => {
        if (!latest || latest.draftId !== reserved.draftId || latest.stage !== 'materializing') throw new Error('builder_flow_state_changed');
        await write(next);
      });
      return { handled: true, stage: 'done', draft, message: `Agent「${draft.manifest.displayName}」已发布、材料化并激活。` };
    } catch (error) {
      const reason = signal?.aborted ? '治理流程已停止' : errorText(error);
      await markFlowFailed(userId, cid, stateDeps, reserved, reason);
      return { handled: true, stage: 'failed', message: flowMessage(`落地失败：${reason}`, '流程未完成；请检查草稿和生命周期记录后再试。') };
    }
  }

  return { handled: true, stage: current.stage, message: '治理流程正在处理中，请稍候。' };
}

async function markFlowFailed(
  userId: string,
  cid: string,
  stateDeps: BuilderStateDeps,
  expected: BuilderFlowState,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await withBuilderFlowLock(userId, cid, stateDeps, async (latest, write) => {
    if (latest && latest.draftId === expected.draftId && latest.stage !== 'done') {
      await write({ ...latest, stage: 'failed', updatedAt: now, failureReason: reason });
    }
  });
}

export function isGovernedConfirmation(text: string): boolean {
  return CONFIRM_RE.test(confirmText(text)) || FINAL_CONFIRM_RE.test(confirmText(text)) || CANCEL_RE.test(confirmText(text));
}
