/**
 * Runner factory — assembles a fresh `AgentRunner` per chat request.
 *
 * Priority-list driven:
 *   - `pickChatEntry()` returns the first usable (provider, model, apiKey)
 *     tuple from the user-ordered entries list (see features/auth.ts).
 *   - The runner rebuilds `defaultProvider` + `defaultModel` to match that
 *     choice on every build, so the entries list is the single source of
 *     truth for "what model am I talking to right now".
 *   - Cheap: we use pi-ai through a per-build `ProviderRegistry` and only
 *     materialize the single provider we picked.
 *
 * When `pickChatEntry()` returns null we fail fast with a user-facing
 * "no model configured" error so the renderer doesn't surface the Anthropic SDK's
 * cryptic "Could not resolve authentication method" message. Dev escape
 * hatch: set `ANTHROPIC_API_KEY` in the environment and we pass through
 * to the SDK's default-provider + env-var auth path.
 */

import type { AgentTool, HistoryResource, LLMProvider, ToolContext, ToolResult } from '#core-agent';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  pickChatEntryGroup,
  pickChatEntryGroupForUser,
  pickChatEntryGroupForModelOverride,
  pickChatEntryGroupForModelCandidates,
  pickChatEntryGroupForModelCandidatesForUser,
  pickChatEntryGroupForModelOverrideForUser,
  bumpEntryLastUsed,
  bumpEntryLastUsedForUser,
  hasConfiguredModel,
  hasConfiguredModelForUser,
  getConfiguredModelCooldown,
  getConfiguredModelCooldownForUser,
  getConfiguredModelOAuthExpiredMessage,
  getConfiguredModelOAuthExpiredMessageForUser,
  type ChatEntryChoice,
} from '../../features/auth';
import { getSystemPromptBlock, getSystemSkillsPromptBlock } from './skill-registry';
import { openBuiltinNamesOf } from '../../features/agent_builtin_capabilities';
import { t } from '../../i18n';
// tool-catalog.ts: TOOL_CATALOG kept as the source of truth for the drift
// test (tool-catalog.test.ts asserts injected names ⊆ catalog) and for any
// future targeted use; runtime no longer renders the prompt block from it.
import { getSession, memoryScopeForSession, sessionKindOf, toolResultsDirForSession } from './session-store';
import {
  listEntries,
  listSpaceEntriesWithProjectFallback,
  formatForSystemPrompt as formatMemoryForSystemPrompt,
  type MemoryScope,
} from '../../features/memory';
import { listActiveCognitionSourceIds } from '../../features/cognition';
import {
  formatSpaceContextPolicyForSystemPrompt,
  formatSpaceInstructionsForSystemPrompt,
  writeSpaceInstructions,
} from '../../features/spaces';
import { formatRoleProfileForSystemPrompt, readSpacePrimaryTemplateId } from '../../features/spaces';
import * as metacognition from '../../features/metacognition';
import {
  assertAgentChatDispatchable,
  creatorRuntimeExecutionOptions,
  getAgentDispatchPolicy,
  isAgentChatDispatchable,
} from '../../features/agent-dispatch-policy';
import { appendAgentSkill, getAgentForChatDispatch, listAgentSummaries, listAgentSummariesForUser } from '../../features/agents';
const log = createLogger('model/runner');
import { createLocalTools, createFileTools } from './local-tools';
import type { ShellApprovalInput, ShellApprovalDecision } from '../client';
import { createOfficeTools } from './office-tools';
import { officeCliAvailable } from '../../features/office/office_engine';
import { createKbTools } from './kb-tools';
import { createTranscriptGlossaryTools } from './transcript-glossary-tools';
import { createRecallToolSuite } from './recall-tools';
import type { OntologyAnswerEvidenceBundle } from '../../features/recall/ontology-answer-validation';
import { createAssetStewardTools } from './asset-steward-tools';
import { createCognitionEditTools } from './cognition-edit-tools';
import { createCognitionCreateTools } from './cognition-create-tools';
import { createExperienceTools } from './experience-tools';
import { createPersonalOntologyTools } from './personal-ontology-tools';
import { createMeetingOntologyTools } from './meeting-ontology-tools';
import { createCognitionKernelTools } from './cognition-kernel-tools';
import { createChatHistoryTools } from './chat-history-tools';
import { createMessagingTools } from './messaging-tools';
import { createP3394Tools } from './p3394-tools';
import { createFeishuTools } from './feishu-tools';
import { createImageGenTool } from './image-gen-tool';
import { createResearchRerankTool } from './research-rerank-tool';
import { isToolVisibleToAgent } from './tool-catalog';
import { createToolFailureGuard, guardToolsWithFailureBreaker } from './tool-failure-guard';
import { createWebSearchOverrideTool } from './search-tools';
import {
  agentEvolvedSkillsDir,
  agentPrivateSkillsDir,
  userMarketplaceAgentSkillsDir,
  userSystemSkillsDir,
} from '../../paths';
import { artifactDirForConversation } from '../../util/project-layout';
import {
  capToolResult,
  DEFAULT_INLINE_RESULT_TOKENS,
} from '../../util/tool-result-cap';
import { createToolResultTools } from './tool-result-tools';
import {
  buildMoonshotModel,
  buildDeepSeekModel,
  buildDoubaoModel,
  createMoonshotProvider,
  createDeepSeekProvider,
  createDoubaoProvider,
  createOpenAICompatibleProvider,
} from './external-providers';
import { createRotatingProvider, type RotatingCandidate } from './rotating-provider';
import { clearCooldown, clearCooldownForUser } from './profile-cooldown';
import {
  buildCustomProviderModelMeta,
  createCustomProvider,
  findCustomProvider,
  isCustomProviderId,
} from './custom_provider_runtime';
import { EXTERNAL_API_PROVIDERS, resolveConfiguredPiModel } from '../provider_catalog';
import { applyModelAbilityOverride, modelAbilityOverrideFor } from '../model_ability_overrides';
import { readDisabledSets } from '../../features/component_enabled';
import { nativeSearchToolForApi, nativeSearchToolName } from './native-search-tools';
import { assertUtilityResponseFormat, composeUtilityResponseFormatOnPayload, type UtilityResponseFormatOptions } from './utility-response-format';
import { hasAnySearchProfile } from '../../features/search_auth';
import { createConnectorMetaTools, getConnectorPromptBlock } from './connector-meta-tools';
import { createLogger } from '../../logger';
import { logErrorSummary, maskId } from '../../util/log-redact';
import type { MemoryToolHandler } from '../../../core-agent/src/tools/memory-tool';
import type { MetacognitionToolHandler } from '../../../core-agent/src/tools/metacognition-tool';
import type { CognitionSaveReceipt } from '../client';


const runnerLog = createLogger('runner');

function isNativeSearchEnabled(): boolean {
  return true;
}

function buildExternalProviderModel(userId: string | null, providerId: string, modelId: string, maxOutputTokens?: number): { contextWindow?: number; maxTokens?: number } | null {
  if (isCustomProviderId(providerId)) {
    const provider = userId ? findCustomProvider(userId, providerId) : undefined;
    return provider ? buildCustomProviderModelMeta(provider, modelId) : null;
  }
  switch (providerId) {
    case 'moonshot':
      return buildMoonshotModel(modelId);
    case 'deepseek':
      // 本地覆盖（设置页「预设详情」）优先于预设：窗口/输出是运行时预算的来源。
      return buildDeepSeekModel(modelId, modelAbilityOverrideFor('deepseek', modelId));
    case 'doubao':
      return buildDoubaoModel(modelId);
    case 'openai-compatible':
      return { contextWindow: 131072, maxTokens: Math.max(8192, Math.min(32768, Math.trunc(Number(maxOutputTokens) || 32768))) };
    default:
      return null;
  }
}

function modelCatalogEntryFromModel(
  model: { contextWindow?: number; maxTokens?: number } | null | undefined,
  maxOutputTokens?: number,
): { contextWindow?: number; maxOutputTokens?: number } | null {
  const entry: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (typeof model?.contextWindow === 'number' && model.contextWindow > 0) {
    entry.contextWindow = model.contextWindow;
  }
  if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
    entry.maxOutputTokens = Math.min(
      maxOutputTokens,
      typeof model?.maxTokens === 'number' && model.maxTokens > 0 ? model.maxTokens : maxOutputTokens,
    );
  } else if (typeof model?.maxTokens === 'number' && model.maxTokens > 0) {
    entry.maxOutputTokens = model.maxTokens;
  }
  return Object.keys(entry).length ? entry : null;
}

type CA = typeof import('#core-agent');
type AgentRunnerCtor = CA['AgentRunner'];
type AgentRunnerInstance = InstanceType<AgentRunnerCtor>;
type CoreAgentConfig = ReturnType<CA['createConfig']>;

let _caPromise: Promise<CA> | null = null;
function applyRetryErrorPolicy(mod: CA): void {
  try {
    mod.configureRetryErrorPolicy();
  } catch (err) {
    runnerLog.warn('retry error policy sync failed', { error: logErrorSummary(err) });
  }
}

async function ca(): Promise<CA> {
  if (!_caPromise) _caPromise = import('#core-agent') as Promise<CA>;
  const mod = await _caPromise;
  applyRetryErrorPolicy(mod);
  return mod;
}

/** No-op retained for backward compat; nothing is cached anymore. */
export function invalidateConfig(): void {}

function _intersectRenderAllowlist(
  agentList: readonly string[] | undefined,
  projectList: readonly string[] | undefined,
): readonly string[] | undefined {
  if (projectList === undefined) return agentList;
  if (agentList === undefined) return projectList;
  const agentSet = new Set(agentList);
  return projectList.filter((id) => agentSet.has(id));
}

export interface BuildRunnerParams {
  sessionId: string;
  systemPrompt?: string;
  userId?: string;
  /** Per-task model override from the unified execution entry. Resolved via
   *  `pickChatEntryGroupForModelOverride`; when the provider has no usable
   *  entry the default group runs and the resolved runtime reports the
   *  model that actually executed. */
  modelOverride?: { provider: string; model: string };
  /** Explicit task route. Uses the normal rotating provider; no global fallback. */
  modelCandidates?: readonly { provider: string; model: string }[];
  /** Optional per-call output ceiling. It can only narrow model/runtime caps;
   * utility callers use it to bound spend without changing account settings. */
  maxOutputTokens?: number;
  /** Budgeted utility jobs reserve quota before each provider request, including retries. */
  onModelDispatch?: () => Promise<void>;
  /** Use an in-memory Session so utility model calls leave no resumable transcript. */
  ephemeralSession?: boolean;
  /** Immutable trusted-reception ceiling, frozen by the host for a trusted
   *  inbound A2A turn. When present, context and tool scope are restricted to
   *  this single root; ordinary local turns never set it. */
  receptionScope?: import('../../features/a2a/reception-scope').TrustedReceptionScope;
  /** Allowed external-history projection for a trusted reception turn: the
   *  peer's own questions plus the answers they received, read from the
   *  host-owned conversation transcript. Only meaningful with `receptionScope`;
   *  the runner replays it into an in-memory session instead of opening the
   *  local resumable session. Ordinary local turns never set it. */
  receptionHistory?: readonly import('../../features/a2a/reception-context').ReceptionHistoryTurn[];
  /** Explicit syntax-only JSON mode for tool-free ephemeral utility calls.
   * Supported adapters opt in; ordinary chats keep their existing payload. */
  responseFormat?: 'json_object';
  /** Conversation id. Used by file-tools to scope read_file / search_file
   *  / process_file_full calls whose path targets the attachment dir of the
   *  current conv. */
  cid?: string;
  /** 每会话访问权限模式（full / auto_approve / ask），由 group_chat 从会话
   *  元数据解析后传入，透传给 local-tools / file-tools 的敏感操作门。 */
  permissionMode?: 'full' | 'auto_approve' | 'ask';
  /** 逐次写入审批（A2A 接待）：由 group_chat 在接访会话里注入，普通会话不传。
   *  返回拒绝码表示本人没有批准这次写入。 */
  beforeWriteApproval?: (input: { toolName: 'write_file' | 'edit_file'; path: string; content: string }) => Promise<string | null>;
  beforeShellApproval?: (input: ShellApprovalInput) => Promise<ShellApprovalDecision>;
  /** Stable id for the current visible actor/model turn. Used by delete_file
   *  confirmation UI so batching never crosses prior conversation turns. */
  turnId?: string;
  /** Real task-run id (group chat run) when one is active; cognition bound
   *  receipts prefer it over turnId for run-level accounting. */
  taskRunId?: string;
  /** Current real user text, used by tools that must bind an approval action
   * to explicit user intent rather than merely to the existence of a turn. */
  userMessage?: string;
  recallAnswerEvidence?: OntologyAnswerEvidenceBundle;
  sourceMessageId?: string;
  sourceMessageFromUser?: boolean;
  onCognitionSaveReceipt?: (receipt: CognitionSaveReceipt) => void | Promise<void>;
  onAssetUsageClaim?: (claim: import('../../features/recall/asset-usage-claim').AssetUsageClaim) => void | Promise<void>;
  suppliedAbilityAssets?: Array<{ assetId: string; assetVersion: string }>;
  /** Project id of the conversation, when it belongs to one. Threaded
   *  through to local-tools / file-tools / image-gen-tool so workspace
   *  resolution picks up the project-scoped selection. Resolved once at
   *  the top of group_chat::runTurn from `conv.project_id`. */
  projectId?: string;
  /** Space id of the conversation, when it belongs to one. Threaded to
   *  kb-tools so Library retrieval resolves the space-scoped index. */
  spaceId?: string;
  /** Space primary role template; recall scopePolicy.roleIds context. */
  roleId?: string;
  /** Conversation kind; recall scopePolicy.conversationKinds context. */
  conversationKind?: string;
  /** Current-turn attachment kinds; recall scopePolicy.fileKinds context. */
  fileKinds?: string[];
  /** Agent id bound to the conversation. Empty/undefined = default scope. */
  agentId?: string;
  /** Optimistic-lock baseline (file mtimeMs per metacognition target)
   *  captured when the reflection orchestrator read COMPETENCE/STRATEGIES to
   *  build its prompt. The injected metacognition tool falls back
   *  to it when the LLM never read the target itself, so a write based on
   *  the orchestrator's possibly-minutes-old snapshot is refused once the
   *  file changed in between. `0` means "file absent at read time". */
  metacognitionBaselineMtime?: { competence?: number; strategies?: number };
  /** Human-readable actor name used in user-facing local permission prompts. */
  agentName?: string;
  /** Max tool-call rounds per turn before force-end. Undefined → core-agent
   *  default (50). Group chat raises it for the commander's long builds. */
  maxToolLoops?: number;
  /**
   * Hard opt-out of every tool for this turn: no local tools, no file tools,
   * no MCP, no extras. For explain-only callers (see
   * `features/conversation_aside`) that must not be able to touch the
   * filesystem or run commands.
   *
   * `maxToolLoops: 0` does NOT achieve this — it is filtered out as falsy by
   * the option spreads on the way down, so the turn silently keeps the default
   * loop budget and the full tool set.
   */
  disableTools?: boolean;
  /** Restrict tools to a read/search allowlist only. */
  toolAccess?: 'read-only';
  /** Host-selected subset for a bounded task. Intersects, never widens, any
   * creator or read-only policy; an empty list disables every tool. */
  toolAllowlist?: readonly string[];
  /** Provider stream deadline before its first usable text/tool event. This
   * boundary is safe for fallback because no visible output has committed. */
  providerFirstEventTimeoutMs?: number;

  /** Optional subset of skill ids; undefined = full global listing. See
   * `skill-registry.getSystemPromptBlock` for the exact semantics. */
  skillList?: string[];
  /** Project-scope skill allowlist applied ONLY to the System A render
   *  block (`getSystemPromptBlock`). When present, the rendered allowlist
   *  is `intersect(skillList, projectAllowedSkillIds)`; SkillStore (System
   *  B, agent self-evolved skills) stays gated by `skillList` alone so
   *  agents in projects retain access to their own evolved skills. See
   *  `features/projects.ts::resolveProjectScope`. */
  projectAllowedSkillIds?: readonly string[];
  /** User-explicit skill refs selected in the composer. These are rendered
   *  even when they live in open/global skill roots that are normally lazy. */
  forceOpenSkillRefs?: readonly string[];
  /** Extra tools added to core-agent's builtins (e.g. group_chat commander
   * gets dispatch tools (`run_worker` / `dispatch_to`) plus marketplace /
   * skill-search / automation-listing tools). */
  extraTools?: AgentTool[];
  /** Extra absolute directory roots whitelisted for file-tools (read_file /
   *  stat_file / search_files / grep_files) on top of workspace + attachment.
   *  Read AND write are permitted under these roots. Used by per-skill
   *  edit chats to expose the skill dir. */
  extraRoots?: readonly string[];
  /** Read-only extra roots: read tools (read_file / search_files /
   *  grep_files / stat_file) can see them, but write-side tools
   *  (edit_file / write_file / bash / markdown_to_pdf / html_to_pdf /
   *  generate_image and other write-capable tools) cannot mutate paths inside.
   *  Used by group-chat commander to inspect agent / skill specs without
   *  giving direct-write access — the structured `<agent>` / `<skill>`
   *  containers are the only sanctioned mutation channels for those resources. */
  readOnlyExtraRoots?: readonly string[];
  /** Additional file-tool-only read roots. Like `readOnlyExtraRoots`, these
   *  are never passed to localTools, so `delete_file` and other local-exec
   *  tools cannot act on them. Used for user-approved read-only folder grants. */
  fileReadOnlyExtraRoots?: readonly string[];
  /** Fires with the absolute path after each successful `write_file` /
   * `markdown_to_pdf` / `html_to_pdf` call or tracked bash output file. See `model/client.ts`
   * `ChatOptions.onFileWritten` for the caller-facing contract. */
  onFileWritten?: (absPath: string) => void | Promise<void>;
  /** Turn owner validation hook for the `publish_outputs` tool. */
  onOutputsPublished?: (absPaths: string[]) => string[] | Promise<string[]>;
  /** Caller-supplied predicate consumed by write-style tools' uniquify
   *  logic. See `model/client.ts` `ChatOptions.hasProducedPath`. */
  hasProducedPath?: (absPath: string) => boolean;
  /** Fires after each successful `create_artifact` call. See `model/client.ts`
   *  `ChatOptions.onArtifactCreated`. */
  onArtifactCreated?: (a: { id: string; title: string }) => void;
  /** Secondary host callback used only to mirror a validated artifact into an
   * execution record. It never enables create_artifact by itself. */
  onExecutionArtifactCreated?: (a: { id: string; title: string }) => void;
  /** Fires once per skill id rendered into the system-prompt skills index,
   *  with its source system. Called at runner build time (before the LLM
   *  sees the prompt). Bus collects per turn for `skill_advertised`. */
  onSkillAdvertised?: (skill_id: string, system: 'A.custom' | 'A.platform' | 'B') => void;
  /** Fires when `read_file` resolves to a SKILL.md path inside any of the
   *  three skill roots. Bus collects per turn for `skill_invoked`. */
  onSkillInvoked?: (skill_id: string, system: 'A.custom' | 'A.platform' | 'B', trigger: 'read_file') => void;
  /** Fires when the pi-ai onPayload hook injects a vendor native web search
   *  tool schema for this call. Used by client.ts to record a synthetic
   *  `progress/native_search/injected` event into the devtools archive.
   *  May fire multiple times per chat turn if rotating-provider falls over
   *  to a secondary candidate. */
  onNativeSearchInjected?: (info: NativeSearchInjectedInfo) => void;
  /** Fires when rotating-provider commits to a candidate (success) or
   *  surfaces a non-rotatable error (failure). Used by client.ts to update
   *  the dev archive's recorded model / provider / profile so the stored
   *  row reflects the candidate that actually owned the visible outcome,
   *  not the rotating-provider's primary label. Fires at most once per
   *  call; not invoked when rotation rolls past a candidate. */
  onCandidateChosen?: (info: { profileId: string; providerId: string; modelId: string; entryId?: string }) => void;
}

export interface NativeSearchInjectedInfo {
  provider: string;
  model: string;
  api: string;
  tool: string;
}

/** Tool definition snapshot persisted to the dev-only LLM archive so the
 * debug panel can show "what tools did the LLM actually see for this call".
 * Mirrors the AgentTool shape minus the executor closure (which is not
 * serialisable). */
export interface ToolDefSnapshot {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `'core-agent'` = pi-ai builtin (read_file / write_file / bash / web_search / web_fetch / list_files);
   *  `'cogseed'` = injected by buildRunner (overrides + extras like memory, kb, image_gen, web_search override);
   *  `'extra'` = passed by caller via `extraTools` (group_chat commander uses this for dispatch + marketplace / skill / automation tools). */
  source: 'core-agent' | 'cogseed' | 'extra';
}

function splitVolatilePromptTail(prompt: string | undefined): { stable: string; volatileTail: string } {
  const raw = (prompt || '').trim();
  if (!raw) return { stable: '', volatileTail: '' };
  const marker = '\n\n---\n\n## Current date\n';
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) return { stable: raw, volatileTail: '' };
  const stable = raw.slice(0, idx).trim();
  const volatileTail = raw.slice(idx + 2).trim();
  return { stable, volatileTail };
}

function splitCommanderAgentsBlock(prompt: string): { stable: string; agentsBlock: string } {
  const marker = '\n\n### Agents list\n\n';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, agentsBlock: '' };
  const blockStart = idx + 2;
  const nextSection = prompt.slice(blockStart + marker.trimStart().length).search(/\n\n#{2,3} /);
  const blockEnd = nextSection < 0
    ? prompt.length
    : blockStart + marker.trimStart().length + nextSection;
  return {
    stable: `${prompt.slice(0, idx)}${prompt.slice(blockEnd)}`.trim(),
    agentsBlock: prompt.slice(blockStart, blockEnd).trim().replace(/^### Agents list/, '## Agents list'),
  };
}

function splitRuntimeInjectionBlock(prompt: string): { stable: string; runtimeInjectionBlock: string } {
  const marker = '\n\n## Runtime injection';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, runtimeInjectionBlock: '' };
  const blockStart = idx + 2;
  return {
    stable: prompt.slice(0, idx).trim(),
    runtimeInjectionBlock: prompt.slice(blockStart).trim(),
  };
}

/**
 * Peel the commander's `## Orchestration state` section out of the cached
 * prefix. Its body renders the per-turn `orchestration_ledger` JSON (status,
 * updated_at, interrupted_at, …), which changes every commander turn while an
 * agent handoff / form / dispatch pause is live. Left in place — it sits near
 * the TOP of chat_commander.md, far ahead of `## Runtime injection` — any
 * ledger change invalidates the whole Anthropic cache prefix after it (~7-9K
 * tokens re-billed at full input price per turn). Relocating the whole H2
 * section to the volatile region keeps the cached prefix stable and follows
 * the runtime rule that volatile prompt fields belong in one trailing section. The header is already H2 so no heading rewrite is needed.
 */
function splitCommanderOrchestrationBlock(prompt: string): { stable: string; orchestrationBlock: string } {
  const marker = '\n\n## Orchestration state';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, orchestrationBlock: '' };
  const blockStart = idx + 2;
  const nextSection = prompt.slice(blockStart + marker.trimStart().length).search(/\n\n#{2,3} /);
  const blockEnd = nextSection < 0
    ? prompt.length
    : blockStart + marker.trimStart().length + nextSection;
  return {
    stable: `${prompt.slice(0, idx)}${prompt.slice(blockEnd)}`.trim(),
    orchestrationBlock: prompt.slice(blockStart, blockEnd).trim(),
  };
}

/** Exported for unit tests — see runner.test.ts. */
export const _splitCommanderOrchestrationBlock = splitCommanderOrchestrationBlock;

/**
 * 只读会话（`toolAccess: 'read-only'`）的**闭合**工具允许集。
 *
 * 语义是「**无副作用 actor 的最小工具集**」，不是「所有读操作」：
 *   - 这里每一个工具都只读本机文件/网络/库，不写用户数据；
 *   - **资产工具一律不在其中（读与写都不进）**——资产库是用户私有全量数据，
 *     开给从属 actor 属权限扩张；而且资产读取本身就会写注入回执与使用流水
 *     （见 recall-tools 的 agent_read 留痕），根本不是无副作用的。
 *     从属 actor 需要资产时走「任务装配时注入允许切片」，不开全库工具。
 *
 * 导出是为了让不变量可被测试钉住（`asset-steward-tools.test.ts`），不是给
 * 调用方拼装——要加工具请改这里并同步那条测试的判据。
 */
export const READ_ONLY_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'read_file', 'stat_file', 'search_files', 'grep_files', 'list_files',
  'web_search', 'web_fetch', 'kb_list', 'kb_search', 'kb_read',
  'tool_result_search', 'tool_result_read_chunk',
]);

/** 只读会话下保留的 core-agent 内建工具（同样是闭合集）。 */
export const READ_ONLY_BUILTIN_ALLOWLIST: ReadonlySet<string> = new Set([
  'read_file', 'list_files', 'web_fetch', 'web_search',
]);

/**
 * Validate the single root of a trusted reception turn before any session,
 * skill scan or tool factory runs.
 *
 * The tool layer treats an empty/blank `receptionRoot` as "ordinary turn"
 * (absent), so an injected `{ receptionScope: { root: '' } }` used to enter
 * receptionMode for the allowlist/blocklist but fall back to the ordinary
 * workspace for the actual file/shell scope. That is a fail-open: an
 * unprovable scope must never be interpreted as "no scope".
 */
export function assertTrustedReceptionRoot(
  scope: import('../../features/a2a/reception-scope').TrustedReceptionScope,
): string {
  const raw = typeof scope?.root === 'string' ? scope.root.trim() : '';
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error(
      `E_RECEPTION_ROOT_UNAVAILABLE: the trusted reception root must be a non-empty absolute path (${raw || '<empty>'}); refusing instead of falling back to the ordinary workspace.`,
    );
  }
  let st: fs.Stats;
  try { st = fs.statSync(raw); }
  catch (err) {
    throw new Error(
      `E_RECEPTION_ROOT_UNAVAILABLE: the trusted reception root does not exist or is not stat-able (${raw}): ${(err as Error).message}. Refusing; do not retry with another root.`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(
      `E_RECEPTION_ROOT_UNAVAILABLE: the trusted reception root is not a directory (${raw}). Refusing; do not retry with another root.`,
    );
  }
  let canonical: string;
  try { canonical = fs.realpathSync(raw); }
  catch (err) {
    throw new Error(
      `E_RECEPTION_ROOT_UNAVAILABLE: the trusted reception root cannot be canonicalized (${raw}): ${(err as Error).message}. Refusing; do not retry with another root.`,
    );
  }
  // Align with the S2b executor, which refuses a filesystem root as the
  // confirmed scope: `/` would make every file on the volume in-root.
  if (path.parse(canonical).root === canonical) {
    throw new Error(
      `E_RECEPTION_ROOT_UNAVAILABLE: the trusted reception root is the filesystem root (${canonical}), not a bounded workspace; refusing to treat a whole volume as the reception scope.`,
    );
  }
  return canonical;
}

export async function buildRunner(params: BuildRunnerParams): Promise<{
  runner: AgentRunnerInstance;
  resolvedSystemPrompt: string;
  /** Per-turn volatile blocks (orchestration ledger / plan / datetime) peeled
   *  OUT of the system prompt to keep the cache prefix stable; the caller
   *  forwards this as `runStream({ turnEphemeral })` so it rides this turn's
   *  user message instead. Empty for runs with no volatile blocks. */
  turnEphemeral: string;
  entryId?: string;
  profileId?: string;
  providerId: string;
  modelId: string;
  /** Final tool set visible to the LLM (after last-write-wins merge of
   *  core-agent builtins + buildRunner-injected + caller-supplied extras).
   *  Used by the dev-only archiver. */
  toolDefs: ToolDefSnapshot[];
  /** UI-only skill display names collected while rendering the prompt block.
   *  Not injected into model context; reused for process-log labels. */
  skillDisplayNameById: Map<string, string>;
  /** UI-only agent display names collected once before the run.
   *  Not injected into model context; reused for process-log labels. */
  agentDisplayNameById: Map<string, string>;
  /** Last deterministic-failure breaker trip of this run, or `null`. The
   *  breaker ends the turn itself (`endTurn: true`); this accessor is the
   *  reporting half, consulted after `runner.run()` so the turn carries a real
   *  failure kind/code instead of an internal maintenance state. */
  toolFailure: () => {
    kind: string;
    code: string;
    reason: string;
    failures: number;
    tool: string;
  } | null;
  /** Per-turn ontology evidence gate. It remains inactive until a tool reads
   *  governed asset content or returns a persisted ontology relation. */
  finalResponseGate?: import('./recall-tools').RecallFinalResponseGate;
}> {
  assertUtilityResponseFormat(params);
  if (params.maxOutputTokens !== undefined
    && (!Number.isSafeInteger(params.maxOutputTokens) || params.maxOutputTokens <= 0)) {
    throw new Error('maxOutputTokens must be a positive integer');
  }
  // Fail closed before auth/session/tool work: a malformed reception scope must
  // never be treated as "ordinary local turn" by the tool layer (see
  // assertTrustedReceptionRoot).
  const receptionMode = !!params.receptionScope;
  const receptionRoot = receptionMode ? assertTrustedReceptionRoot(params.receptionScope!) : '';
  const earlyUid = params.userId || _safeActiveUserId();
  let creatorExecution: ReturnType<typeof creatorRuntimeExecutionOptions> | null = null;
  if (params.agentId) await assertAgentChatDispatchable(
    earlyUid || '',
    params.agentId,
  );
  if (params.agentId) {
    const dispatchPolicy = await getAgentDispatchPolicy(earlyUid || '', params.agentId);
    if (!isAgentChatDispatchable(dispatchPolicy)) {
      await assertAgentChatDispatchable(earlyUid || '', params.agentId);
    }
    if (dispatchPolicy?.creator_runtime) {
      creatorExecution = creatorRuntimeExecutionOptions(dispatchPolicy.creator_runtime);
    }
  }

  const outputCaps = [params.maxOutputTokens, creatorExecution?.maxOutputTokens]
    .filter((value): value is number => typeof value === 'number');
  const maxOutputTokensCeiling = outputCaps.length ? Math.min(...outputCaps) : undefined;

  // Auth gate first — if no group has any usable candidate, fail before
  // loading core-agent / scanning skills / opening a session file. Gives
  // a clear user message instead of the Anthropic SDK's "Could not
  // resolve authentication method".
  // Per-task override (unified execution entry): narrow the group to the
  // requested provider with its model replaced. A provider with no usable
  // entry (credentials removed, cooled down) falls back to the default
  // priority group rather than failing the turn — the runtime resolution
  // callback then reports what actually ran, keeping the UI honest.
  const explicitRoute = !!params.modelCandidates?.length;
  let group = explicitRoute
    ? earlyUid
      ? await pickChatEntryGroupForModelCandidatesForUser(earlyUid, params.modelCandidates!)
      : await pickChatEntryGroupForModelCandidates(params.modelCandidates!)
    : earlyUid ? await pickChatEntryGroupForUser(earlyUid) : await pickChatEntryGroup();
  if (explicitRoute && !group.length) throw Object.assign(new Error(t('errors.model_config_unavailable')), { code: 'PROVIDER_AUTH_EXHAUSTED' });
  if (!explicitRoute && params.modelOverride) {
    try {
      const overridden = earlyUid
        ? await pickChatEntryGroupForModelOverrideForUser(earlyUid, params.modelOverride)
        : await pickChatEntryGroupForModelOverride(params.modelOverride);
      if (overridden && overridden.length) {
        group = overridden;
        log.info(`model override applied provider=${params.modelOverride.provider} model=${params.modelOverride.model}`);
      } else {
        log.warn(`model override ignored (no usable entry) provider=${params.modelOverride.provider} — falling back to default group`);
      }
    } catch (err) {
      log.warn(`model override resolution failed — falling back to default group: ${(err as Error).message}`);
    }
  }
  const primary: ChatEntryChoice | undefined = group[0];
  if (!primary && !process.env.ANTHROPIC_API_KEY) {
    const oauthExpiredMessage = earlyUid
      ? getConfiguredModelOAuthExpiredMessageForUser(earlyUid)
      : getConfiguredModelOAuthExpiredMessage();
    if (oauthExpiredMessage) throw new Error(oauthExpiredMessage);
    const cooldown = earlyUid ? getConfiguredModelCooldownForUser(earlyUid) : getConfiguredModelCooldown();
    if (cooldown) {
      const seconds = Math.max(1, Math.ceil((cooldown.cooledUntil - Date.now()) / 1000));
      throw new Error(t('errors.model_temporarily_unavailable', { seconds }));
    }
    if ((earlyUid ? hasConfiguredModelForUser(earlyUid) : hasConfiguredModel()).configured) {
      throw new Error(t('errors.model_config_unavailable'));
    }
    throw new Error(t('errors.no_model_configured'));
  }

  // Per-user disabled-skill set; passed into getSystemPromptBlock so the
  // rendered `## Available skills` block excludes user-disabled skills regardless
  // of agent-level allowlist. Resolved off the active uid; session_id no longer
  // carries the uid, so callers that don't pass `params.userId`
  // fall through to the active-user singleton. Wrapped in a try/catch so ad-hoc
  // test paths that activate no user just see a null uid → empty disabled set.
  const disabledSkillIds = earlyUid ? readDisabledSets(earlyUid).skills : new Set<string>();

  // System A render allowlist = intersect(skillList, project bindings).
  //   - no project scope (`projectAllowedSkillIds` undefined) → legacy
  //     `skillList`-only behavior
  //   - commander in a project (`skillList` undefined, project list set) →
  //     project list governs the render block
  //   - agent in a project (both set) → intersection
  // SkillStore (System B) stays gated by `skillList` alone — see line ~429.
  const renderAllowlist = _intersectRenderAllowlist(params.skillList, params.projectAllowedSkillIds);
  const skillDisplayNameById = new Map<string, string>();
  const systemSkillsVisible = systemSkillsExposureFromSessionId(params.sessionId);
  const agentBuiltinNames = openBuiltinNamesOf(params.skillList);
  const openSkillSourcesVisible = openSkillSourcesExposureFromSessionId(params.sessionId);
  const modPromise = ca();
  const sessionPromise = params.receptionScope
    // Trusted external reception: never open the local resumable session (it
    // also holds the receiver's private turns). Rebuild only the host-projected
    // allowed peer history in memory; the current turn appends after it, so
    // continuity survives restarts without exposing local context.
    ? (async () => {
        const loaded = await modPromise;
        const session = new loaded.Session();
        if (params.receptionHistory?.length) {
          const { replayReceptionHistory } = await import('../../features/a2a/reception-context');
          replayReceptionHistory(session, params.receptionHistory);
        }
        return session;
      })()
    : params.ephemeralSession
      ? modPromise.then((loaded) => new loaded.Session())
      : getSession(params.sessionId);
  const [mod, session, systemSkillsBlock, skillsBlock] = await Promise.all([
    modPromise,
    sessionPromise,
    systemSkillsVisible
      ? getSystemSkillsPromptBlock(earlyUid || undefined)
      // Sessions that do not see every system skill still get the built-in capabilities this
      // agent's skill_list names (`builtin:<name>`), limited to the ones the client offers.
      : agentBuiltinNames.length
        ? getSystemSkillsPromptBlock(earlyUid || undefined, { only: agentBuiltinNames })
        : Promise.resolve(''),
    getSystemPromptBlock({
      ...(earlyUid ? { userId: earlyUid } : {}),
      ...(renderAllowlist === undefined ? {} : { allowlist: [...renderAllowlist] }),
      disabledIds: disabledSkillIds,
      // Acting agent id gates agent-private (`ownerAgent`) skills: an agent's
      // own internal skills render for it, but never for the commander or
      // other agents. Empty for commander/non-agent sessions.
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.onSkillAdvertised ? { onSkillAdvertised: params.onSkillAdvertised } : {}),
      displayNameById: skillDisplayNameById,
      ...(openSkillSourcesVisible ? { includeOpenSources: true } : {}),
      ...(params.forceOpenSkillRefs?.length ? { forceOpenSkillRefs: [...params.forceOpenSkillRefs] } : {}),
    }),
  ]);

  const providerId = primary?.provider || 'anthropic';
  const modelId    = primary?.model    || 'claude-opus-4-8';

  // Build tools array: memory tool + metacognition tool. Assembly stays
  // above the system-prompt build because finalToolNames is still snapshotted
  // for the dev archive after this section.
  const uid = earlyUid;
  const agentId = params.agentId || '';
  // Cross-session memory eligibility + per-agent scope (null = not eligible →
  // no tool, no injection). See memoryScopeForSession for the per-kind rule.
  // A trusted external reception turn is never memory-eligible: the tool,
  // space instructions, memory block, role portrait and project
  // context/instructions gated on this scope are receiver-private host context
  // and must not reach an A2A visitor. The metacognition tool is NOT gated on
  // this scope (it is per-agent self-evolution, available to edit/one-shot
  // sessions too) — it is closed separately below and, at the tool surface, by
  // the reception allowlist in this file.
  const memoryAgentScope = params.receptionScope
    ? null
    : memoryScopeForSession(params.sessionId, agentId);
  // The commander (the project's orchestrator conversation, `gconv`) owns the
  // two project-wide stores: it may WRITE project instructions (COGSEED.md, via
  // the `project_instructions` tool) and project memory. Dispatched sub-agents
  // (gmember / gworker / cli) get read-only access to both. Derived from the
  // immutable session id, so it can't drift mid-session.
  const isCommander = sessionKindOf(params.sessionId) === 'gconv';
  const agentDisplayNameById = new Map<string, string>();
  if (uid) {
    try {
      for (const agent of await listAgentSummariesForUser(uid)) {
        if (agent?.agent_id) agentDisplayNameById.set(agent.agent_id, agent.name || agent.agent_id);
      }
    } catch (err) {
      log.warn('agent display-name scan failed', { user_id: maskId(uid), error: logErrorSummary(err) });
    }
  }
  const agentName = (params.agentName || (agentId ? agentDisplayNameById.get(agentId) : '') || agentId || '').trim();
  const injectedTools: AgentTool[] = [];

  const recordHistoryResource = (resource: HistoryResource) => {
    try {
      session.addHistoryResource(resource);
    } catch (err) {
      log.warn('history resource registration failed', {
        session_id: maskId(params.sessionId),
        kind: resource.kind,
        error: logErrorSummary(err),
      });
    }
  };
  const onArtifactCreatedForHistory = params.onArtifactCreated
    ? (a: { id: string; title: string }) => {
        try {
          params.onArtifactCreated!(a);
        } finally {
          try { params.onExecutionArtifactCreated?.(a); }
          catch (err) {
            log.warn('execution artifact callback failed', {
              artifact_id: maskId(a.id),
              error: logErrorSummary(err),
            });
          }
          if (uid && params.cid) {
            recordHistoryResource({
              kind: 'final_output',
              path: path.join(artifactDirForConversation(uid, params.cid, a.id), 'index.html'),
              name: a.title || a.id,
              note: 'Interactive app artifact entry point.',
            });
          }
        }
      }
    : undefined;

  if (uid && memoryAgentScope) {
    // Cross-session memory. `agent` tier binds to THIS caller's scope and
    // `space` to THIS conversation's space, so the model can never reach
    // another agent's or space's store; `shared`/`user` are global. The
    // `space` tier exists only in space sessions — outside a space it is
    // absent from the tool schema entirely (see memory-tool.ts).
    const scopeId = memoryAgentScope; // narrowed to string
    const spaceScopeId = params.spaceId || '';
    const legacyProjectScopeId = params.projectId || '';
    const memoryAssetContext = {
      ...(agentId ? { agentId } : {}),
      ...(legacyProjectScopeId ? { projectId: legacyProjectScopeId } : {}),
      ...(spaceScopeId ? { workspaceId: spaceScopeId } : {}),
      ...(params.userMessage ? { taskText: params.userMessage } : {}),
    };
    const toScope = (tier: 'agent' | 'space' | 'shared' | 'user'): MemoryScope =>
      tier === 'agent' ? { agent: scopeId }
      : tier === 'space' ? { space: spaceScopeId }
      : tier === 'shared' ? 'memory' : 'user';
    const assetTarget = (tier: 'agent' | 'space' | 'shared' | 'user') => tier === 'agent'
      ? { kind: 'agent' as const, id: scopeId }
      : tier === 'space'
        ? { kind: 'space' as const, id: spaceScopeId }
        : { kind: 'global' as const };
    const memoryHandler: MemoryToolHandler = {
      list: async (tier) => {
        const legacy = tier === 'space'
          ? listSpaceEntriesWithProjectFallback(uid, spaceScopeId, legacyProjectScopeId)
          : listEntries(uid, toScope(tier));
        const { listCrossSessionMemoryAssets } = await import('../../features/recall/cross-session-memory-assets');
        const assets = await listCrossSessionMemoryAssets(uid, memoryAssetContext, assetTarget(tier));
        return {
          ...assets,
          ok: assets.ok && legacy.ok,
          ...(assets.ok && legacy.ok ? {} : { error: assets.error || legacy.error || 'The memory inventory is incomplete.' }),
          ...(legacy.legacySource ? { legacySource: legacy.legacySource } : {}),
          legacyEntryCount: legacy.entries.length,
          entries: [...assets.entries, ...legacy.entries],
        };
      },
    };
    const { createCrossSessionMemoryTool } = await import('../../../core-agent/src/tools/memory-tool');
    // Every actor reads existing memory only; no chat-time formation path.
    injectedTools.push(createCrossSessionMemoryTool(memoryHandler, {
      includeProjectTier: !!spaceScopeId,
    }));
  }

  if (uid && memoryAgentScope && params.spaceId) {
    const sid = params.spaceId;

    // Space instructions: the space's goal + rules. Commander writes;
    // sub-agents read it from their system prompt but don't get this
    // tool. Injected for the commander only, so there is no other write path.
    if (isCommander) {
      const { createProjectInstructionsTool } = await import('../../../core-agent/src/tools/project-instructions-tool');
      injectedTools.push(createProjectInstructionsTool({
        set: async (instructions: string) => {
          const r = await writeSpaceInstructions(uid, sid, instructions);
          return r.ok ? { ok: true } : { ok: false, error: (r as { error: string }).error };
        },
      }));
    }
  }

  // Metacognition tool (per-agent, only if enabled via env var). A trusted
  // external reception turn gets no metacognition lane at all: its store
  // (`COMPETENCE.md` / `LEARNING_STRATEGIES.md`) is receiver-private, and S1
  // must not rely on another package's tool blacklist for that boundary. The
  // reception allowlist below also omits the name (defense in depth).
  if (isMetacognitionEnabled() && !params.receptionScope) {
    // Optimistic locking: each read captures the file's mtime as the
    // write baseline (0 = file absent at read time), and every write whose
    // baseline no longer matches is rejected instead of silently clobbering
    // a concurrent write (e.g. a user lesson saved in chat while a
    // multi-minute background reflection was running). When this session
    // never read a target, the orchestrator-supplied baseline
    // (`params.metacognitionBaselineMtime`) applies; a target with neither
    // keeps the legacy last-writer-wins behavior.
    const readBaseline = new Map<'competence' | 'strategies', number>();
    const baselineFor = (t: 'competence' | 'strategies'): number | undefined =>
      readBaseline.has(t) ? readBaseline.get(t) : params.metacognitionBaselineMtime?.[t];
    // The store path resolves through the *global* active user, so
    // a user switch after this runner was built would read/write another
    // user's self-assessment. Refuse both sides when they disagree.
    const activeUserSwitched = (): boolean => {
      if (!uid) return false;
      const active = _safeActiveUserId();
      return active !== null && active !== uid;
    };
    const metaHandler: MetacognitionToolHandler = {
      read: (target) => {
        if (activeUserSwitched()) {
          return {
            ok: false, content: '',
            error: 'active user changed since this session started; metacognition store unavailable',
            usage: { current: 0, limit: 0 },
          };
        }
        const r = metacognition.readContent(agentId, target);
        readBaseline.set(target, r.mtimeMs ?? 0);
        return r;
      },
      write: (target, content) => {
        if (activeUserSwitched()) {
          return {
            ok: false,
            error: 'active user changed since this session started; write rejected',
            usage: { current: 0, limit: 0 },
          };
        }
        const baseline = baselineFor(target);
        const r = baseline === undefined
          ? metacognition.writeContent(agentId, target, content)
          : metacognition.writeContent(agentId, target, content, { expectedMtimeMs: baseline });
        if (r.ok) readBaseline.set(target, r.mtimeMs ?? 0);
        return r;
      },
    };
    const { createMetacognitionTool } = await import('../../../core-agent/src/tools/metacognition-tool');
    injectedTools.push(createMetacognitionTool(metaHandler, {
      competence: metacognition.COMPETENCE_CHAR_LIMIT,
      strategies: metacognition.STRATEGIES_CHAR_LIMIT,
    }));
  }

  // Local-machine tools: bash / write_file overrides (permission-gated) +
  // markdown_to_pdf / html_to_pdf. These MUST come after core-agent's
  // builtins in the list so `AgentRunner`'s last-write-wins tool map
  // overrides `bash` and `write_file` with the permission-gated versions.
  const systemSkillReadRoots = uid ? [userSystemSkillsDir(uid)] : [];
  const agentPrivateSkillReadRoots = uid && agentId
    ? [
      userMarketplaceAgentSkillsDir(uid, agentId),
      agentPrivateSkillsDir(uid, agentId),
      agentEvolvedSkillsDir(uid, agentId),
    ]
    : [];
  const fileReadOnlyExtraRoots = creatorExecution
    ? []
    : [
      ...(params.fileReadOnlyExtraRoots || []),
      ...(params.readOnlyExtraRoots || []),
      ...systemSkillReadRoots,
      ...agentPrivateSkillReadRoots,
    ];
  // Application-internal spill of oversized tool results. It stays in the
  // machine-local session directory on every turn (including reception): the
  // write is host-owned bookkeeping, not a model capability. A reception turn
  // closes the read side instead — no tool_result_* factory, no spill root in
  // file-tools, and the single root R excludes local/ — so the model can never
  // name or read a spilled result. Recorded as an accepted exception in
  // s2-round2.md (P2-3), not claimed as "zero writes outside R".
  const toolResultsDir = uid && !params.disableTools
    ? toolResultsDirForSession(uid, params.sessionId)
    : '';
  // Trusted inbound A2A reception: the host froze one root for the turn. The
  // tool assembly may only narrow around it — never add the ordinary workspace,
  // attachment, extra-root, read-only, spill or allow-all lanes.
  if (receptionMode && !uid) {
    throw new Error('E_RECEPTION_ROOT_UNAVAILABLE: a trusted reception scope requires a user-scoped tool set; refusing to build unguarded builtins.');
  }
  const localReadOnlyDenyRoots = [
    ...fileReadOnlyExtraRoots,
    ...(toolResultsDir ? [toolResultsDir] : []),
  ];

  const ontologyActionPreflight = uid ? async (toolName: string, input: Record<string, unknown>, finalMarkdownAdapter = false, trustedImplementation = true): Promise<ToolResult | undefined> => {
    const { ontologyActionCapability } = await import('../../features/cognition/ontology/ontology-action-capabilities');
    const capability = ontologyActionCapability(toolName, input, { finalMarkdownAdapter, trustedImplementation });
    if (capability.coverage !== 'unverified_effect') return undefined;
    try {
      const { checkOntologyUnverifiedAction } = await import('../../features/cognition/ontology/operation-guard');
      const result = await checkOntologyUnverifiedAction(uid, { operationKinds: capability.operationKinds, context: {
        ...(agentId ? { agentId } : {}), ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.spaceId ? { workspaceId: params.spaceId } : {}), ...(params.userMessage ? { taskText: params.userMessage } : {}),
      } });
      if (result.allowed) return undefined;
      return { content: JSON.stringify({ code: result.code, checks: result.checks,
        instruction: 'A bound required condition has no verified adapter for this action. Use a structured tool that can check its final payload, or request an explicit review of the unresolved condition.' }), isError: true };
    } catch {
      return { content: 'E_ONTOLOGY_OPERATION_PRECONDITION_UNAVAILABLE: The current bound conditions could not be checked. Do not execute or route around this action.', isError: true };
    }
  } : undefined;

  const localTools = params.disableTools ? [] : createLocalTools({
    ...(uid ? { userId: uid } : {}),
    ...(ontologyActionPreflight ? { beforeUnverifiedAction: ontologyActionPreflight } : {}),
    ...(uid ? { beforeMarkdownWrite: async input => {
      const { checkOntologyMarkdownWrite } = await import('../../features/cognition/ontology/operation-guard');
      return checkOntologyMarkdownWrite(uid, { ...input, context: {
        ...(agentId ? { agentId } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.spaceId ? { workspaceId: params.spaceId } : {}),
        ...(params.userMessage ? { taskText: params.userMessage } : {}),
      } });
    } } : {}),
    ...(params.cid ? { cid: params.cid } : {}),
    // Trusted reception: the single frozen root replaces every ordinary root
    // union below; the tool layer refuses anything outside it. `receptionRoot`
    // was validated/canonicalised at the top of buildRunner.
    ...(receptionMode ? { receptionRoot } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.beforeWriteApproval ? { beforeWriteApproval: params.beforeWriteApproval } : {}),
    ...(params.beforeShellApproval ? { beforeShellApproval: params.beforeShellApproval } : {}),
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(!receptionMode && !creatorExecution && params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
    // Read-only roots intentionally stay out of localTools. `delete_file`,
    // `write_file`, PDF tools, and bash-adjacent local execution only get the
    // writable lane (`extraRoots`), while read-only roots are visible through
    // fileTools below.
    ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
    ...(params.onOutputsPublished ? { onOutputsPublished: params.onOutputsPublished } : {}),
    ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
    ...(onArtifactCreatedForHistory ? { onArtifactCreated: onArtifactCreatedForHistory } : {}),
  });

  // File-scoped tools (read_file override + search_files + grep_files).
  // Same last-write-wins rule — placed after localTools so `read_file` wins
  // over core-agent's builtin `read_file`. Skipped when uid is unknown
  // (e.g. ad-hoc test runs) since file-tools need it for cache scoping.
  // `readOnlyExtraRoots` is threaded here for the read scope (workspace +
  // attachment + extraRoots + readOnlyExtraRoots all visible). Local write
  // and delete tools never receive those roots.
  const fileTools = uid && !params.disableTools
    ? createFileTools({
        userId: uid,
        ...(creatorExecution ? { workspaceOnly: true } : {}),
        ...(params.cid ? { cid: params.cid } : {}),
        ...(receptionMode ? { receptionRoot } : {}),
        ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
        ...(agentId ? { agentId } : {}),
        ...(agentName ? { agentName } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(!receptionMode && !creatorExecution && params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
        ...(!receptionMode && (fileReadOnlyExtraRoots.length || toolResultsDir)
          ? { readOnlyExtraRoots: [...fileReadOnlyExtraRoots, ...(toolResultsDir ? [toolResultsDir] : [])] }
          : {}),
        ...(!receptionMode && toolResultsDir ? { toolResultsRoot: toolResultsDir } : {}),
        ...(params.onSkillInvoked ? { onSkillInvoked: params.onSkillInvoked } : {}),
      })
    : [];

  // Persisted oversized outputs have their own capability boundary. The model
  // receives opaque refs and can only search or read bounded cursor chunks;
  // generic read_file is explicitly denied for this root below.
  const toolResultTools = !receptionMode && toolResultsDir ? createToolResultTools({ toolResultsDir }) : [];

  // Library tools (kb_list + kb_search + kb_read). Read-only, no localExec
  // required. Injected for every main conv + group_chat actor; agent-edit
  // / skill-edit sessions also get them (the LLM may want to preview KB
  // content when building workflows). Skipped when uid is unknown
  // (matches file-tools).
  // A trusted reception turn keeps the contract's explicitly authorized KB but
  // narrows it to Library semantics: `libraryOnly` rejects the attachment
  // source and drops conversation attachments/space artifacts from the
  // material search/list lanes (they live outside the single root R).
  const kbTools = uid && !params.disableTools ? createKbTools({
    userId: uid,
    ...(params.spaceId ? { spaceId: params.spaceId } : {}),
    ...(params.cid ? { cid: params.cid } : {}),
    ...(receptionMode ? { libraryOnly: true } : {}),
  }) : [];

  // 转写纠错词表工具（transcript_glossary_scan / apply / upsert / list）。
  // 会议工作流的一环：取到腾讯会议转写后先纠错，再生成纪要。
  // 纠错引擎在 features/transcript_* 里早已存在，此前只经 ipc/transcript.ts
  // 暴露给纠错面板（人点的），agent 调不到——这组工具是它唯一的 agent 入口。
  // 与 kb-tools 同约定：uid 未知或工具被禁用时不注入。
  const transcriptGlossaryTools = uid && !params.disableTools
    ? createTranscriptGlossaryTools({
      userId: uid,
      ...(params.cid ? { cid: params.cid } : {}),
      ...(params.turnId ? { turnId: params.turnId } : {}),
    })
    : [];

  // Recall ability-asset tools (search_ability_assets: 目录 / 取正文 / 语义检索).
  // Read-only, no localExec required. Injected for every main conv + group_chat
  // actor so the LLM can actively consult the authorized global asset pool.
  // 模型自己取用的资产要写 agent_read 注入回执
  // 与使用流水（turnId），并以当前消息文本做适用/禁用场景匹配（taskText）。
  const recallRoleId = params.roleId
    || (uid && params.spaceId ? await readSpacePrimaryTemplateId(uid, params.spaceId) : undefined);
  // A trusted reception turn gets none of the receiver-private read lanes below
  // (asset bodies, task experiences, personal ontology, cognition/transcript
  // queries). The contract exempts only the explicitly authorized Library KB, so
  // every other private read surface is closed here and again by name below.
  const recallToolSuite = uid && !params.disableTools && !receptionMode ? createRecallToolSuite({
    userId: uid,
    ...(params.onAssetUsageClaim ? { onAssetUsageClaim: params.onAssetUsageClaim } : {}),
    ...(params.suppliedAbilityAssets ? { suppliedAbilityAssets: params.suppliedAbilityAssets } : {}),
    ...(agentId ? { agentId } : {}),
    ...(recallRoleId ? { roleId: recallRoleId } : {}),
    ...(params.conversationKind ? { conversationKind: params.conversationKind } : {}),
    ...(params.fileKinds?.length ? { fileKinds: params.fileKinds } : {}),
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(params.cid ? { cid: params.cid } : {}),
    ...(params.spaceId ? { spaceId: params.spaceId } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.userMessage ? { taskText: params.userMessage } : {}),
    ...(params.recallAnswerEvidence ? { initialEvidence: params.recallAnswerEvidence } : {}),
  }) : undefined;
  const recallTools = recallToolSuite?.tools || [];

  // 资产管家工具：全量浏览、读全文、按用户指令改动。
  // 与 search_ability_assets 分开：那是任务执行期的取用（写 agent_read 回执与
  // 使用流水），这是管理视角（看全貌、改内容），读也不该记成"任务用了它"。
  // 同样注入给主会话与 group_chat 各 actor，且**不进只读白名单**（见下）。
  const assetStewardTools = uid && !params.disableTools && !receptionMode ? createAssetStewardTools({
    userId: uid,
    ...(agentId ? { agentId } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(params.cid ? { cid: params.cid } : {}),
    ...(params.spaceId ? { spaceId: params.spaceId } : {}),
    ...(params.userMessage ? { taskText: params.userMessage } : {}),
    sourceMessageFromUser: params.sourceMessageFromUser === true,
    sourceMessageId: params.sourceMessageId,
  }) : [];

  // 任务经验目录工具：list_task_experiences +
  // read_task_experience，2 读 0 写、无 localExec。与上面两族（资产取用/资产
  // 管家）分属两套集合（exp- vs aa-，完全隔离），但注入条件同源：主会话与
  // group_chat 各 actor 都拿到，读正文写 agent_read 回执与使用流水（turnId）、
  // 以当前消息做准入匹配（taskText）。同样**不进只读白名单**（见上）。
  const experienceTools = uid && !params.disableTools && !receptionMode ? createExperienceTools({
    userId: uid,
    ...(agentId ? { agentId } : {}),
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(params.cid ? { cid: params.cid } : {}),
    ...(params.spaceId ? { spaceId: params.spaceId } : {}),
    ...(params.userMessage ? { taskText: params.userMessage } : {}),
  }) : [];

  // Legacy personal-ontology template field lookup. Task ontology reads use the
  // scope-filtered cognition_ontology_query registered with cognition-kernel tools.
  const personalOntologyTools = uid && !params.disableTools && !receptionMode ? createPersonalOntologyTools({
    userId: uid,
  }) : [];

  // 任务字段读取与缺口检查；对话答案仅用于当前任务。 A trusted reception turn
  // closes this whole kernel (personal_fields_check / transcript_corrections_query
  // / cognition_ontology_query read receiver-private ontology + transcripts).
  const cognitionKernelTools = uid && !params.disableTools && !receptionMode ? createCognitionKernelTools({
    userId: uid,
    sourceMessageId: params.sourceMessageId, sourceMessageFromUser: params.sourceMessageFromUser, taskText: params.userMessage,
    allowTranscriptRead: isCommander,
    turnId: params.turnId, cid: params.cid, spaceId: params.spaceId,
    ...(params.taskRunId ? { taskRunId: params.taskRunId } : {}),
    context: { agentId, workspaceId: params.spaceId, projectId: params.projectId, taskText: params.userMessage },
  }) : [];

  // Meeting ontology tools (ontology_graph_read / ontology_projection_apply).
  // Same names and behaviour as the Runtime host tools: an Agent's follow-up
  // turns run here, so confirmation-time projection must not depend on which
  // execution path the turn landed on.
  const meetingOntologyTools = uid && !params.disableTools && !creatorExecution ? createMeetingOntologyTools({
    userId: uid,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.cid ? { cid: params.cid } : {}),
    ...(params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
    ...(params.readOnlyExtraRoots?.length ? { readOnlyExtraRoots: params.readOnlyExtraRoots } : {}),
  }) : [];

  // Conversation-history tools (chat_search + chat_read). Commander-only:
  // agent workers receive the material they need through their visibility
  // slice / dispatcher payload and must never browse full conversation logs.
  // Project commanders search their own project by default; Library remains
  // authoritative for durable document facts.
  const chatHistoryTools = uid && isCommander && !receptionMode ? createChatHistoryTools({
    userId: uid,
    ...(params.cid ? { currentCid: params.cid } : {}),
    ...(params.spaceId ? { spaceId: params.spaceId } : {}),
  }) : [];

  // Proactive Feishu/Lark messaging (Commander-only). The tools resolve the
  // configured owner, ask the user for one-time confirmation, and send through
  // the shared messaging service; workers / edit sessions / CLI / reflection
  // never get them. A cid is required to route the confirmation dialog and
  // derive the stable per-turn source key.
  const messagingTools: AgentTool[] = uid && !params.disableTools && !receptionMode && isCommander && params.cid
    ? createMessagingTools({
        userId: uid,
        ...(ontologyActionPreflight ? { beforeAction: ontologyActionPreflight } : {}),
        cid: params.cid,
        ...(params.turnId ? { turnId: params.turnId } : {}),
      })
    : [];

  // P3394 agent interop (Commander-only): the CogSeed agent itself calls
  // registered peers through the built-in bridge.
  const p3394Tools: AgentTool[] = uid && !params.disableTools && !receptionMode && isCommander && params.cid
    ? createP3394Tools({
        userId: uid,
        cid: params.cid,
        ...(params.turnId ? { turnId: params.turnId } : {}),
      })
    : [];

  // Feishu touchpoint tools (status/briefing/touchpoint records + file send).
  // Same Commander-only gate as messaging tools: workers, edit sessions, CLI
  // and reflection never get them, so they cannot read or mutate user Feishu
  // configuration from a narrower session.
  const feishuTools: AgentTool[] = uid && !params.disableTools && !receptionMode && isCommander
    ? createFeishuTools({
        userId: uid,
        ...(ontologyActionPreflight ? { beforeAction: ontologyActionPreflight } : {}),
        ...(params.cid ? { cid: params.cid } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(!receptionMode && !creatorExecution && params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
      })
    : [];

  // Media generation. Shares the localExec access mode with
  // local-tools (writing image bytes is the same blast radius as write_file).
  // Skipped when uid is unknown — generators need the
  // workspace + attachment scope to validate paths.
  const imageGenTools: AgentTool[] = uid && !params.disableTools && !receptionMode
    ? [createImageGenTool({
        userId: uid,
        ...(params.cid ? { cid: params.cid } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(agentName ? { agentName } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
        ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
      })]
    : [];
  // Deep-research-owned tools (ownerAgent gate). Pure local compute (embedding
  // + ranking), so no uid / workspace scope and no Tool Execution Access needed;
  // hidden from the commander and every other actor via isToolVisibleToAgent.
  const deepResearchTools: AgentTool[] = [];
  if (!params.disableTools && isToolVisibleToAgent('research_rerank', agentId)) {
    deepResearchTools.push(createResearchRerankTool());
  }

  // Office document tools (bundled OfficeCLI engine). Permission-gated like
  // local-tools (writing a docx/xlsx/pptx is the same blast radius as
  // write_file). Skipped when uid is unknown — the factory needs the
  // workspace + attachment scope to sandbox output paths.
  const officeTools: AgentTool[] = uid && !params.disableTools && !receptionMode && officeCliAvailable()
    ? createOfficeTools({
        userId: uid,
        ...(ontologyActionPreflight ? { beforeAction: ontologyActionPreflight } : {}),
        ...(params.cid ? { cid: params.cid } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(!receptionMode && !creatorExecution && params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
        ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
        ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
      })
    : [];

  // `web_search` override — last-write-wins replacement for core-agent's
  // built-in keyless web_search. Routes to a paid search API when the user
  // has any `searchProfiles` configured; otherwise delegates back to the
  // built-in Brave/Bing scraper. See `model/core-agent/search-tools.ts`.
  // Async because the factory pulls `defineTool` / `runBuiltinWebSearch`
  // off the ESM core-agent dynamic import.
  const searchOverrideTools: AgentTool[] = params.disableTools || receptionMode ? [] : [await createWebSearchOverrideTool()];

  // Connector meta-tools + system-prompt block (MCP-based, umbrella pattern). When ≥1
  // connector is visible to this actor we inject the two meta-tools (`list_connector_tools` /
  // `call_connector_tool`) plus a `## Connectors` block enumerating the connectors directly in
  // the system prompt — the model sees the catalog without a discovery round-trip, and the
  // block sits in the cached prefix. When 0 visible: zero tools, no block. Per-connector MCP
  // actions are NEVER injected into `tools[]` — the model discovers and invokes them through
  // the meta-tools (umbrella pattern); flat-injecting would balloon `tools[]` past the 20–50
  // selection-accuracy cliff and invalidate the prompt-cache prefix on every connect/disconnect.
  //
  // Session-kind gate (tri-state):
  //   - `gconv` (commander) + `gmember` (agent worker)    → block + full tools (list + call —
  //                                                         actual user tasks invoking external
  //                                                         services).
  //   - `agent` (agent-edit)                              → block + discover-only tool
  //                                                         (`list_connector_tools`). Editor
  //                                                         LLM reads action names + JSON
  //                                                         schemas so the authored workflow
  //                                                         can write "use gmail's `send_email`
  //                                                         with body=..." rather than the
  //                                                         coarse "use gmail to send email".
  //                                                         `call_connector_tool` is withheld
  //                                                         so an authoring session can never
  //                                                         produce external side effects.
  //   - everything else (skill-edit / KB-image / CLI dispatch / reflect / memory-extract /
  //     anon)                                            → none.
  // 连接器可见性按 actor 收窄：
  //   - agent 未声明 `enabled_connectors` → 继承 commander（存量行为不变，传 undefined）；
  //   - agent 声明了（哪怕是 `[]`）→ 只暴露白名单内的实例，这是"配置 MCP 访问权限"的落点。
  // Agent-edit（`agent-` 会话）仍然绕过白名单：编辑期要能看到全部已装连接器才能写出
  // 正确的 workflow 步骤，且该会话拿不到 `call_connector_tool`，不会产生副作用。
  // Group-chat agents intentionally share the commander's connector visibility:
  // do not pass agentId here. A trusted reception turn has no connector/network lane
  // at all, so its exposure stays 'none'.
  const exposure = uid && !params.disableTools && !receptionMode ? connectorExposureFromSessionId(params.sessionId) : 'none';
  const declaredConnectors = uid && agentId && exposure === 'tools+block'
    ? await connectorAllowlistForAgent(uid, agentId)
    : undefined;
  const blockAgentId = undefined;
  // A trusted reception turn has no connector/network lane (policy
  // network/connectors = none), so it gets neither the prompt block nor the
  // meta-tools that could dispatch an MCP action.
  const connectorBlock = exposure !== 'none' && uid
    ? await getConnectorPromptBlock(uid, blockAgentId, declaredConnectors)
    : '';
  const connectorMetaTools = uid && exposure !== 'none'
    ? await createConnectorMetaTools(
        {
          userId: uid,
          ...(ontologyActionPreflight ? { beforeConnectorDispatch: (input: Record<string, unknown>) => ontologyActionPreflight('call_connector_tool', input) } : {}),
          ...(params.cid ? { cid: params.cid } : {}),
          ...(declaredConnectors !== undefined ? { instanceIds: declaredConnectors } : {}),
        },
        exposure === 'discover+block' ? 'discover' : 'full',
      )
    : [];

  // Authoritative bypass closure for a trusted reception turn. Assembled
  // here (inside the tool-registration section) so it also catches
  // caller-supplied `extraTools` and any factory path that forgot its own
  // gate. Each entry is a capability whose target lives outside the single
  // confirmed root, outlives the receiver's per-action approval, or reaches
  // the network/another session: none of them can be proven bounded by the
  // tool layer, so they are not exposed at all.
  const RECEPTION_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
    // network (policy network = none)
    'web_fetch', 'web_search', 'marketplace_search', 'marketplace_request_install',
    // connectors (policy connectors = none)
    'list_connector_tools', 'call_connector_tool',
    // direct skill / package script lanes (no per-action receiver approval)
    'run_skill', 'skill_run', 'skill_manage',
    // shell sessions that outlive one-shot approval
    'interactive_cli_start', 'interactive_cli_read', 'interactive_cli_send', 'interactive_cli_close',
    // managed-container writes / renderers with their own path scope
    'create_artifact', 'generate_image',
    'create_docx', 'create_xlsx', 'create_pptx', 'edit_office', 'office_render', 'office_read',
    'edit_ability_asset', 'delete_ability_asset', 'merge_ability_assets', 'rollback_ability_asset',
    'archive_ability_asset', 'restore_ability_asset', 'attach_assets_to_task',
    'create_cognition', 'edit_cognition',
    // cross-session / private stores outside the root
    'chat_search', 'chat_read', 'cross_session_memory', 'metacognition', 'project_instructions',
    // persisted output spool + promoted background runs (local/ tree)
    'tool_result_search', 'tool_result_read_chunk',
    'background_list', 'background_output', 'background_stop',
    // receiver-private read-only surfaces outside the root (the contract
    // exempts only the explicitly authorized Library KB): asset bodies, task
    // experiences, personal ontology, cognition/transcript queries, automation
    // task configuration. Closed both by construction above and by name here.
    'search_ability_assets', 'ontology_query', 'report_ability_asset_usage',
    'list_task_experiences', 'read_task_experience',
    'personal_ontology_fields', 'personal_fields_check',
    'cognition_ontology_query', 'transcript_corrections_query',
    'auto_tasks_list',
    // destructive / write tools without a per-action receiver approval hook
    'delete_file', 'markdown_to_pdf', 'html_to_pdf',
    // external side effects
    'messaging_list_targets', 'messaging_send', 'messaging_send_file',
    'feishu_dashboard', 'briefing_get', 'briefing_schedule', 'touchpoint_list',
    'p3394_send', 'p3394_peers', 'p3394_sessions',
  ]);
  // Closed positive allowlist for a trusted reception turn. The final model
  // surface is exactly this set (intersected with any caller list) — never
  // "whatever happened to be constructed". Only the single-root file tools, the
  // per-action-approved shell, the Library-only KB, the collaboration dispatch
  // tools (targets gated to in-process agents in bus.ts) and the execution-plan
  // bookkeeping are reachable.
  const RECEPTION_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
    // host-scoped file tools (single root R, checked at entry)
    'read_file', 'stat_file', 'ocr_file', 'search_files', 'grep_files', 'list_files',
    'write_file', 'edit_file',
    // host-scoped shell (per-action receiver approval + strict sandbox)
    'bash',
    // Library-only KB (attachment lanes closed in kb-tools)
    'kb_list', 'kb_search', 'kb_read', 'material_search', 'material_list', 'ask_materials',
    // collaboration control plane; nested targets are gated in bus.ts
    'dispatch_to', 'hand_off_to', 'run_worker',
    'manage_execution_plan',
    // declares this turn's deliverables (validated against files written)
    'publish_outputs',
  ]);
  // Names whose host implementation must never be replaced by a caller-supplied
  // `extraTools` entry of the same name (last-write-wins would otherwise let an
  // injected `read_file` / `bash` shadow the scoped implementation).
  const RECEPTION_HOST_PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
    'read_file', 'stat_file', 'ocr_file', 'search_files', 'grep_files', 'list_files',
    'write_file', 'edit_file', 'bash', 'publish_outputs',
    'kb_list', 'kb_search', 'kb_read', 'material_search', 'material_list', 'ask_materials',
    'manage_execution_plan',
  ]);
  const receptionBlocked = (tool: AgentTool): boolean => receptionMode && RECEPTION_BLOCKED_TOOL_NAMES.has(tool.name);
  const receptionInjectedTools = receptionMode ? injectedTools.filter((tool) => !receptionBlocked(tool)) : injectedTools;
  const receptionExtraTools = (params.extraTools || []).filter((tool) => (receptionMode
    ? RECEPTION_TOOL_ALLOWLIST.has(tool.name) && !RECEPTION_HOST_PROTECTED_TOOL_NAMES.has(tool.name)
    : !receptionBlocked(tool)));

  // Merge injected tools with extra tools from caller
  const allTools = params.disableTools ? [] : [
    ...receptionInjectedTools,
    ...localTools,
    ...fileTools,
    ...kbTools,
    ...transcriptGlossaryTools,
    ...recallTools,
    ...assetStewardTools,
    ...(uid && !params.disableTools && !receptionMode ? createCognitionCreateTools({ userId: uid, cid: params.cid, turnId: params.turnId,
      sourceMessageId: params.sourceMessageId, sourceMessageFromUser: params.sourceMessageFromUser, taskText: params.userMessage }) : []),
    ...(uid && !params.disableTools && !receptionMode ? createCognitionEditTools({ userId: uid, cid: params.cid, turnId: params.turnId,
      sourceMessageId: params.sourceMessageId, sourceMessageFromUser: params.sourceMessageFromUser, taskText: params.userMessage }) : []),
    ...experienceTools,
    ...personalOntologyTools,
    ...cognitionKernelTools,
    ...meetingOntologyTools,
    ...chatHistoryTools,
    ...messagingTools,
    ...p3394Tools,
    ...feishuTools,
    ...imageGenTools,
    ...deepResearchTools,
    ...officeTools,
    ...searchOverrideTools,
    ...toolResultTools,
    ...receptionExtraTools,
    ...connectorMetaTools.filter((tool) => !receptionBlocked(tool)),
  ];

  // Authoritative owner-scoped visibility gate: drop any tool whose catalog
  // entry declares an `ownerAgent` other than this actor. Defense-in-depth
  // beyond the construction-time gate above — guarantees an owner-only tool can
  // never reach another actor's tools[] regardless of which injection path
  // produced it. Caller-supplied extraTools / core-agent builtins aren't in the
  // catalog, so `isToolVisibleToAgent` returns true for them (unaffected).
  const effectiveToolAllowlist = params.toolAllowlist === undefined
    ? creatorExecution?.toolAllowlist
    : creatorExecution?.toolAllowlist
      ? params.toolAllowlist.filter(name => creatorExecution!.toolAllowlist.includes(name))
      : params.toolAllowlist;
  let visibleTools = params.disableTools
    ? []
    : allTools.filter((tool) => isToolVisibleToAgent(tool.name, agentId));
  if (!params.disableTools && effectiveToolAllowlist) {
    // creator preset 的工具清单是**额外收窄**，不替代 agent 可见性与只读门禁。
    const allowed = new Set(effectiveToolAllowlist);
    visibleTools = visibleTools.filter((tool) => allowed.has(tool.name));
  }
  if (!params.disableTools && params.toolAccess === 'read-only') {
    visibleTools = visibleTools.filter((tool) => READ_ONLY_TOOL_ALLOWLIST.has(tool.name));
  }
  // Final out-of-scope closure: applies after every other narrowing lane so a
  // caller-supplied tool or a factory that missed its gate still cannot reach
  // the model on a trusted reception turn. The positive allowlist is the
  // authoritative closure — anything constructed but not listed here is gone.
  if (receptionMode) {
    visibleTools = visibleTools.filter((tool) => (
      RECEPTION_TOOL_ALLOWLIST.has(tool.name) && !RECEPTION_BLOCKED_TOOL_NAMES.has(tool.name)
    ));
  }
  const visibleToolNameSet = new Set(visibleTools.map((tool) => tool.name));

  // Turn-level failure breaker. core-agent counts `isError && !recoverable`
  // results into `permanentToolErrors` (agent/runner.ts:1500-1502), and client.ts
  // collects the count. The breaker ends the turn on repeated same-kind
  // deterministic failures (no role template, invalid args, denied policy)
  // using turn-count semantics only. The idle/watchdog path owns time-based stops. See
  // tool-failure-guard.ts for the contract.
  const toolFailureGuard = createToolFailureGuard();
  // Last breaker trip of this run, surfaced through the builder's return so the
  // turn owner (client.ts builds the runner and owns the failureCode channel at
  // `terminalFailureCode` / `failureKind`) can report a real cause instead of the
  // internal maintenance state ("organising context").
  let lastToolFailure: {
    kind: string;
    code: string;
    reason: string;
    failures: number;
    tool: string;
  } | null = null;
  visibleTools = guardToolsWithFailureBreaker(visibleTools, {
    guard: toolFailureGuard,
    onTrip: (event) => {
      lastToolFailure = {
        kind: event.kind,
        code: event.code,
        reason: event.reason,
        failures: event.countedFailures,
        tool: event.tool,
      };
      log.warn('tool failure breaker tripped', {
        sessionId: params.sessionId,
        sessionKind: sessionKindOf(params.sessionId) || undefined,
        tool: event.tool,
        failureCode: event.code,
        failures: event.countedFailures,
      });
    },
  });
  let builtinTools = params.disableTools ? [] : mod.getBuiltinTools();
  if (!params.disableTools && effectiveToolAllowlist) {
    const allowed = new Set(effectiveToolAllowlist);
    builtinTools = builtinTools.filter((t) => allowed.has(t.name));
  }
  if (!params.disableTools && params.toolAccess === 'read-only') {
    builtinTools = builtinTools.filter((t) => READ_ONLY_BUILTIN_ALLOWLIST.has(t.name));
  }
  // Builtins include web_fetch/web_search. A trusted reception turn must not
  // receive them at all (the host overrides read_file/write_file/bash/list_files
  // below with the scoped tool implementations). The positive allowlist is the
  // fixed closure, so a builtin that is merely not blocklisted still cannot
  // leak in.
  if (receptionMode) {
    builtinTools = builtinTools.filter((t) => (
      RECEPTION_TOOL_ALLOWLIST.has(t.name) && !RECEPTION_BLOCKED_TOOL_NAMES.has(t.name)
    ));
  }

  // core-agent's AgentRunner re-adds its own builtins (web_fetch/web_search
  // included) and the execution-plan tool after this host filter. A positive
  // allowlist is the only constructor-level way to keep them out. A trusted
  // reception turn passes the FIXED allowlist (not "whatever is currently
  // visible"), so the constructor can never re-introduce a name the host
  // failed to construct; a caller list can only narrow it.
  const receptionToolAllowlist = receptionMode
    ? (params.disableTools ? [] : Array.from(RECEPTION_TOOL_ALLOWLIST))
    : null;
  const runnerToolAllowlist = receptionToolAllowlist
    ? (effectiveToolAllowlist
        ? effectiveToolAllowlist.filter((name) => receptionToolAllowlist.includes(name))
        : receptionToolAllowlist)
    : effectiveToolAllowlist;

  // Apply one simple 8K per-result policy at AgentRunner's FINAL result
  // boundary. Keeping this as a result transformer (instead of pre-wrapping
  // the current tool list) also covers core builtins and tools AgentRunner adds
  // later, notably skill_manage. AgentRunner supplies a shared 16K-per-model-
  // step ledger through ctx.state and shrinks it when context headroom is low.
  // `uid` can be empty in ad-hoc tests; without a session Result Store we leave
  // outputs untouched.
  const transformToolResult = uid
    ? (toolName: string, result: ToolResult, ctx: ToolContext): ToolResult =>
        capToolResult(toolName, result, ctx, {
          maxInlineTokens: DEFAULT_INLINE_RESULT_TOKENS,
          toolResultsDir,
        })
    : undefined;

  // Final tool name set the AgentRunner will see — core-agent builtins
  // (read_file/write_file/bash/list_files/web_search/web_fetch) merged with
  // our visibleTools via last-write-wins. Used by the snapshot below and by
  // the catalog-drift test (`tool-catalog.test.ts`); we no longer render a
  // `## Available tools` block into the system prompt because the model
  // already receives every tool's compact description + JSON schema via the
  // SDK tool-use protocol — the prompt block was an information subset
  // duplicating ~800 chars per call without giving the model anything new.
  // Label only the extras that actually survived the reception closure: a
  // caller-supplied `read_file` that was dropped must not make the host's
  // scoped implementation look like an "extra" in the dev archive.
  const extraToolNameSet = new Set(receptionExtraTools.map((t) => t.name));
  const finalToolNames = Array.from(new Set([
    ...builtinTools.map((t) => t.name),
    ...visibleTools.map((t) => t.name),
  ]));

  // Snapshot the final tool definitions for the dev archive. Last-write-wins
  // merge: builtins first, then visibleTools override by name. Source label
  // tracks where each definition came from so the debug panel can call out
  // injected vs. caller-supplied tools.
  const toolDefMap = new Map<string, ToolDefSnapshot>();
  const snapshotTool = (t: AgentTool, source: ToolDefSnapshot['source']): ToolDefSnapshot => {
    const def = mod.toToolDefinition(t);
    return {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      source,
    };
  };
  for (const t of builtinTools) {
    toolDefMap.set(t.name, snapshotTool(t, 'core-agent'));
  }
  for (const t of visibleTools) {
    toolDefMap.set(
      t.name,
      snapshotTool(
        t,
        extraToolNameSet.has(t.name) ? 'extra' : visibleToolNameSet.has(t.name) ? 'cogseed' : 'core-agent',
      ),
    );
  }
  const toolDefs: ToolDefSnapshot[] = Array.from(toolDefMap.values())
    .sort((a, b) => a.name.localeCompare(b.name));

  // Finalize system prompt. Cache-friendly order:
  //   [base prompt] → [connectors] → [system skills] → [skills]
  //   → [agents] → [runtime injection] → [memory] → [orchestration state]
  //   → [volatile datetime tail].
  // Everything from [runtime injection] onward is the turn-volatile region;
  // the stable prefix above it is what the provider prompt-cache reuses.
  // Tool list is no longer in the prompt (see toolsBlock removal note above)
  // because the SDK tool-use protocol delivers it via a separate API field.
  const parts: string[] = [];
  const { stable: stableSystemPrompt, volatileTail } = splitVolatilePromptTail(params.systemPrompt);
  const { stable: stableWithoutAgents, agentsBlock } = splitCommanderAgentsBlock(stableSystemPrompt);
  const { stable: stableWithoutRuntime, runtimeInjectionBlock } = splitRuntimeInjectionBlock(stableWithoutAgents);
  // Orchestration state carries the per-turn `orchestration_ledger` JSON; it
  // must leave the cached prefix or it invalidates the whole prefix after it
  // every commander turn a ledger is live. Peel it here and re-emit it in the
  // volatile region below.
  const { stable: stableWithoutOrchestration, orchestrationBlock } = splitCommanderOrchestrationBlock(stableWithoutRuntime);
  if (stableWithoutOrchestration) parts.push(stableWithoutOrchestration);
  if (connectorBlock) parts.push(connectorBlock.trim());
  if (systemSkillsBlock) parts.push(systemSkillsBlock.trim());
  if (skillsBlock) parts.push(skillsBlock.trim());
  if (agentsBlock) parts.push(agentsBlock);
  // Static rules for resolving conflicts among the user-managed project
  // layers. Always present in real project work sessions, even when COGSEED.md,
  // memory, or the task backlog is empty.
  const projectContextPolicyBlock = (uid && memoryAgentScope && params.spaceId)
    ? formatSpaceContextPolicyForSystemPrompt()
    : '';
  if (projectContextPolicyBlock) parts.push(projectContextPolicyBlock);
  // User-authored space instructions (read side): low-churn configuration,
  // so it stays in the stable cache prefix (before the runtime injection).
  // Gated on memoryAgentScope like memory: edit/one-shot sessions get neither.
  const projectInstructionsBlock = (uid && memoryAgentScope && params.spaceId)
    ? formatSpaceInstructionsForSystemPrompt(uid, params.spaceId)
    : '';
  if (projectInstructionsBlock) parts.push(projectInstructionsBlock);
  if (isCommander && params.cid) parts.push('Read existing ontology and confirmed transcript corrections when they help the current task. User answers and current document corrections do not directly create long-term cognition. Durable formation requires the source-bound creation or nightly extraction workflow and user confirmation.');
  if (runtimeInjectionBlock) parts.push(runtimeInjectionBlock);
  // Cross-session memory (read side): the user's stored profile + notes as
  // background context. It is more turn-volatile than resource indexes, so
  // it sits after connectors / skills / agents but before per-turn state.
  // Empty string when nothing is stored (no tokens for new users).
  // Re-read each turn — a mid-conversation write shows up next turn.
  // Project sessions additionally render the project's own notes section.
  let activeCognitionSourceIds: ReadonlySet<string> = new Set();
  if (uid && memoryAgentScope) {
    try {
      activeCognitionSourceIds = await listActiveCognitionSourceIds(uid);
    } catch (err) {
      // Fail closed for machine-owned cognition records while leaving the
      // user's independent USER/MEMORY entries available to the model.
      log.warn('active cognition memory scan failed', {
        user_id: maskId(uid),
        error: logErrorSummary(err),
      });
    }
  }
  // 背景画像从资产库渲染（personal 资产按
  //  使用次数取头部）；记忆文件中尚未迁移的独立条目仍保留，关联镜像服从资产
  //  状态和范围门控。agent/space 档仍由各自记忆文件提供。
  const formatMemoryBlockWithAssetProfile = async (
    userId: string, agentId: string, spaceId?: string, projectId?: string, activeIds: ReadonlySet<string> = new Set(),
  ): Promise<string> => {
    let assetProfileEntries: string[] = [];
    let assetProfileSourceBlocksFallback = false;
    try {
      const { loadAssetProfileEntriesWithAvailability } = await import('../../features/recall/profile-block');
      const profile = await loadAssetProfileEntriesWithAvailability(userId, {
        readContext: {
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(spaceId ? { workspaceId: spaceId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(params.userMessage ? { taskText: params.userMessage } : {}),
        },
      });
      assetProfileEntries = profile.entries;
      assetProfileSourceBlocksFallback = profile.hasPersonalAssets;
    } catch {
      assetProfileEntries = [];
      // 资产库状态不明时不能回退到可能含有正式资产旧副本的记忆文件。
      assetProfileSourceBlocksFallback = true;
    }
    return formatMemoryForSystemPrompt(
      userId, agentId, spaceId, projectId, activeIds, assetProfileEntries, assetProfileSourceBlocksFallback,
    );
  };
  // Trusted external reception keeps the receiver's private background out of
  // the system prompt: cross-session memory and the asset profile / role
  // portrait are host-private context, never visitor-visible. This guard is
  // intentionally independent of memoryAgentScope so a future widening of
  // memory eligibility cannot silently reopen the leak.
  const privateBackgroundAllowed = !params.receptionScope;
  const memoryBlock = (uid && memoryAgentScope && privateBackgroundAllowed)
    ? await formatMemoryBlockWithAssetProfile(uid, memoryAgentScope, params.spaceId, params.projectId, activeCognitionSourceIds)
    : '';
  if (memoryBlock) parts.push(memoryBlock);
  // 空间角色画像：会话挂空间 → 注入该角色模板画像（个人本体角色模板文件，
  // 与 memoryBlock 同层级的读侧背景上下文；异步读文件，失败静默降级为空串）。
  const roleProfileBlock = (uid && memoryAgentScope && privateBackgroundAllowed && params.spaceId)
    ? await formatRoleProfileForSystemPrompt(uid, params.spaceId, {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.projectId ? { projectId: params.projectId } : {}),
      workspaceId: params.spaceId,
      ...(params.userMessage ? { taskText: params.userMessage } : {}),
    })
    : '';
  if (roleProfileBlock) parts.push(roleProfileBlock);
  const resolvedSystemPrompt = parts.join('\n\n');
  // The truly per-turn-volatile blocks — the orchestration ledger (~7-9K
  // JSON that changes every commander turn) and the datetime tail — do NOT go
  // into the system prompt. Even peeled to the tail they bust the
  // Anthropic single-block system cache (and therefore the whole history
  // prefix) every turn. Instead they ride on THIS turn's user message
  // (core-agent AgentRunParams.turnEphemeral → getMessagesForModel), the
  // uncached tail after all history, so the system + history cache prefix stays
  // byte-stable across turns.
  const turnEphemeral = [orchestrationBlock, volatileTail]
    .filter((b) => b && b.trim())
    .join('\n\n');

  // Evolution (the self-evolving skill store) is per-agent: when an
  // agentId is present we write into that agent's private directory
  // `<uid>/cloud/agents/<aid>/skills/`. The core default conversation
  // (no agentId) has evolution disabled — the commander shouldn't be
  // auto-producing skills; user-authored skills go through the
  // System A path in the user UI.
  // When the evolution stanza is not passed, core-agent defaults to
  // enabled=true + skillsDir="skills" relative to cwd, which would
  // create skills under the application working directory.
  const evolutionConfig = (agentId && earlyUid)
    ? { enabled: true, skillsDir: agentEvolvedSkillsDir(earlyUid, agentId) }
    : { enabled: false };

  // Fill the model catalog with each model's REAL context window (+ max output
  // tokens) so core-agent's compaction trigger uses it instead of the 200K
  // fallback — otherwise a 1M-window model compacts at 0.8×200K=160K, throwing
  // away most of its context. Populate EVERY candidate in the rotating
  // group (keyed by its modelId), not just the primary: rotating-provider can
  // fail over to a different-window model mid-run, and core-agent looks the
  // window up by the model the stream actually reported.
  // resolveConfiguredPiModel returns the pi-ai Model (catalog or custom-built),
  // which carries contextWindow + maxTokens.
  // Each entry must satisfy core-agent's ModelConfigSchema, which REQUIRES
  // `provider` + `model` (contextWindow / maxOutputTokens are optional).
  // modelCatalogEntryFromModel only supplies the windows, so add provider/model
  // here. These two are schema-required metadata only — core-agent reads the
  // catalog solely for contextWindow/maxOutputTokens and routes via
  // defaultProvider/defaultModel + the injected rotating provider, never via
  // catalog[x].provider. Both fields must be present for createConfig's
  // provider/model schema validation.
  const modelCatalog: Record<string, { provider: string; model: string; contextWindow?: number; maxOutputTokens?: number }> = {};
  for (const choice of group) {
    if (modelCatalog[choice.model]) continue;
    const model = (EXTERNAL_API_PROVIDERS.includes(choice.provider) || isCustomProviderId(choice.provider))
      ? buildExternalProviderModel(uid, choice.provider, choice.model, choice.maxOutputTokens)
      : resolveConfiguredPiModel(mod, choice.provider, choice.model)?.model;
    // pi-ai 目录模型同样吃本地覆盖（窗口/输出），否则设置页改了窗口、运行时仍按
    // 目录值预算。
    const overridden = applyModelAbilityOverride(choice.provider, {
      id: choice.model,
      ...(typeof model?.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model?.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
    });
    // Creator 输出上限须经同一目录项生效，同时保留预设覆盖结果
    // （`overridden`），避免设置页的窗口/输出覆盖在目录路径上丢失。
    const entry = modelCatalogEntryFromModel(overridden, maxOutputTokensCeiling);
    if (entry) modelCatalog[choice.model] = { provider: choice.provider, model: choice.model, ...entry };
  }
  // Environment-key fallback has no auth entry in `group`; preserve the same
  // caller/runtime output ceiling on that selected model as well.
  if (maxOutputTokensCeiling !== undefined && !modelCatalog[modelId]) {
    modelCatalog[modelId] = {
      provider: providerId,
      model: modelId,
      maxOutputTokens: maxOutputTokensCeiling,
    };
  }
  const config: CoreAgentConfig = mod.createConfig({
    agent: {
      ...(params.onModelDispatch && !primary ? { maxRetries: 0 } : {}),
      defaultProvider: providerId,
      defaultModel: modelId,
      ...(resolvedSystemPrompt ? { systemPrompt: resolvedSystemPrompt } : {}),
      ...(params.maxToolLoops ? { maxToolLoops: params.maxToolLoops } : {}),
      ...(creatorExecution
        ? { toolIdleTimeoutMs: creatorExecution.idleTimeout * 1000 }
        : {}),
    },
    evolution: evolutionConfig,
    ...(Object.keys(modelCatalog).length ? { models: { catalog: modelCatalog } } : {}),
    // We deliberately do NOT populate `models.providers` —
    // ProviderRegistry's constructor runs the default factory
    // (anthropic / openai / pi-ai) on every entry and stuffs the
    // provider instance into the `providers` cache; subsequent
    // `providers.get(id)` calls hit the cache first and never reach
    // the registerFactory-injected rotating-provider below. Hand all provider
    // creation to rotating-provider so cooldown and error classification also
    // apply to single-key groups; for a single key the wrapper is just one
    // closure (negligible cost) and we get a uniform error path.
  });

  const providers = new mod.ProviderRegistry(config);

  if (primary) {
    // Build a rotating provider covering the whole primary group. Even
    // when there's only one candidate, the wrapper is cheap (just one
    // pass-through) and keeps the code path uniform.
    const rotating = await buildRotatingProvider(
      mod,
      uid,
      providerId,
      group,
      params.onNativeSearchInjected,
      params.onCandidateChosen,
      params.providerFirstEventTimeoutMs,
      { ...params, toolAllowlist: runnerToolAllowlist },
      maxOutputTokensCeiling,
    );
    // Inject the rotating provider into BOTH the factory slot AND the
    // pre-built instance cache. ProviderRegistry.get() short-circuits on
    // the instance cache without consulting the factory, so injecting
    // only the factory would be a no-op if any upstream path ever
    // pre-warms the default implementation.
    providers.registerFactory(providerId, () => rotating);
    (providers as any).providers?.set?.(providerId, rotating);
  }

  // When a skill is learned via skill_manage(create), append it to the bound
  // agent's explicit skill_list metadata if one exists. Goes through
  // `appendAgentSkill` (not `updateCustomAgent`) to bypass the unknown-id
  // filter, which would drop the new id — System B (SkillStore) skills aren't
  // in System A's SkillLoader spec list. No-op when agentId is empty or when
  // the agent has no explicit dependency list.
  const onSkillCreated = agentId && uid
    ? (skillId: string) => {
        appendAgentSkill(uid, agentId, skillId)
          .catch((err) => log.warn('skill_list sync failed', {
            agent_id: maskId(agentId),
            skill_id: maskId(skillId),
            error: logErrorSummary(err),
          }));
      }
    : undefined;

  // Bridge System B advertised → ChatOptions.onSkillAdvertised. The SDK
  // doesn't know about the host's skill-system taxonomy; we tag every id
  // it surfaces as `'B'` before passing it up.
  const onLearnedSkillAdvertised = params.onSkillAdvertised
    ? (id: string) => params.onSkillAdvertised!(id, 'B')
    : undefined;

  const runner = new mod.AgentRunner({
    config,
    providers,
    session,
    ...(params.disableTools ? { disableTools: true } : {}),
    ...(ontologyActionPreflight ? { beforeToolExecute: async (toolName: string, input: Record<string, unknown>) => {
      const winner = [...visibleTools].reverse().find(tool => tool.name === toolName);
      // A caller overriding a local tool does not inherit its final-write adapter.
      return ontologyActionPreflight(toolName, input, Boolean(winner && localTools.includes(winner)), !(winner && params.extraTools?.includes(winner)));
    } } : {}),
    ...(runnerToolAllowlist ? { toolAllowlist: runnerToolAllowlist } : {}),
    ...(visibleTools.length ? { tools: visibleTools } : {}),    ...(transformToolResult ? { transformToolResult } : {}),
    // `approvalContext` 让宿主侧工具能定位"这次调用属于哪个会话"。用途之一是把写操作接到
    // `features/action_approval.ts` 的人工审批闸上（该闸要求 runtimeSessionId /
    // runtimeRequestId 才能广播确认弹窗与写审计）。
    //
    // 现状与边界：本字段只做**会话标识透传**，尚未有任何工具消费它——`call_connector_tool`
    // 至今没有强制确认，靠的是 agent workflow 里的纪律。要把它变成硬闸，仍需在生成
    // ActionApprovalInput 时补齐 runtimeRequestId（当前只在 cogseed_runtime worker 路径上
    // 存在，核心 agent 的 ToolContext 拿不到），那是一次独立改动。
    ...(toolResultsDir || params.sessionId || params.cid
      ? {
          toolContextState: {
            ...(toolResultsDir ? { toolResultSpoolDir: toolResultsDir } : {}),
            approvalContext: {
              ...(params.sessionId ? { sessionId: params.sessionId } : {}),
              ...(params.cid ? { cid: params.cid } : {}),
              ...(uid ? { uid } : {}),
            },
          },
        }
      : {}),
    ...(params.skillList !== undefined ? { skillAllowlist: params.skillList } : {}),
    ...(onSkillCreated ? { onSkillCreated } : {}),
    ...(onLearnedSkillAdvertised ? { onLearnedSkillAdvertised } : {}),
  });

  return {
    runner,
    resolvedSystemPrompt,
    turnEphemeral,
    entryId: primary?.entryId,
    profileId: primary?.profileId,
    providerId,
    modelId,
    toolDefs,
    skillDisplayNameById,
    agentDisplayNameById,
    finalResponseGate: recallToolSuite?.finalResponseGate,
    /**
     * Last deterministic-failure breaker trip of this run, or `null`.
     * Consulted after `runner.run()` resolves so the turn can carry a real
     * failure kind/code (see `client.ts` `terminalFailureCode`). The breaker
     * itself already ended the turn via `endTurn: true`; this is the reporting
     * half of the same signal.
     */
    toolFailure: () => lastToolFailure,
  };
}

/** Best-effort accessor for the active uid that doesn't throw when no user is activated yet
 *  (ad-hoc / test paths). Production callers always come through with `params.userId` or after
 *  `activateUser()`, so the fallback is just a safety net. Loaded lazily via require to avoid
 *  pulling features/users into the early import graph. */
function _safeActiveUserId(): string | null {
  try {
    const { getActiveUserId } = require('../../features/users') as typeof import('../../features/users');
    return getActiveUserId();
  } catch {
    return null;
  }
}

/** Tri-state connector exposure, gated by session kind:
 *   - `tools+block`:    group-chat task sessions (`gconv` commander + `gmember` agent worker)
 *     — block + both meta-tools (`list_connector_tools` + `call_connector_tool`). Full exposure.
 *   - `discover+block`: agent-edit (`agent`) — block + `list_connector_tools` ONLY. Editor LLM
 *     can discover action names + JSON schemas to write specific workflow steps; cannot invoke
 *     (an authoring session must never produce external side effects).
 *   - `none`:           skill-edit, KB-image, CLI dispatch, reflect, memory-extract, anon, and
 *     any future kind — neither block nor tools.
 *   Add a new conversation kind that needs connectors? Extend this function explicitly + add
 *   the session-kind allowlist.
 *
 * session_id format is `<kind>-<tail>` (uid is not encoded in session_id), so the
 * kind keyword is anchored at the start. */
export function connectorExposureFromSessionId(sessionId: string): 'tools+block' | 'discover+block' | 'none' {
  if (/^(gconv|gmember)-/.test(sessionId)) return 'tools+block';
  // Agent-edit gets `list_connector_tools` (read-only, no side effects) so the editor LLM can
  // learn each connector's action names and write specific workflow steps — but NOT
  // `call_connector_tool`, since an authoring session must never produce external side
  // effects. See `connector-meta-tools.ts::createConnectorMetaTools` mode handling.
  if (/^agent-/.test(sessionId)) return 'discover+block';
  return 'none';
}

/** System skills are authoring/orchestration affordances, not worker context.
 *  Keep them visible to the group-chat commander, agent editor, and skill editor only; ordinary
 *  agent workers receive the normal user skill surface, not authoring protocols. */
export function systemSkillsExposureFromSessionId(sessionId: string): boolean {
  return /^gconv-/.test(sessionId) || /^agent-/.test(sessionId) || /^skill-/.test(sessionId);
}

/**
 * 解析某个 agent 声明的连接器白名单，供 `getConnectorPromptBlock` /
 * `createConnectorMetaTools` 收窄可见范围（"配置两个 MCP 的访问权限"）。
 *
 * 三态语义（与 `Agent.skill_list` 一致）：
 *   - `undefined` → 该 agent 未声明 ⇒ 继承 commander 的可见性。**这是为了不改变存量行为**：
 *     传 `undefined` 进去，`resolveVisibleConnectors` 会返回全部实例。
 *   - `[]`        → 声明为"零连接器" ⇒ 返回空数组，`[]` 与 `undefined` 在适配器里不同义。
 *   - 非空数组     → 收窄到这些实例 id。
 *
 * 为什么不能用 `enabled_connectors` 的 `|| []` 直接代替：那会让每个未声明的 agent
 * 都从"看到全部"突变成"一个都看不到"（`_enabledInstancesForActor` 对 `agentId`
 * 存在且白名单为空的情况返回 `[]`）。会议纪要 agent 正是靠非空白名单才能做到
 * "只允许腾讯会议 + MeshSeed 两个 MCP"。
 */
export async function connectorAllowlistForAgent(
  uid: string,
  agentId: string,
): Promise<string[] | undefined> {
  if (!agentId) return undefined;
  try {
    const agent = await getAgentForChatDispatch(uid, agentId);
    const declared = agent?.enabled_connectors;
    if (!Array.isArray(declared)) return undefined;
    return declared;
  } catch (err) {
    // 读不到 agent 规格时保守放行（与改动前的 commander 可见性一致），并留下日志；
    // 不因为一次规格读取失败就让用户在所有 agent 里失去连接器。
    log.warn(`connector allowlist lookup failed; falling back to commander visibility: ${String(err)}`);
    return undefined;
  }
}

/** OPEN-tier skills (external packages + global roots) render for group-chat
 *  task sessions and agent-edit authoring sessions. One-shots and background
 *  kinds never see them. */
export function openSkillSourcesExposureFromSessionId(sessionId: string): boolean {
  return /^(gconv|gmember|agent)-/.test(sessionId);
}

/**
 * Factory dispatcher for CogSeed's external (pi-ai-unaware) providers.
 * Extend the switch when a new id is added to `EXTERNAL_API_PROVIDERS`.
 * Async because the underlying factories await core-agent dynamic import.
 */
async function buildExternalProvider(userId: string | null, providerId: string, apiKey: string, modelId: string, baseUrl?: string, maxOutputTokens?: number): Promise<LLMProvider> {
  if (isCustomProviderId(providerId)) {
    if (!userId) throw new Error('custom provider requires an active user');
    return createCustomProvider(userId, providerId, apiKey, modelId);
  }
  switch (providerId) {
    case 'moonshot':
      return await createMoonshotProvider({ apiKey, modelId });
    case 'deepseek':
      return await createDeepSeekProvider({
        apiKey,
        modelId,
        override: modelAbilityOverrideFor('deepseek', modelId),
      });
    case 'doubao':
      return await createDoubaoProvider({ apiKey, modelId });
    case 'openai-compatible':
      return await createOpenAICompatibleProvider({ apiKey, baseUrl: baseUrl || '', modelId, maxOutputTokens });
    default:
      throw new Error(`no external provider factory for "${providerId}"`);
  }
}

/**
 * Build an `LLMProvider` that wraps every entry behind cross-provider
 * fallback rotation. `build()` closures are deferred so we only pay the
 * construction cost for candidates we actually try — if the primary key
 * works on first request, fallbacks never get built.
 *
 * Candidates may target different `(provider, model)` pairs — e.g. the
 * primary might be `openai/gpt-5.4` and the next fallback
 * `anthropic/claude-opus-4.7`. rotating-provider overrides `params.model`
 * with each candidate's own model id before delegating, so AgentRunner
 * (which only knows the primary's model) is none the wiser.
 *
 * The wrapper is registered under `primary.provider` as far as
 * ProviderRegistry is concerned. That's just a routing label — once
 * AgentRunner retrieves it, all rotation is handled internally.
 *
 * On success (`onSuccess`), we bump `lastUsed` on the winning entry
 * and clear any prior cooldown on that profile (the key just proved it
 * works — don't keep skipping it).
 */
/** rotating 候选的输出上限：external 候选走适配器（内部已套「预设详情」
 *  覆盖）；pi-ai 内置候选必须同样套覆盖——rotating 层的 paramsFor 会用该
 *  cap 无条件覆盖主回合参数，不套时目录原值会把用户在设置页写下的输出
 *  上限抹掉。
 *  导出供回归测试（同 bus.ts::_isDeepSeekOfficialBaseUrl 先例）。 */
export function rotatingCandidateMaxTokens(
  userId: string | null,
  candProviderId: string,
  candModelId: string,
  isExternal: boolean,
  resolvedModel: { model?: { id: string; contextWindow?: number; maxTokens?: number } } | null,
  choiceMaxOutputTokens: number | undefined,
): number | undefined {
  if (isExternal) {
    return buildExternalProviderModel(userId, candProviderId, candModelId, choiceMaxOutputTokens)?.maxTokens;
  }
  return applyModelAbilityOverride(candProviderId, {
    id: candModelId,
    ...(resolvedModel?.model ?? {}),
  }).maxTokens;
}

async function buildRotatingProvider(
  mod: CA,
  userId: string | null,
  providerId: string,
  group: ChatEntryChoice[],
  onNativeSearchInjected?: (info: NativeSearchInjectedInfo) => void,
  onCandidateChosen?: (info: { profileId: string; providerId: string; modelId: string; entryId?: string }) => void,
  firstEventTimeoutMs?: number,
  utilityOptions: UtilityResponseFormatOptions & { toolAllowlist?: readonly string[]; onModelDispatch?: () => Promise<void> } = {},
  maxOutputTokensCeiling?: number,
): Promise<LLMProvider> {
  const candidates: RotatingCandidate[] = group.map((choice) => {
    const candProviderId = choice.provider;
    const candModelId = choice.model;
    const isExternal = EXTERNAL_API_PROVIDERS.includes(candProviderId) || isCustomProviderId(candProviderId);
    // Resolve each candidate's OWN output cap once up front so the rotating
    // wrapper can override `params.maxTokens` per candidate. core-agent only
    // knows the primary's cap; carrying it to a fallback with a lower cap
    // makes that provider reject or truncate the request.
    const resolvedModel = isExternal ? null : resolveConfiguredPiModel(mod, candProviderId, candModelId);
    const candMaxOutputTokens = rotatingCandidateMaxTokens(
      userId, candProviderId, candModelId, isExternal, resolvedModel, choice.maxOutputTokens,
    );
    // Clamp every rotated candidate to the caller and runtime output ceilings.
    const effectiveCandMaxOutputTokens = typeof candMaxOutputTokens === 'number'
      && candMaxOutputTokens > 0
      && typeof maxOutputTokensCeiling === 'number'
      && maxOutputTokensCeiling > 0
      ? Math.min(candMaxOutputTokens, maxOutputTokensCeiling)
      : candMaxOutputTokens;
    return {
      profileId: choice.profileId,
      providerId: candProviderId,
      modelId: candModelId,
      ...(typeof effectiveCandMaxOutputTokens === 'number' && effectiveCandMaxOutputTokens > 0
        ? { maxOutputTokens: effectiveCandMaxOutputTokens }
        : {}),
      build: async () => {
        if (isExternal) {
          return buildExternalProvider(userId, candProviderId, choice.apiKey, candModelId, choice.baseUrl, effectiveCandMaxOutputTokens);
        }
        if (resolvedModel?.isConfiguredFallback) {
          log.info('using configured model fallback', {
            provider: candProviderId,
            model: candModelId,
            templateProvider: resolvedModel.catalogProviderId,
            templateModel: resolvedModel.templateModelId,
          });
        }
        return mod.createPiProvider({
          provider: candProviderId,
          ...(resolvedModel?.needsCustomModel ? { customModel: resolvedModel.model } : { model: candModelId }),
          apiKey: choice.apiKey,
          onPayload: composeUtilityResponseFormatOnPayload(candProviderId, utilityOptions.responseFormat,
            utilityOptions.disableTools ? undefined : buildNativeSearchOnPayload(candProviderId, candModelId, onNativeSearchInjected, utilityOptions.toolAllowlist)),
        });
      },
    };
  });

  return createRotatingProvider({
    ...(utilityOptions.onModelDispatch ? { beforeDispatch: utilityOptions.onModelDispatch } : {}),
    ...(userId ? { userId } : {}),
    providerId,
    candidates,
    onSuccess: (profileId) => {
      const winner = group.find((c) => c.profileId === profileId);
      if (winner) {
        if (userId) bumpEntryLastUsedForUser(userId, winner.entryId);
        else bumpEntryLastUsed(winner.entryId);
      }
      if (userId) clearCooldownForUser(userId, profileId);
      else clearCooldown(profileId);
    },
    ...(onCandidateChosen ? {
      onCandidateChosen: (info) => {
        const winner = group.find((choice) => choice.profileId === info.profileId);
        onCandidateChosen({
          ...info,
          ...(winner?.entryId ? { entryId: winner.entryId } : {}),
        });
      },
    } : {}),
    ...(Number.isFinite(firstEventTimeoutMs) ? { firstEventTimeoutMs } : {}),
    ...(typeof maxOutputTokensCeiling === 'number' && maxOutputTokensCeiling > 0
      ? { maxOutputTokensCeiling }
      : {}),
  });
}

/** Check if metacognition feature is enabled.
 *
 *  Single source of truth lives in `features/metacognition.isFeatureEnabled`
 *  (combines env `COGSEED_METACOGNITION='0'` kill switch + per-user preference
 *  written from settings UI). This thin wrapper exists to avoid changing
 *  every existing call site at once. */
/** Check if metacognition feature is enabled (env var toggle). */
export function isMetacognitionEnabled(): boolean {
  return metacognition.isFeatureEnabled();
}

/**
 * Builds a pi-ai `onPayload` callback: pi-ai invokes it after handing us
 * the result of `buildParams` and before sending the request. When both
 * "the debug toggle is on" and "model.api is in the supported list" hold,
 * we append the model's native web search tool schema to `params.tools`,
 * write an info log, and bubble the "injected" event up through the
 * caller-supplied callback to client.ts's archive recorder.
 *
 * On a miss we return params unchanged (pi-ai treats an undefined return
 * as no-op, so a no-op return is also legal).
 */
export function buildNativeSearchOnPayload(
  providerId: string,
  modelId: string,
  onNativeSearchInjected?: (info: NativeSearchInjectedInfo) => void,
  toolAllowlist?: readonly string[],
): (params: unknown, model: { api?: string }) => unknown {
  return (params, model) => {
    if (!isNativeSearchEnabled()) return params;
    const api = model?.api;
    if (!api) return params;
    const tool = nativeSearchToolForApi(api);
    if (!tool) return params;
    const toolName = nativeSearchToolName(tool) || 'native_web_search';
    // Provider-side tools must obey the same host subset as SDK tools. This
    // also keeps unsupported/denied search away from global profile lookup.
    if (toolAllowlist && !toolAllowlist.includes('web_search') && !toolAllowlist.includes(toolName)) return params;
    // Don't inject the model-side native search when the user has any paid
    // search-tool API key configured — let the overriding `web_search` tool
    // (search-tools.ts) be the single search surface, otherwise the LLM
    // sees two competing tools and may bypass the paid one the user paid for.
    if (hasAnySearchProfile()) return params;
    // Payload shape + size stamped into each injection so diagnostic logs
    // can correlate fetch failures to body size / turn length.
    // Cheap — one JSON.stringify of an already-serialisable object.
    const cur = params as { tools?: unknown[]; messages?: unknown[]; input?: unknown[] } & Record<string, unknown>;
    let approxBodyBytes = -1;
    try { approxBodyBytes = JSON.stringify(params).length; } catch { /* circular — give up */ }
    const msgCount = Array.isArray(cur.messages)
      ? cur.messages.length
      : (Array.isArray(cur.input) ? cur.input.length : -1);
    const toolsBefore = Array.isArray(cur.tools) ? cur.tools.length : 0;
    runnerLog.info('native web search injected', {
      provider: providerId, model: modelId, api, tool: toolName,
      msgCount, toolsBefore, approxBodyBytes,
    });
    try {
      onNativeSearchInjected?.({ provider: providerId, model: modelId, api, tool: toolName });
    } catch (err) {
      runnerLog.warn(`onNativeSearchInjected callback failed: ${(err as Error).message}`);
    }
    return { ...cur, tools: [...(Array.isArray(cur.tools) ? cur.tools : []), tool] };
  };
}
