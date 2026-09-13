import {
  createCreatorLifecycleService,
  type CreatorLifecycleService,
} from "../features/creator/lifecycle-service";
import { inspectCreatorRuntime } from "../features/creator/inspect-service";
import { proposeCreatorPreset } from "../features/creator/proposal-service";
import {
  listCreatorPresetSummaries,
  readCreatorDraft,
} from "../features/creator/store";
import { readCreatorFeatureFlags } from "../features/creator/flags";
import { runCreatorSimulation } from "../features/creator/simulation-service";
import { verifyCreatorPreset } from "../features/creator/verification-service";
import type { CreatorFeatureFlags } from "../features/creator/types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

type IpcContext = { userId: string };
type CreatorAgentInput = {
  goal: string;
  sourceSessionId: string;
  projectId?: string;
  cid?: string;
};
type CreatorAgentRunner = (
  userId: string,
  input: CreatorAgentInput,
) => Promise<unknown>;
type InvokeHandler = (payload: any, ctx: IpcContext) => Promise<any>;
type CreatorLifecycleIpc = Pick<
  CreatorLifecycleService,
  | "approvePreset"
  | "publishPreset"
  | "activatePreset"
  | "disablePreset"
  | "rollbackPreset"
> &
  Partial<
    Pick<CreatorLifecycleService, "sandboxPreset" | "recordVerification">
  >;

export interface CreatorIpcDependencies {
  readFlags: (userId: string) => CreatorFeatureFlags;
  inspect: typeof inspectCreatorRuntime;
  propose: typeof proposeCreatorPreset;
  readDraft: typeof readCreatorDraft;
  simulate: typeof runCreatorSimulation;
  verify: typeof verifyCreatorPreset;
  lifecycle: CreatorLifecycleIpc;
  listPresets: (userId: string) => Promise<object[]>;
  runAgent: CreatorAgentRunner;
}

function object(value: unknown, code: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(code);
  return value as Record<string, any>;
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new Error(code);
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new Error("creator_manifest_digest_invalid");
  return value;
}

function text(value: unknown, code: string, max: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) throw new Error(code);
  return normalized;
}

function optionalText(
  value: unknown,
  code: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, code, max);
}

function identifiers(value: unknown, code: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(code);
  return value.map((entry) => identifier(entry, code));
}

function confirmation(payload: Record<string, any>) {
  const actorId = identifier(payload.actorId, "creator_actor_id_invalid");
  const confirmedAt = text(
    payload.confirmedAt,
    "creator_confirmation_invalid",
    64,
  );
  if (!Number.isFinite(Date.parse(confirmedAt)))
    throw new Error("creator_confirmation_invalid");
  return { actorId, confirmedAt };
}

function requireCreatorEnabled(flags: CreatorFeatureFlags): void {
  if (!flags.creatorMode) throw new Error("creator_mode_disabled");
}

function requirePublishEnabled(flags: CreatorFeatureFlags): void {
  requireCreatorEnabled(flags);
  if (!flags.publish) throw new Error("creator_publish_disabled");
}

const PRESET_SUMMARY_KEYS = new Set([
  "presetId",
  "version",
  "activeVersion",
  "previousActiveVersion",
  "displayName",
  "description",
  "presetType",
  "updatedAt",
  "status",
  "manifestDigest",
  "uid",
]);

function safePresetSummary(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => PRESET_SUMMARY_KEYS.has(key)),
  );
}

const SAFE_AGENT_RESULT_KEYS = new Set([
  "schemaVersion",
  "status",
  "message",
  "draft",
  "inspection",
  "checks",
  "clarification",
  "capabilityPlan",
]);
const FORBIDDEN_AGENT_RESULT_KEY =
  /(?:endpoint|token|raw.?headers?|socket.?handle|session.?handle|task.?handle|cwd|command|network.?settings?|authorization|secret|password|api.?key|access.?token|path)/i;
const UNSAFE_AGENT_RESULT_VALUE =
  /(?:https?|wss?|ftp):\/\/|(?:^|[\s("'=])(?:\/(?:[A-Za-z0-9._-]+)|[A-Za-z]:[\\/]|\\\\)|\b(?:bearer|api[_-]?key|access[_-]?token|secret|password)\b\s*[:=]/i;

function safeAgentResult(value: unknown, depth = 0): unknown {
  if (
    depth > 8 ||
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (typeof value === "string")
    return UNSAFE_AGENT_RESULT_VALUE.test(value)
      ? "[REDACTED]"
      : value.slice(0, 20_000);
  if (Array.isArray(value))
    return value
      .slice(0, 128)
      .map((entry) => safeAgentResult(entry, depth + 1));
  if (typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_AGENT_RESULT_KEY.test(key)) continue;
    result[key] = safeAgentResult(entry, depth + 1);
  }
  return result;
}

function safeCreatorAgentResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("creator_agent_result_invalid");
  const result = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => SAFE_AGENT_RESULT_KEYS.has(key))
      .map(([key, entry]) => [key, safeAgentResult(entry)]),
  );
  return result;
}

export function createCreatorIpcHandlers(deps: CreatorIpcDependencies): {
  invokeHandlers: Record<string, InvokeHandler>;
} {
  const invokeHandlers: Record<string, InvokeHandler> = {
    "creator.inspect": async (_payload, ctx) => {
      requireCreatorEnabled(deps.readFlags(ctx.userId));
      return deps.inspect(ctx.userId);
    },
    'creator.agent.run': async (raw, ctx) => {
      requireCreatorEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_agent_request_invalid");
      const input: CreatorAgentInput = {
        goal: text(payload.goal, "creator_goal_invalid", 4_000),
        sourceSessionId: identifier(
          payload.sourceSessionId,
          "creator_source_session_invalid",
        ),
        ...(payload.projectId !== undefined &&
        payload.projectId !== null &&
        payload.projectId !== ""
          ? {
              projectId: identifier(
                payload.projectId,
                "creator_project_id_invalid",
              ),
            }
          : {}),
        ...(payload.cid !== undefined &&
        payload.cid !== null &&
        payload.cid !== ""
          ? { cid: identifier(payload.cid, "creator_cid_invalid") }
          : {}),
      };
      const userId = identifier(ctx?.userId, "creator_user_invalid");
      return safeCreatorAgentResult(await deps.runAgent(userId, input));
    },
    "creator.draft.propose": async (raw, ctx) => {
      requireCreatorEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_proposal_invalid");
      const goal = text(payload.goal, "creator_goal_invalid", 4_000);
      const sourceSessionId = identifier(
        payload.sourceSessionId,
        "creator_source_session_invalid",
      );
      return deps.propose(ctx.userId, { goal, sourceSessionId });
    },
    "creator.draft.read": async (raw, ctx) => {
      requireCreatorEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_draft_request_invalid");
      return {
        draft: await deps.readDraft(
          ctx.userId,
          identifier(payload.draftId, "creator_draft_id_invalid"),
        ),
      };
    },
    "creator.draft.simulate": async (raw, ctx) => {
      requireCreatorEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_simulation_invalid");
      return deps.simulate(ctx.userId, {
        manifest: payload.manifest,
        catalogSnapshot: Array.isArray(payload.catalogSnapshot)
          ? payload.catalogSnapshot
          : [],
        actions: Array.isArray(payload.actions) ? payload.actions : [],
        ...(Number.isSafeInteger(payload.timeoutMs)
          ? { timeoutMs: payload.timeoutMs }
          : {}),
      });
    },
    'creator.draft.verify': async (raw, ctx) => {
      requireCreatorEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_verification_invalid");
      const report = await deps.verify(ctx.userId, {
        manifest: payload.manifest,
        catalogSnapshot: Array.isArray(payload.catalogSnapshot)
          ? payload.catalogSnapshot
          : [],
      });
      if (
        payload.draftId !== undefined &&
        deps.lifecycle.sandboxPreset &&
        deps.lifecycle.recordVerification
      ) {
        const draftId = identifier(payload.draftId, "creator_draft_id_invalid");
        await deps.lifecycle.sandboxPreset(
          ctx.userId,
          draftId,
          report.manifestDigest,
        );
        await deps.lifecycle.recordVerification(ctx.userId, draftId, report);
      }
      return report;
    },
    "creator.draft.approve": async (raw, ctx) => {
      requirePublishEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_approval_invalid");
      const draftId = identifier(payload.draftId, "creator_draft_id_invalid");
      const approval = {
        draftId,
        manifestDigest: digest(payload.manifestDigest),
        verificationRunId: identifier(
          payload.verificationRunId,
          "creator_verification_run_invalid",
        ),
        ...confirmation(payload),
        approved: payload.approved === true,
        approvedCapabilities: identifiers(
          payload.approvedCapabilities,
          "creator_approval_scope_invalid",
        ),
        approvedSideEffects: identifiers(
          payload.approvedSideEffects,
          "creator_approval_scope_invalid",
        ),
      };
      if (!approval.approved) throw new Error("creator_approval_required");
      return deps.lifecycle.approvePreset(ctx.userId, draftId, approval);
    },
    "creator.preset.list": async (_raw, ctx) => {
      requireCreatorEnabled(deps.readFlags(ctx.userId));
      return {
        presets: (await deps.listPresets(ctx.userId)).map(safePresetSummary),
      };
    },
    "creator.preset.publish": async (raw, ctx) => {
      requirePublishEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_publish_invalid");
      const draftId = identifier(payload.draftId, "creator_draft_id_invalid");
      return deps.lifecycle.publishPreset(ctx.userId, draftId, {
        version: identifier(payload.version, "creator_version_invalid"),
        manifestDigest: digest(payload.manifestDigest),
        verificationRunId: identifier(
          payload.verificationRunId,
          "creator_verification_run_invalid",
        ),
      });
    },
    'creator.preset.activate': async (raw, ctx) => {
      requirePublishEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_activation_invalid");
      return deps.lifecycle.activatePreset(
        ctx.userId,
        identifier(payload.presetId, "creator_preset_id_invalid"),
        identifier(payload.version, "creator_version_invalid"),
      );
    },
    "creator.preset.disable": async (raw, ctx) => {
      requirePublishEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_disable_invalid");
      return deps.lifecycle.disablePreset(
        ctx.userId,
        identifier(payload.presetId, "creator_preset_id_invalid"),
        identifier(payload.version, "creator_version_invalid"),
        confirmation(payload),
      );
    },
    "creator.preset.rollback": async (raw, ctx) => {
      requirePublishEnabled(deps.readFlags(ctx.userId));
      const payload = object(raw, "creator_rollback_invalid");
      return deps.lifecycle.rollbackPreset(
        ctx.userId,
        identifier(payload.presetId, "creator_preset_id_invalid"),
        identifier(payload.version, "creator_version_invalid"),
        confirmation(payload),
      );
    },
  };
  return { invokeHandlers };
}

const creatorAgentServiceModule = "../features/creator/creator-agent-service";

const defaultRunAgent: CreatorAgentRunner = async (userId, input) => {
  const service = (await import(creatorAgentServiceModule)) as {
    runCreatorAgent?: CreatorAgentRunner;
  };
  if (!service.runCreatorAgent)
    throw new Error("creator_agent_service_unavailable");
  return service.runCreatorAgent(userId, input);
};

// Keep lifecycle construction lazy. ipc/index is imported by the Electron
// bootstrap while Creator modules are still initializing; eagerly constructing
// the service here creates a circular-module temporal dead zone in Vitest and
// during startup.
const lazyLifecycle: CreatorLifecycleIpc = {
  approvePreset: (...args) => createCreatorLifecycleService().approvePreset(...args),
  publishPreset: (...args) => createCreatorLifecycleService().publishPreset(...args),
  activatePreset: (...args) => createCreatorLifecycleService().activatePreset(...args),
  disablePreset: (...args) => createCreatorLifecycleService().disablePreset(...args),
  rollbackPreset: (...args) => createCreatorLifecycleService().rollbackPreset(...args),
  sandboxPreset: (...args) => createCreatorLifecycleService().sandboxPreset?.(...args),
  recordVerification: (...args) => createCreatorLifecycleService().recordVerification?.(...args),
};

const defaultHandlers = createCreatorIpcHandlers({
  readFlags: readCreatorFeatureFlags,
  inspect: inspectCreatorRuntime,
  propose: proposeCreatorPreset,
  readDraft: readCreatorDraft,
  simulate: runCreatorSimulation,
  verify: verifyCreatorPreset,
  lifecycle: lazyLifecycle,
  listPresets: listCreatorPresetSummaries,
  runAgent: defaultRunAgent,
});

export const invokeHandlers = defaultHandlers.invokeHandlers;
