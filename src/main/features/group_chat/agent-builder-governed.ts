/**
 * Governed Agent 创建师 path — map an `<agent>` container (extracted fields)
 * into a Creator preset draft.
 *
 * The direct-mode builder (`agent-builder.ts`) creates agents immediately via
 * `createAgentFromBlocks`. This module is the governed counterpart: it
 * materializes the container as a Creator Mode draft (preset manifest) so the
 * two-stage confirm / verify / publish flow can own the rest of the lifecycle.
 *
 * Security boundary (same as the direct path):
 * - create-only — a container carrying `<agent_id>` is rejected
 *   (`agent_builder_edit_not_supported`); the governed flow never patches an
 *   existing agent in place.
 * - the produced manifest is passed through `validateCreatorPresetManifest`
 *   before it is persisted, so only schema-valid drafts reach the Creator
 *   draft store.
 */

import { randomUUID } from "node:crypto";

import type { ExtractedFields } from "../agents";
import {
  creatorCatalogLogicalId,
  type CreatorCapabilityDescriptor,
} from "../creator/catalog";
import { validateCreatorPresetManifest } from "../creator/schema";
import { saveCreatorDraft, type CreatorPresetDraft } from "../creator/store";
import type {
  CreatorPresetManifestAgentFields,
  CreatorPresetManifestV1,
} from "../creator/types";

/**
 * Default model for governed drafts.
 *
 * The Creator Agent itself does not pin a provider/model — it calls
 * `chatWithModel` without one, so the core-agent runner resolves the user's
 * configured chat entry and falls back to `anthropic` / `claude-opus-4-8`
 * (src/main/model/core-agent/runner.ts:
 * `const providerId = primary?.provider || 'anthropic';` /
 * `const modelId = primary?.model || 'claude-opus-4-8';`). We mirror that
 * app default here so the draft is valid even when no explicit model was
 * configured at creation time; both ids pass the Creator schema's logical-id
 * validation.
 */
const DEFAULT_CREATOR_MODEL = {
  providerId: "anthropic",
  modelId: "claude-opus-4-8",
} as const satisfies CreatorPresetManifestV1["model"];

function canonicalToolId(value: string): string {
  return value.startsWith("tool.") ? value : creatorCatalogLogicalId("tool", value);
}

function canonicalSkillId(value: string): string {
  return value.startsWith("skill.") ? value : creatorCatalogLogicalId("skill", value);
}

function resolveCapability(
  catalog: readonly CreatorCapabilityDescriptor[],
  capabilityId: string,
  kind: "tool" | "skill",
): CreatorCapabilityDescriptor {
  const descriptor = catalog.find(
    (entry) =>
      entry.capabilityId === capabilityId &&
      entry.kind === kind &&
      entry.available,
  );
  if (!descriptor) {
    throw new Error(`creator_catalog_capability_unavailable: ${capabilityId}`);
  }
  return descriptor;
}

export async function containerToCreatorDraft(
  userId: string,
  fields: ExtractedFields,
  ctx: { sourceSessionId: string; projectId?: string },
  deps: {
    save?: typeof saveCreatorDraft;
    now?: () => string;
    id?: () => string;
    /** Optional host snapshot used to reject unknown/unavailable capabilities
     * before a governed draft is persisted. */
    catalog?: readonly CreatorCapabilityDescriptor[];
  } = {},
): Promise<CreatorPresetDraft> {
  if (fields.agent_id) throw new Error("agent_builder_edit_not_supported");

  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? randomUUID;

  // Optional `agent` section mirrors the config-sheet surface. Undefined
  // fields are omitted entirely (the schema rejects an empty `agent: {}`),
  // so when every subfield is absent we drop the section altogether.
  const agentFields: CreatorPresetManifestAgentFields = {
    ...(fields.category !== undefined ? { category: fields.category } : {}),
    ...(fields.icon !== undefined ? { icon: fields.icon } : {}),
    ...(fields.interactive !== undefined
      ? { interactive: fields.interactive }
      : {}),
    ...(fields.description_zh !== undefined
      ? { description_zh: fields.description_zh }
      : {}),
    ...(fields.description_en !== undefined
      ? { description_en: fields.description_en }
      : {}),
    ...(fields.knowhow !== undefined ? { knowhow: fields.knowhow } : {}),
    ...(fields.standards !== undefined ? { standards: fields.standards } : {}),
    ...(fields.inputs !== undefined
      ? {
          inputs: fields.inputs.map(
            (input) =>
              ({ ...input }) as NonNullable<
                CreatorPresetManifestAgentFields["inputs"]
              >[number],
          ),
        }
      : {}),
  };

  const manifest: CreatorPresetManifestV1 = {
    schemaVersion: 1,
    presetId: `agent-${id()}`,
    version: "1",
    displayName: fields.name || "",
    description:
      fields.description ||
      fields.description_zh ||
      fields.description_en ||
      "",
    presetType: "cogseed-agent",
    model: { ...DEFAULT_CREATOR_MODEL },
    capabilities: [
      ...(fields.tools || []).map((toolId) => {
        const capabilityId = canonicalToolId(toolId);
        const descriptor = deps.catalog
          ? resolveCapability(deps.catalog, capabilityId, "tool")
          : undefined;
        return {
          capabilityId,
          version: descriptor?.version ?? "1",
        };
      }),
      ...(fields.skill_list || []).map((sid) => {
        const capabilityId = canonicalSkillId(sid);
        const descriptor = deps.catalog
          ? resolveCapability(deps.catalog, capabilityId, "skill")
          : undefined;
        return {
          capabilityId,
          version: descriptor?.version ?? "1",
        };
      }),
    ],
    prompt: { systemSections: [fields.workflow || ""] },
    runtime: {
      sessionPolicy: "new-per-run",
      memoryPolicy: "none",
      loopPolicy: "single-agent",
      sandboxProfile: "creator-read-only-v1",
      timeoutMs: 120_000,
      budget: { maxTokens: 32_000 },
    },
    permissions: {
      tools: (fields.tools || []).map(canonicalToolId),
      files: [],
      sideEffects: [],
      approvalMode: "on-risk",
    },
    provenance: {
      createdBy: "creator-agent",
      sourceSessionId: ctx.sourceSessionId,
      sourceAssetRefs: [],
    },
    ...(Object.keys(agentFields).length > 0 ? { agent: agentFields } : {}),
  };

  const schema = validateCreatorPresetManifest(manifest);
  if (schema.ok === false) {
    throw new Error(
      `creator_manifest_invalid: ${schema.issues.map((issue) => issue.message).join("; ")}`,
    );
  }

  const draft: CreatorPresetDraft = {
    schemaVersion: 1,
    draftId: `draft-${id()}`,
    manifest: schema.value,
    updatedAt: now(),
  };
  return (deps.save ?? saveCreatorDraft)(userId, draft);
}
