import { randomUUID } from "node:crypto";

import {
  chatWithModel,
  type ChatOptions,
  type ChatResult,
} from "../../model/client";
import { prompts } from "../../prompts/loader";
import {
  buildCreatorCapabilityCatalog,
  creatorCatalogLogicalId,
  type CreatorCapabilityDescriptor,
} from "./catalog";
import {
  inspectCreatorRuntime,
  type CreatorInspectSnapshot,
} from "./inspect-service";
import { validateCreatorPresetManifest } from "./schema";
import {
  listCreatorPresetSummaries,
  saveCreatorDraft,
  type CreatorPresetDraft,
  type CreatorPresetSummary,
} from "./store";
import { sanitizeCreatorAgentInspection } from "./creator-agent-types";
import type {
  CreatorAgentCapabilityPlan,
  CreatorAgentCapabilityPlanItem,
  CreatorCapabilityRiskLevel,
  CreatorAgentCheckSummary,
  CreatorAgentInspectionSummary,
  CreatorAgentTurn,
  CreatorAgentTurnStatus,
} from "./creator-agent-types";
import type { CreatorPresetManifestV1, CreatorSchemaIssue } from "./types";

type CreatorChatOptions = ChatOptions & { toolAccess: "creator-read-only" };

const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_GOAL_LENGTH = 4_000;
const MAX_MESSAGE_LENGTH = 4_000;
const URL_VALUE = /(?:https?|wss?|ftp|file):\/\/|\bwww\./i;
const SECRET_VALUE =
  /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const SECRET_ASSIGNMENT =
  /\b(?:api.?key|access.?token|token|secret|password|authorization)\b\s*[:=]/i;
const FORBIDDEN_KEY =
  /(?:api.?key|token|secret|password|private.?key|authorization|raw.?header|headers?|endpoint|base.?url|socket|transport|session.?handle|command|shell|cwd|import.?path|connection|handle)/i;
const TRANSPORT_VALUE =
  /\b(?:socket.?handle|transport|session.?handle|raw.?header)\b\s*[:=]/i;
const RAW_COMMAND =
  /(?:^|[\s"'=:\[{(])(?:npm|npx|node|pnpm|yarn|bash|sh|zsh|fish|cmd|powershell|pwsh|python3?|tsx|git|curl|wget|rm|cat|sed|awk)(?:\s|$)/im;
const ABSOLUTE_PATH = /(?:^|[\s("'=])(?:\/[A-Za-z0-9._-]+|[A-Za-z]:[\\/]|\\\\)/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]*$/;

export interface CreatorAgentRequest {
  goal: string;
  sourceSessionId: string;
  projectId?: string;
  cid?: string;
}

export interface CreatorAgentServiceDependencies {
  chatWithModel?: (options: ChatOptions) => Promise<ChatResult>;
  chat?: (options: ChatOptions) => Promise<ChatResult>;
  buildCatalog?: (userId: string) => Promise<CreatorCapabilityDescriptor[]>;
  inspect?: (userId: string) => Promise<CreatorInspectSnapshot>;
  saveDraft?: (
    userId: string,
    draft: CreatorPresetDraft,
  ) => Promise<CreatorPresetDraft>;
  save?: (
    userId: string,
    draft: CreatorPresetDraft,
  ) => Promise<CreatorPresetDraft>;
  listPresets?: (userId: string) => Promise<CreatorPresetSummary[]>;
  list?: (userId: string) => Promise<CreatorPresetSummary[]>;
  /** Reserved for the host's safe validation adapters; never model-controlled. */
  simulate?: (...args: never[]) => Promise<unknown>;
  /** Reserved for the host's safe verification adapters; never model-controlled. */
  verify?: (...args: never[]) => Promise<unknown>;
  now?: () => string;
  createId?: () => string;
  id?: () => string;
  getLocale?: (userId: string) => string;
}

export class CreatorAgentError extends Error {
  readonly issues: CreatorSchemaIssue[];

  constructor(code: string, issues: CreatorSchemaIssue[] = []) {
    super(code);
    this.name = "CreatorAgentError";
    this.issues = issues;
  }
}

function issue(path: string, message: string): CreatorSchemaIssue {
  return { code: "creator_invalid_reference", path, message };
}

function cleanText(
  value: unknown,
  code: string,
  maxLength = MAX_MESSAGE_LENGTH,
): string {
  if (typeof value !== "string") throw new CreatorAgentError(code);
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (
    !cleaned ||
    cleaned.length > maxLength ||
    URL_VALUE.test(cleaned) ||
    SECRET_VALUE.test(cleaned) ||
    SECRET_ASSIGNMENT.test(cleaned) ||
    TRANSPORT_VALUE.test(cleaned) ||
    RAW_COMMAND.test(cleaned) ||
    ABSOLUTE_PATH.test(cleaned)
  ) {
    throw new CreatorAgentError(code);
  }
  return cleaned;
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !LOGICAL_ID.test(value))
    throw new CreatorAgentError(code);
  return value;
}

function unwrapFence(text: string): string {
  if (!text.startsWith("```")) return text;
  const match = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (!match) throw new CreatorAgentError("creator_agent_invalid_output");
  return match[1].trim();
}

function findObject(text: string): string {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      if (depth === 0)
        throw new CreatorAgentError("creator_agent_invalid_output");
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (depth !== 0 || inString || start < 0 || end < 0)
    throw new CreatorAgentError("creator_agent_invalid_output");
  const suffix = text.slice(end).trim();
  if (suffix) {
    // A second object is never a valid single-turn response, even if prose is
    // placed between the objects.
    if (suffix.includes("{") || suffix.includes("["))
      throw new CreatorAgentError("creator_agent_multiple_objects");
  }
  return text.slice(start, end);
}

function parseObject(raw: string): Record<string, unknown> {
  rejectUnsafeOutput(raw);
  const text = unwrapFence(raw.trim());
  try {
    const direct = JSON.parse(text) as unknown;
    if (direct && typeof direct === "object" && !Array.isArray(direct))
      return direct as Record<string, unknown>;
  } catch {
    // Try one object surrounded by harmless prose for compatibility with the
    // existing proposal adapter.
  }
  const parsed = JSON.parse(findObject(text)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CreatorAgentError("creator_agent_invalid_output");
  return parsed as Record<string, unknown>;
}

function rejectUnsafeOutput(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
): void {
  if (typeof value === "string") {
    if (
      !SAFE_TEXT.test(value) ||
      URL_VALUE.test(value) ||
      SECRET_VALUE.test(value) ||
      SECRET_ASSIGNMENT.test(value) ||
      TRANSPORT_VALUE.test(value) ||
      RAW_COMMAND.test(value) ||
      ABSOLUTE_PATH.test(value)
    ) {
      throw new CreatorAgentError("creator_agent_forbidden_output", [
        issue(path, "URLs, secrets, paths, or commands are forbidden"),
      ]);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value))
    throw new CreatorAgentError("creator_agent_invalid_output");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectUnsafeOutput(entry, `${path}.${index}`, seen),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key))
      throw new CreatorAgentError("creator_agent_forbidden_output", [
        issue(
          `${path}.${key}`,
          "transport, secret, endpoint, or command fields are forbidden",
        ),
      ]);
    rejectUnsafeOutput(entry, `${path}.${key}`, seen);
  }
}

function safeCatalog(
  catalog: readonly CreatorCapabilityDescriptor[],
): unknown[] {
  return catalog.map(
    ({ capabilityId, version, kind, available, permissions }) => ({
      capabilityId,
      version,
      kind,
      available,
      permissions,
    }),
  );
}

function safePresetList(presets: readonly CreatorPresetSummary[]): unknown[] {
  return presets.map(
    ({
      presetId,
      version,
      displayName,
      description,
      presetType,
      updatedAt,
    }) => ({
      presetId,
      version,
      displayName,
      description,
      presetType,
      ...(updatedAt ? { updatedAt } : {}),
    }),
  );
}

function buildSystemPrompt(
  goal: string,
  sourceSessionId: string,
  locale: string,
  inspection: CreatorAgentInspectionSummary,
  catalog: readonly CreatorCapabilityDescriptor[],
  presets: readonly CreatorPresetSummary[],
): string {
  const runtime = {
    locale,
    sourceSessionId,
    inspection,
    catalog: safeCatalog(catalog),
    existingPresets: safePresetList(presets),
    limits: inspection.limits,
  };
  return `${prompts.load("creator_agent").trim()}\n\n## Runtime injection\n\n${JSON.stringify(runtime, null, 2)}\n\n## User goal\n\n${goal}`;
}

const CAPABILITY_PLAN_KINDS = ["tool", "skill"] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const CREATION_MODES = ["direct", "governed"] as const;
const MAX_PLAN_ITEMS = 32;

function planIssue(path: string, message: string): CreatorSchemaIssue {
  return { code: "creator_invalid_reference", path, message };
}

function planText(value: unknown, path: string, maxLength = 500): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    URL_VALUE.test(value) ||
    SECRET_VALUE.test(value) ||
    SECRET_ASSIGNMENT.test(value) ||
    TRANSPORT_VALUE.test(value) ||
    RAW_COMMAND.test(value) ||
    ABSOLUTE_PATH.test(value)
  ) {
    throw new CreatorAgentError("creator_agent_capability_plan_invalid", [
      planIssue(path, "capability plan text is unsafe or invalid"),
    ]);
  }
  return value.trim();
}

function planId(value: unknown, path: string): string {
  return identifier(value, "creator_agent_capability_plan_invalid") || path;
}

function selectedCapabilityIds(
  manifest: CreatorPresetManifestV1,
  catalog: readonly CreatorCapabilityDescriptor[],
  kind: "tool" | "skill",
): string[] {
  if (kind === "tool") return [...manifest.permissions.tools];
  return manifest.capabilities
    .filter((entry) =>
      catalog.some(
        (descriptor) =>
          descriptor.capabilityId === entry.capabilityId &&
          descriptor.version === entry.version &&
          descriptor.kind === "skill",
      ),
    )
    .map((entry) => entry.capabilityId);
}

function maxRisk(
  left: CreatorCapabilityRiskLevel,
  right: CreatorCapabilityRiskLevel,
): CreatorCapabilityRiskLevel {
  const order = { low: 0, medium: 1, high: 2 };
  return order[left] >= order[right] ? left : right;
}

function descriptorRisk(
  descriptor: CreatorCapabilityDescriptor,
): CreatorCapabilityRiskLevel {
  if (
    descriptor.permissions.includes("network") ||
    descriptor.permissions.includes("write") ||
    descriptor.permissions.includes("side-effect")
  )
    return "high";
  if (
    descriptor.permissions.includes("read") ||
    descriptor.permissions.includes("cost")
  )
    return "medium";
  return "low";
}

function goalForbids(
  goal: string,
  descriptor: CreatorCapabilityDescriptor,
): boolean {
  const noNetwork =
    /(?:不联网|不使用网络|禁止网络|no\s+network|without\s+network|offline)/i.test(
      goal,
    );
  const noTools =
    /(?:不调用工具|不使用工具|禁止工具|no\s+tools?|without\s+tools?)/i.test(
      goal,
    );
  const noWrite =
    /(?:不修改文件|不写文件|禁止写入|no\s+(?:file\s+)?writes?|without\s+(?:file\s+)?writes?)/i.test(
      goal,
    );
  return (
    (noNetwork && descriptor.permissions.includes("network")) ||
    (noTools && descriptor.kind === "tool") ||
    (noWrite &&
      (descriptor.permissions.includes("write") ||
        descriptor.permissions.includes("side-effect")))
  );
}

function normalizeIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function parseCapabilityPlan(
  value: unknown,
  manifest: CreatorPresetManifestV1,
  catalog: readonly CreatorCapabilityDescriptor[],
  goal: string,
): CreatorAgentCapabilityPlan | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CreatorAgentError("creator_agent_capability_plan_invalid");
  }
  const raw = value as Record<string, unknown>;
  const parseItems = (
    kind: "tool" | "skill",
  ): CreatorAgentCapabilityPlanItem[] => {
    const list = raw[kind === "tool" ? "tools" : "skills"];
    if (!Array.isArray(list) || list.length > MAX_PLAN_ITEMS) {
      throw new CreatorAgentError("creator_agent_capability_plan_invalid", [
        planIssue(
          `capability_plan.${kind}s`,
          "capability plan list is invalid",
        ),
      ]);
    }
    return list.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new CreatorAgentError("creator_agent_capability_plan_invalid");
      const row = entry as Record<string, unknown>;
      const path = `capability_plan.${kind}s.${index}`;
      const id = planId(row.id, `${path}.id`);
      const version = identifier(
        row.version,
        "creator_agent_capability_plan_invalid",
      );
      if (row.kind !== kind)
        throw new CreatorAgentError("creator_agent_capability_plan_invalid", [
          planIssue(`${path}.kind`, "capability kind does not match its list"),
        ]);
      const descriptor = catalog.find(
        (candidate) =>
          candidate.capabilityId === id && candidate.version === version,
      );
      if (!descriptor || descriptor.kind !== kind || !descriptor.available) {
        throw new CreatorAgentError("creator_agent_catalog_mismatch", [
          planIssue(
            `${path}.id`,
            "capability is not available in the current catalog",
          ),
        ]);
      }
      if (goalForbids(goal, descriptor)) {
        throw new CreatorAgentError(
          "creator_agent_capability_conflicts_with_goal",
          [
            planIssue(
              `${path}.id`,
              "capability conflicts with an explicit user restriction",
            ),
          ],
        );
      }
      const derivedRisk = descriptorRisk(descriptor);
      const workflow = manifest.prompt.systemSections.join("\n");
      const capabilityLeaf = id.split(".").at(-1) ?? id;
      if (
        !workflow.includes(id) &&
        !workflow.includes(capabilityLeaf) &&
        !workflow.includes(descriptor.displayName)
      ) {
        throw new CreatorAgentError("creator_agent_capability_plan_mismatch", [
          planIssue(
            `${path}.id`,
            "capability is not referenced by the workflow",
          ),
        ]);
      }
      const riskLevel = row.riskLevel;
      if (typeof row.required !== "boolean") {
        throw new CreatorAgentError("creator_agent_capability_plan_invalid", [
          planIssue(`${path}.required`, "required must be a boolean"),
        ]);
      }
      if (!RISK_LEVELS.includes(riskLevel as (typeof RISK_LEVELS)[number]))
        throw new CreatorAgentError("creator_agent_capability_plan_invalid");
      if (
        RISK_LEVELS.indexOf(riskLevel as (typeof RISK_LEVELS)[number]) <
        RISK_LEVELS.indexOf(derivedRisk)
      ) {
        throw new CreatorAgentError("creator_agent_capability_plan_invalid", [
          planIssue(
            `${path}.riskLevel`,
            "declared risk is lower than catalog policy",
          ),
        ]);
      }
      const sideEffects = row.sideEffects;
      if (!Array.isArray(sideEffects) || sideEffects.length > 16)
        throw new CreatorAgentError("creator_agent_capability_plan_invalid");
      const dependencies = row.dependencies;
      if (!Array.isArray(dependencies) || dependencies.length > 16)
        throw new CreatorAgentError("creator_agent_capability_plan_invalid");
      const normalizedDependencies = dependencies.map((dep) =>
        planId(dep, `${path}.dependencies`),
      );
      for (const dependency of normalizedDependencies) {
        if (
          !catalog.some(
            (candidate) =>
              candidate.capabilityId === dependency && candidate.available,
          )
        ) {
          throw new CreatorAgentError("creator_agent_catalog_mismatch", [
            planIssue(
              `${path}.dependencies`,
              "capability dependency is not available",
            ),
          ]);
        }
      }
      const network = row.network;
      if (
        typeof network !== "boolean" ||
        network !== descriptor.permissions.includes("network")
      ) {
        throw new CreatorAgentError("creator_agent_capability_plan_invalid", [
          planIssue(
            `${path}.network`,
            "network flag must match catalog policy",
          ),
        ]);
      }
      return {
        id,
        kind,
        version,
        reason: planText(row.reason, `${path}.reason`),
        required: row.required,
        network,
        sideEffects: sideEffects.map((effect) =>
          planText(effect, `${path}.sideEffects`),
        ),
        riskLevel: riskLevel as CreatorCapabilityRiskLevel,
        dependencies: normalizedDependencies,
      };
    });
  };
  const tools = parseItems("tool");
  const skills = parseItems("skill");
  const expectedTools = selectedCapabilityIds(manifest, catalog, "tool");
  const expectedSkills = selectedCapabilityIds(manifest, catalog, "skill");
  if (
    JSON.stringify(normalizeIds(tools.map((item) => item.id))) !==
    JSON.stringify(normalizeIds(expectedTools))
  ) {
    throw new CreatorAgentError("creator_agent_capability_plan_mismatch", [
      planIssue(
        "capability_plan.tools",
        "tool plan does not match manifest permissions",
      ),
    ]);
  }
  if (
    JSON.stringify(normalizeIds(skills.map((item) => item.id))) !==
    JSON.stringify(normalizeIds(expectedSkills))
  ) {
    throw new CreatorAgentError("creator_agent_capability_plan_mismatch", [
      planIssue(
        "capability_plan.skills",
        "skill plan does not match manifest capabilities",
      ),
    ]);
  }
  const derivedRisk = [...tools, ...skills].reduce(
    (risk, item) => maxRisk(risk, item.riskLevel),
    "low" as CreatorCapabilityRiskLevel,
  );
  const riskLevel = raw.riskLevel;
  if (
    !RISK_LEVELS.includes(riskLevel as (typeof RISK_LEVELS)[number]) ||
    RISK_LEVELS.indexOf(riskLevel as (typeof RISK_LEVELS)[number]) <
      RISK_LEVELS.indexOf(derivedRisk)
  ) {
    throw new CreatorAgentError("creator_agent_capability_plan_invalid", [
      planIssue(
        "capability_plan.riskLevel",
        "risk level does not satisfy catalog policy",
      ),
    ]);
  }
  const creationMode = raw.creationMode;
  if (!CREATION_MODES.includes(creationMode as (typeof CREATION_MODES)[number]))
    throw new CreatorAgentError("creator_agent_capability_plan_invalid");
  const expectedMode = derivedRisk === "low" ? "direct" : "governed";
  if (creationMode !== expectedMode)
    throw new CreatorAgentError("creator_agent_capability_plan_invalid", [
      planIssue(
        "capability_plan.creationMode",
        "creation mode does not satisfy risk policy",
      ),
    ]);
  return {
    tools,
    skills,
    riskLevel: riskLevel as CreatorCapabilityRiskLevel,
    creationMode: creationMode as "direct" | "governed",
  };
}

function catalogIssues(
  manifest: CreatorPresetManifestV1,
  catalog: readonly CreatorCapabilityDescriptor[],
): CreatorSchemaIssue[] {
  const issues: CreatorSchemaIssue[] = [];
  const exact = new Map(
    catalog.map((entry) => [
      `${entry.capabilityId}\u0000${entry.version}`,
      entry,
    ]),
  );
  const modelId = creatorCatalogLogicalId(
    "model",
    manifest.model.providerId,
    manifest.model.modelId,
  );
  if (
    !catalog.some(
      (entry) =>
        entry.capabilityId === modelId &&
        entry.kind === "model" &&
        entry.available,
    )
  ) {
    issues.push(
      issue("model", "model is not available in the current catalog"),
    );
  }
  manifest.capabilities.forEach((entry, index) => {
    const descriptor = exact.get(`${entry.capabilityId}\u0000${entry.version}`);
    if (!descriptor?.available)
      issues.push(
        issue(
          `capabilities.${index}.capabilityId`,
          "capability is not available in the current catalog",
        ),
      );
  });
  manifest.permissions.tools.forEach((tool, index) => {
    if (
      !catalog.some(
        (entry) =>
          entry.capabilityId === tool &&
          entry.kind === "tool" &&
          entry.available,
      )
    ) {
      issues.push(
        issue(
          `permissions.tools.${index}`,
          "tool is not available in the current catalog",
        ),
      );
    }
  });
  manifest.permissions.files.forEach((grant, index) => {
    if (grant !== "workspace.readonly")
      issues.push(
        issue(
          `permissions.files.${index}`,
          "file grant is not allowed by Creator policy",
        ),
      );
  });
  manifest.permissions.sideEffects.forEach((_entry, index) =>
    issues.push(
      issue(
        `permissions.sideEffects.${index}`,
        "side effects require explicit approval",
      ),
    ),
  );
  return issues;
}

function manifestFromResponse(response: Record<string, unknown>): unknown {
  if (response.status === undefined) return response;
  const draft = response.draft ?? response.manifest;
  if (
    response.status === "draft_ready" &&
    draft &&
    typeof draft === "object" &&
    !Array.isArray(draft)
  ) {
    const candidate = draft as Record<string, unknown>;
    return "manifest" in candidate &&
      candidate.manifest &&
      typeof candidate.manifest === "object"
      ? candidate.manifest
      : candidate;
  }
  return undefined;
}

function safeChecks(value: unknown): CreatorAgentCheckSummary[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new CreatorAgentError("creator_agent_invalid_output");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new CreatorAgentError("creator_agent_invalid_output");
    const row = entry as Record<string, unknown>;
    const checkId = identifier(row.checkId, "creator_agent_check_invalid");
    const status = row.status;
    if (status !== "passed" && status !== "failed" && status !== "skipped")
      throw new CreatorAgentError("creator_agent_check_invalid");
    return {
      checkId,
      status,
      summary: cleanText(row.summary, "creator_agent_check_invalid"),
    };
  });
}

function clarification(value: unknown): CreatorAgentTurn["clarification"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CreatorAgentError("creator_agent_clarification_invalid");
  const row = value as Record<string, unknown>;
  const risk = row.risk;
  if (risk !== "high")
    throw new CreatorAgentError("creator_agent_clarification_not_high_risk");
  return {
    question: cleanText(row.question, "creator_agent_clarification_invalid"),
    reason: cleanText(row.reason, "creator_agent_clarification_invalid"),
    risk,
  };
}

async function modelOutput(
  userId: string,
  request: CreatorAgentRequest,
  sessionId: string,
  systemPrompt: string,
  deps: CreatorAgentServiceDependencies,
): Promise<string> {
  const options = {
    userId,
    message: request.goal,
    sessionId: `creator-${sessionId}`,
    systemPrompt,
    ephemeralSession: true,
    skillList: [],
    idleTimeout: 120,
    streamIdleTimeout: 60,
    toolAccess: "creator-read-only",
    ...(request.projectId ? { projectId: request.projectId } : {}),
    ...(request.cid ? { cid: request.cid } : {}),
  } as unknown as CreatorChatOptions;
  try {
    const result = await (deps.chatWithModel ?? deps.chat ?? chatWithModel)(
      options,
    );
    if (!result.ok || result.aborted)
      throw new CreatorAgentError("creator_agent_model_failed");
    return result.text;
  } catch (error) {
    if (error instanceof CreatorAgentError) throw error;
    throw new CreatorAgentError("creator_agent_model_failed");
  }
}

export async function runCreatorAgent(
  userId: string,
  input: CreatorAgentRequest,
  deps: CreatorAgentServiceDependencies = {},
): Promise<CreatorAgentTurn> {
  if (!userId) throw new CreatorAgentError("creator_user_invalid");
  const goal = cleanText(input?.goal, "creator_goal_invalid", MAX_GOAL_LENGTH);
  const sourceSessionId = identifier(
    input?.sourceSessionId,
    "creator_source_session_invalid",
  );
  const projectId =
    input?.projectId === undefined
      ? undefined
      : identifier(input.projectId, "creator_project_invalid");
  const cid =
    input?.cid === undefined
      ? undefined
      : identifier(input.cid, "creator_cid_invalid");
  const turnId = identifier(
    (deps.id ?? deps.createId ?? randomUUID)(),
    "creator_agent_id_invalid",
  );
  const catalog = await (deps.buildCatalog ?? buildCreatorCapabilityCatalog)(
    userId,
  );
  const snapshot = await (
    deps.inspect ??
    ((id: string) =>
      inspectCreatorRuntime(id, {
        buildCatalog: async () => catalog,
      }))
  )(userId);
  const inspection = sanitizeCreatorAgentInspection(snapshot);
  const presets = await (
    deps.listPresets ??
    deps.list ??
    listCreatorPresetSummaries
  )(userId);
  const systemPrompt = buildSystemPrompt(
    goal,
    sourceSessionId,
    (deps.getLocale ?? (() => "en"))(userId),
    inspection,
    catalog,
    presets,
  );
  const raw = await modelOutput(
    userId,
    {
      goal,
      sourceSessionId,
      ...(projectId ? { projectId } : {}),
      ...(cid ? { cid } : {}),
    },
    turnId,
    systemPrompt,
    deps,
  );
  const response = parseObject(raw);
  rejectUnsafeOutput(response);
  const status = response.status as CreatorAgentTurnStatus | undefined;
  const checks = safeChecks(response.checks);
  const message =
    response.message === undefined
      ? status === undefined
        ? "Draft prepared for review."
        : status === "blocked"
          ? "Creator Agent blocked this request."
          : "Creator Agent response."
      : cleanText(response.message, "creator_agent_message_invalid");

  if (status === "needs_clarification") {
    return {
      schemaVersion: 1,
      status,
      message,
      inspection,
      ...(checks ? { checks } : {}),
      clarification: clarification(response.clarification),
    };
  }
  if (status === "blocked") {
    return {
      schemaVersion: 1,
      status,
      message,
      inspection,
      ...(checks ? { checks } : {}),
    };
  }
  if (status !== undefined && status !== "draft_ready")
    throw new CreatorAgentError("creator_agent_status_invalid");

  const rawManifest = manifestFromResponse(response);
  if (!rawManifest)
    throw new CreatorAgentError("creator_agent_manifest_missing");
  rejectUnsafeOutput(rawManifest);
  const trusted = {
    ...(rawManifest as Record<string, unknown>),
    provenance: {
      createdBy: "creator-agent",
      sourceSessionId,
      sourceAssetRefs: [],
    },
  };
  const schema = validateCreatorPresetManifest(trusted);
  if (schema.ok === false)
    throw new CreatorAgentError(
      "creator_agent_manifest_invalid",
      schema.issues,
    );
  const references = catalogIssues(schema.value, catalog);
  if (references.length > 0)
    throw new CreatorAgentError("creator_agent_catalog_mismatch", references);
  const capabilityPlan = parseCapabilityPlan(
    response.capability_plan,
    schema.value,
    catalog,
    goal,
  );
  const draft: CreatorPresetDraft = {
    schemaVersion: 1,
    draftId: `draft-${turnId}`,
    manifest: schema.value,
    updatedAt: (deps.now ?? (() => new Date().toISOString()))(),
  };
  const saved = await (deps.saveDraft ?? deps.save ?? saveCreatorDraft)(
    userId,
    draft,
  );
  return {
    schemaVersion: 1,
    status: "draft_ready",
    message,
    inspection,
    draft: saved,
    ...(checks ? { checks } : {}),
    ...(capabilityPlan ? { capabilityPlan } : {}),
  };
}
