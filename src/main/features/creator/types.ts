/**
 * Stable Creator Mode contracts.
 *
 * Creator manifests describe design-time intent and policy. They are not an
 * executable Agent runtime format; approved versions are materialized through
 * the existing Agent feature before they can run.
 */

export type CreatorPresetLifecycle =
  | 'draft'
  | 'sandboxed'
  | 'verified'
  | 'approved'
  | 'published'
  | 'active'
  | 'disabled'
  | 'rolled_back'
  | 'rejected';

export type CreatorAgentInputType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'number'
  | 'boolean'
  | 'file'
  | 'directory';

export type CreatorAgentInputUiLanguage = 'zh' | 'en' | 'ja' | 'pt';

export interface CreatorAgentInputOption {
  value: string;
  label: string;
}

/** Canonical subset of the current Agent runtime input shape. */
export interface CreatorAgentInput {
  id: string;
  label: string;
  description?: string;
  type: CreatorAgentInputType;
  required?: boolean;
  default: string | number | boolean | string[];
  default_by_ui_language?: Partial<Record<CreatorAgentInputUiLanguage, string>>;
  options?: CreatorAgentInputOption[];
  placeholder?: string;
  min?: number;
  max?: number;
  multiple?: boolean;
  accept?: string;
}

/**
 * Optional AI-team-specific fields carried on a Creator preset manifest.
 * They mirror the agent config-sheet surface (category / icon / color /
 * interactive / bilingual descriptions / knowhow / standards / inputs) so
 * later materialization can rebuild a chat-governed agent with the same
 * fidelity as the original sheet.
 */
export interface CreatorPresetManifestAgentFields {
  category?: string;
  icon?: string;
  color?: string;
  interactive?: boolean;
  description_zh?: string;
  description_en?: string;
  knowhow?: string[];
  standards?: string[];
  inputs?: CreatorAgentInput[];
}

export interface CreatorPresetManifestV1 {
  schemaVersion: 1;
  presetId: string;
  version: string;
  parentVersion?: string;
  displayName: string;
  description: string;
  presetType: 'cogseed-agent';
  agent?: CreatorPresetManifestAgentFields;
  model: {
    providerId: string;
    modelId: string;
    reasoningProfile?: string;
  };
  capabilities: Array<{
    capabilityId: string;
    version: string;
    configRef?: string;
  }>;
  prompt: {
    systemSections: string[];
    locale?: string;
  };
  runtime: {
    sessionPolicy: 'new-per-run' | 'resume-explicit';
    memoryPolicy: 'none' | 'read-only';
    loopPolicy: 'single-agent';
    sandboxProfile: 'creator-read-only-v1';
    timeoutMs: number;
    budget: {
      maxCost?: number;
      maxTokens?: number;
    };
  };
  permissions: {
    tools: string[];
    files: string[];
    sideEffects: string[];
    approvalMode: 'always' | 'on-risk' | 'preapproved';
  };
  provenance: {
    createdBy: 'user' | 'creator-agent';
    sourceSessionId: string;
    sourceAssetRefs: string[];
    verificationRunId?: string;
  };
}

export interface CreatorSchemaIssue {
  code:
    | 'creator_invalid_type'
    | 'creator_unknown_field'
    | 'creator_secret_field'
    | 'creator_sparse_array'
    | 'creator_invalid_value'
    | 'creator_invalid_id'
    | 'creator_invalid_reference'
    | 'creator_out_of_range';
  path: string;
  message: string;
}

export type CreatorSchemaResult =
  | { ok: true; value: CreatorPresetManifestV1 }
  | { ok: false; issues: CreatorSchemaIssue[] };

export interface CreatorFeatureFlags {
  creatorMode: boolean;
  publish: boolean;
}
