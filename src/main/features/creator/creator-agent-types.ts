import type { CreatorCapabilityDescriptor } from "./catalog";
import type { CreatorInspectSnapshot } from "./inspect-service";
import type { CreatorPresetDraft } from "./store";

export type { CreatorInspectSnapshot } from "./inspect-service";
export type { CreatorPresetDraft } from "./store";

export type CreatorAgentTurnStatus =
  "draft_ready" | "needs_clarification" | "blocked";

export type CreatorAgentCheckStatus = "passed" | "failed" | "skipped";

export type CreatorCapabilityPlanKind = "tool" | "skill";
export type CreatorCapabilityRiskLevel = "low" | "medium" | "high";

/**
 * Safe, renderer-facing explanation of the capabilities granted to the new
 * Agent. This is deliberately separate from CreatorPresetManifestV1: the
 * manifest remains the executable source of truth, while this DTO explains
 * the decision made during the chat.
 */
export interface CreatorAgentCapabilityPlanItem {
  id: string;
  kind: CreatorCapabilityPlanKind;
  version: string;
  reason: string;
  required: boolean;
  network: boolean;
  sideEffects: string[];
  riskLevel: CreatorCapabilityRiskLevel;
  dependencies: string[];
}

export interface CreatorAgentCapabilityPlan {
  tools: CreatorAgentCapabilityPlanItem[];
  skills: CreatorAgentCapabilityPlanItem[];
  riskLevel: CreatorCapabilityRiskLevel;
  creationMode: "direct" | "governed";
}

export interface CreatorAgentCheckSummary {
  checkId: string;
  status: CreatorAgentCheckStatus;
  summary: string;
}

export type CreatorAgentInspectionSummary = Pick<
  CreatorInspectSnapshot,
  "schemaVersion" | "flags" | "capabilities" | "sandboxProfiles" | "limits"
>;

export interface CreatorAgentTurn {
  schemaVersion: 1;
  status: CreatorAgentTurnStatus;
  message: string;
  draft?: CreatorPresetDraft;
  inspection?: CreatorAgentInspectionSummary;
  checks?: CreatorAgentCheckSummary[];
  capabilityPlan?: CreatorAgentCapabilityPlan;
  clarification?: {
    question: string;
    reason: string;
    risk: "low" | "high";
  };
}

const SAFE_CAPABILITY_KINDS: CreatorCapabilityDescriptor["kind"][] = [
  "model",
  "skill",
  "tool",
];
const SAFE_CAPABILITY_PERMISSIONS: CreatorCapabilityDescriptor["permissions"] =
  ["read", "write", "network", "cost", "side-effect"];
const SAFE_CAPABILITY_HEALTH: CreatorCapabilityDescriptor["health"][] = [
  "ready",
  "degraded",
  "unavailable",
];

const URL_LIKE = /\b(?:https?|wss?|ftp):\/\/\S+/i;
const ABSOLUTE_PATH_LIKE =
  /(?:^|[\s("'=])(?:\/[A-Za-z0-9._-]+|[A-Za-z]:[\\/]|\\\\)/;
const RAW_COMMAND_LIKE =
  /^\s*(?:npm|npx|node|pnpm|yarn|bash|sh|zsh|fish|cmd|powershell|pwsh|python(?:3)?|tsx|git|curl|wget|rm|cat|sed|awk)(?:\s|$)/i;
const SECRET_VALUE_LIKE =
  /\b(?:bearer|api[_-]?key|access[_-]?token|secret|password)\b\s*[:=]/i;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isUnsafeText(value: string): boolean {
  return (
    URL_LIKE.test(value) ||
    ABSOLUTE_PATH_LIKE.test(value) ||
    RAW_COMMAND_LIKE.test(value) ||
    SECRET_VALUE_LIKE.test(value)
  );
}

function sanitizeText(value: unknown): string {
  if (typeof value !== "string" || isUnsafeText(value)) return "[REDACTED]";
  return value;
}

function sanitizeIdentifier(value: unknown): string {
  const text = sanitizeText(value);
  return SAFE_IDENTIFIER.test(text) ? text : "[REDACTED]";
}

function sanitizeStringList(value: unknown, identifiers = false): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) =>
      identifiers ? sanitizeIdentifier(entry) : sanitizeText(entry),
    );
}

function safeEnum<T extends string>(
  value: unknown,
  values: T[],
  fallback: T,
): T {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fallback;
}

function safeTimestamp(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    isUnsafeText(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

function safeLimit(value: unknown, fallback: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.max(0, Math.floor(value));
  return maximum === undefined ? integer : Math.min(integer, maximum);
}

function sanitizeCapability(
  value: CreatorInspectSnapshot["capabilities"][number],
): CreatorInspectSnapshot["capabilities"][number] {
  const candidate = value as Partial<CreatorCapabilityDescriptor>;
  return {
    capabilityId: sanitizeIdentifier(candidate.capabilityId),
    version: sanitizeIdentifier(candidate.version),
    kind: safeEnum(candidate.kind, SAFE_CAPABILITY_KINDS, "tool"),
    displayName: sanitizeText(candidate.displayName),
    available: candidate.available === true,
    permissions: sanitizeStringList(candidate.permissions, true).filter(
      (
        permission,
      ): permission is CreatorCapabilityDescriptor["permissions"][number] =>
        SAFE_CAPABILITY_PERMISSIONS.includes(
          permission as CreatorCapabilityDescriptor["permissions"][number],
        ),
    ),
    sourceRef: sanitizeIdentifier(candidate.sourceRef),
    health: safeEnum(candidate.health, SAFE_CAPABILITY_HEALTH, "unavailable"),
  };
}

/**
 * Project a runtime inspection into the small, renderer-safe Creator Agent view.
 * The output is rebuilt from allow-listed fields instead of spreading runtime data.
 */
export function sanitizeCreatorAgentInspection(
  snapshot: CreatorInspectSnapshot,
): CreatorAgentInspectionSummary {
  const source = snapshot as unknown as Record<string, unknown>;
  const flags =
    source.flags &&
    typeof source.flags === "object" &&
    !Array.isArray(source.flags)
      ? (source.flags as Record<string, unknown>)
      : {};
  const limits =
    source.limits &&
    typeof source.limits === "object" &&
    !Array.isArray(source.limits)
      ? (source.limits as Record<string, unknown>)
      : {};

  return {
    schemaVersion: 1,
    flags: {
      creatorMode: flags.creatorMode === true,
      publish: flags.publish === true,
    },
    capabilities: Array.isArray(source.capabilities)
      ? source.capabilities.map((value) =>
          sanitizeCapability(
            value as CreatorInspectSnapshot["capabilities"][number],
          ),
        )
      : [],
    sandboxProfiles: ["creator-read-only-v1"],
    limits: {
      maxCapabilities: safeLimit(limits.maxCapabilities, 0, 64),
    },
  };
}
