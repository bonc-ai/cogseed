/** 智能体出生时继承了什么。
 *
 *  在此之前，生成一个 Agent 只带走角色提示与工作流，前序项目上下文、认知资产、
 *  术语表一律丢失——新 Agent 被问到前序项目里的专有名词时只能瞎猜。
 *
 *  这里记录的是**出生快照**，三条纪律：
 *
 *  1. **一次写入，之后不可变**。它回答的是「这个 Agent 是带着什么诞生的」，
 *     不是「它现在能看到什么」。事后编辑 Agent 不改写这份记录，否则
 *     「继承内容」就成了一面永远和当下一致的镜子，失去追溯价值。
 *  2. **带引用，不搬正文**。项目、会话、记忆、认知资产都只记 id 与版本。
 *     正文会变，复制一份就等于在 Agent 目录下埋了一份悄悄过期的影子副本。
 *  3. **缺失就是缺失**。没有术语表就不写空数组式的假承诺；
 *     `readAgentInheritance` 对老 Agent 返回 null，调用方必须显式处理
 *     「这个 Agent 生成时还没有继承机制」，不能假装它继承了空。
 *
 *  **为什么这里不建能力包。** 早先的版本在出生时调 `capability-pack-delivery`
 *  造一个 pack 存进记录里，还得为此编一个 365 天的假有效期——因为那个 schema
 *  要求必须有 expiresAt，而继承根本不是一次限时授权。现在直接存资产引用：
 *  继承要回答的就是「出生那一刻带了哪些资产的哪个版本」，这本身就是完整答案，
 *  不需要绕道一个为跨端交付设计的容器。引用形状仍复用
 *  `p3394/capability-pack` 的 `CapabilityPackAssetRef`，两边保持可对接。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { agentDir, userAgentsDir } from '../paths';
import { safeId, writeJson } from '../storage';
import { fileEditLock } from '../util/locks';
import type { CapabilityPackAssetRef } from './p3394/capability-pack';
import type { RecallAbilityAssetRecord } from './recall/candidate-service';

const MAX_ROLE_PROMPT_LENGTH = 8_000;
const MAX_GLOSSARY_ENTRIES = 200;
const MAX_TERM_LENGTH = 200;
const MAX_DEFINITION_LENGTH = 1_000;
const MAX_MEMORY_REFS = 200;
const MAX_INHERITED_ASSETS = 500;

export interface AgentGlossaryEntry {
  term: string;
  definition: string;
}

/** 一条资产没被继承的原因。`user_excluded` 是用户在生成界面勾掉的，
 *  其余都是资产自身状态决定的——两者要分得开：前者是人的决定，后者是系统的。 */
export type InheritanceExclusionReason =
  | 'user_excluded'
  | 'paused'
  | 'archived'
  | 'revoked'
  | 'deleted'
  | 'purged';

export interface ExcludedInheritedAsset {
  assetId: string;
  reason: InheritanceExclusionReason;
}

export interface AgentInheritanceOrigin {
  conversationId?: string;
  projectId?: string;
  workspaceId?: string;
}

export interface AgentInheritanceRecord {
  /** 2 = 直接存资产引用；1 = 早先内嵌 delivery capability pack 的形状，读取时兼容。 */
  schemaVersion: 2;
  agentId: string;
  /** 出生时冻结的认知资产引用（id + 版本 + 内容哈希）。只记引用，不搬正文。 */
  inheritedAssets: CapabilityPackAssetRef[];
  /** 出生时**没有**带走的资产及原因。记下来是为了让「没继承」有据可查，
   *  否则事后看只能看到少了几条，看不出是本来就没有、还是被排除掉的。
   *  没有任何排除时缺失（而不是空数组）。 */
  excludedAssets?: ExcludedInheritedAsset[];
  /** 角色提示在出生那一刻的原文快照。 */
  rolePrompt: string;
  /** 从哪个会话/项目里长出来的——只记 id。 */
  origin: AgentInheritanceOrigin;
  glossary?: AgentGlossaryEntry[];
  /** 必要记忆的引用，不搬正文。 */
  memoryRefs?: string[];
  createdAt: string;
}

export interface BuildAgentInheritanceInput {
  agentId: string;
  rolePrompt: string;
  assets: RecallAbilityAssetRecord[];
  origin?: AgentInheritanceOrigin;
  glossary?: AgentGlossaryEntry[];
  memoryRefs?: string[];
  createdAt: string;
  /** 用户在生成界面手动勾掉的资产。 */
  excludedAssetIds?: string[];
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid agent inheritance ${field}`);
  const text = value.trim();
  if (!text) throw new Error(`invalid agent inheritance ${field}`);
  if (text.length > max) throw new Error(`agent inheritance ${field} is too long`);
  return text;
}

function normalizeOrigin(origin: AgentInheritanceOrigin | undefined): AgentInheritanceOrigin {
  if (!origin) return {};
  for (const [field, value] of Object.entries(origin)) {
    if (value !== undefined && !safeId(value)) throw new Error(`invalid agent inheritance ${field}`);
  }
  return {
    ...(origin.conversationId ? { conversationId: origin.conversationId } : {}),
    ...(origin.projectId ? { projectId: origin.projectId } : {}),
    ...(origin.workspaceId ? { workspaceId: origin.workspaceId } : {}),
  };
}

function normalizeGlossary(entries: AgentGlossaryEntry[] | undefined): AgentGlossaryEntry[] | undefined {
  if (entries === undefined) return undefined;
  if (!Array.isArray(entries)) throw new Error('invalid agent inheritance glossary');
  if (entries.length > MAX_GLOSSARY_ENTRIES) throw new Error('too many agent inheritance glossary entries');
  const seen = new Set<string>();
  const out: AgentGlossaryEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid agent inheritance glossary entry');
    const term = boundedText(entry.term, 'glossary term', MAX_TERM_LENGTH);
    const definition = boundedText(entry.definition, 'glossary definition', MAX_DEFINITION_LENGTH);
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, definition });
  }
  return out;
}

function normalizeMemoryRefs(refs: string[] | undefined): string[] | undefined {
  if (refs === undefined) return undefined;
  if (!Array.isArray(refs)) throw new Error('invalid agent inheritance memory refs');
  if (refs.length > MAX_MEMORY_REFS) throw new Error('too many agent inheritance memory refs');
  const out: string[] = [];
  for (const ref of refs) {
    if (!safeId(ref)) throw new Error('invalid agent inheritance memory ref');
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** 冻结一条资产的内容哈希。
 *
 *  哈希覆盖的是**投影时真正会被带走的那几个字段**——正文、标题、类型、作用域、
 *  版本。资产改了正文但版本没动（历史数据里存在这种记录），只比版本号发现不了；
 *  哈希对得上才敢说「这个 Agent 当初继承的就是现在这条」。 */
export function inheritedAssetContentHash(
  asset: Pick<RecallAbilityAssetRecord, 'type' | 'title' | 'statement' | 'scope' | 'version'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([asset.type, asset.title, asset.statement, asset.scope, asset.version]))
    .digest('hex')
    .slice(0, 32);
}

/** 挑出可继承的资产并冻结成引用，同时把没带走的记成明确的排除项。
 *
 *  只收 active 的：paused/archived 是用户主动收起，revoked/deleted/purged 是已撤销
 *  或已删除，出生时把它们带走等于让新 Agent 继承一条用户已经不认的判断。
 *
 *  **排除必须留痕**。少一条资产和从来没有过这条资产，在追溯页上长得一样，
 *  但对用户是两件事——「我记得我教过它这个」的答案就藏在这里。 */
function freezeAssetRefs(
  assets: RecallAbilityAssetRecord[],
  userExcluded: Set<string>,
): { inherited: CapabilityPackAssetRef[]; excluded: ExcludedInheritedAsset[] } {
  const inherited: CapabilityPackAssetRef[] = [];
  const excluded: ExcludedInheritedAsset[] = [];
  for (const asset of assets) {
    if (!asset || !safeId(asset.id)) continue;
    if (userExcluded.has(asset.id)) {
      excluded.push({ assetId: asset.id, reason: 'user_excluded' });
      continue;
    }
    if (asset.status !== 'active') {
      excluded.push({ assetId: asset.id, reason: asset.status });
      continue;
    }
    inherited.push({
      asset_id: asset.id,
      version: asset.version,
      content_hash: inheritedAssetContentHash(asset),
    });
    if (inherited.length > MAX_INHERITED_ASSETS) throw new Error('too many inherited assets');
  }
  return { inherited, excluded };
}

/** 一个 Agent 出生时最多带走多少条术语。超出的不带——术语表是给模型消歧用的，
 *  不是把整个本体塞进提示词。 */
const MAX_COLLECTED_GLOSSARY = 40;
/** 单条释义的取材上限，超出截断。 */
const COLLECTED_DEFINITION_LENGTH = 300;

/** 从一条流水条目里取出真正的内容。
 *
 *  `parseGroupContent` 对角色模板那种「只有骨架、没填内容」的文件不做结构解析，
 *  会把整份原文当成一条 entry 返回。直接拿来当释义，注入给 Agent 的就是一堆
 *  章节标题加模板元数据——比不给更糟，因为模型会把它当成真实定义去理解。
 *
 *  所以这里只留真正的内容行：剔掉 markdown 标题（`#`）与引用式模板元数据（`>`）。
 *  剔完为空说明这个分组用户还没填过东西，那它就是没有释义，整条不收。 */
function meaningfulEntryText(entry: unknown): string {
  return String(entry ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('>'))
    .join(' ')
    .trim();
}

/**
 * 从用户的个人本体分组采集术语表与记忆引用。
 *
 * 术语来自**用户自己定义过的**分组标题与字段，不做 LLM 抽取、不编造释义——
 * 一个 Agent 出生时该知道的「KSTAR 在这里指什么」，只能是用户已经写下来的那个
 * 意思，不能是模型现编的。取不到内容的分组直接跳过，不用标题硬凑一条空释义。
 *
 * 术语表存的是文本而非引用，这是 `memoryRefs` 那条「只记 id」纪律的**有意例外**：
 * 术语的价值正在于「出生那一刻它指什么」，跟着本体改动漂移就失去了消歧作用，
 * 与冻结资产版本是同一个道理。
 */
export async function collectAgentBirthContext(userId: string): Promise<{
  glossary: AgentGlossaryEntry[];
  memoryRefs: string[];
}> {
  const groupsFeature = await import('./personal_ontology_groups');
  let groups;
  try {
    groups = await groupsFeature.listGroups(userId);
  } catch {
    return { glossary: [], memoryRefs: [] };
  }

  const glossary: AgentGlossaryEntry[] = [];
  const memoryRefs: string[] = [];
  for (const group of groups) {
    if (!safeId(group.group_id)) continue;
    memoryRefs.push(group.group_id);
    if (glossary.length >= MAX_COLLECTED_GLOSSARY) continue;

    const term = typeof group.title === 'string' ? group.title.trim() : '';
    if (!term) continue;
    let definition = '';
    try {
      const content = await groupsFeature.readGroupContent(userId, group.group_id);
      if (content.ok && content.content) {
        const parsed = groupsFeature.parseGroupContent(content.content);
        const fieldParts = Object.entries(parsed.fields)
          .map(([field, values]) => `${field}：${values.map((v) => v.value).join('、')}`);
        const entryParts = parsed.entries.map(meaningfulEntryText).filter(Boolean);
        definition = [...fieldParts, ...entryParts].join('；').replace(/\s+/g, ' ').trim();
      }
    } catch {
      definition = '';
    }
    // 没有实际内容就不收——宁可术语表短，也不要一堆只有标题的空壳。
    if (!definition) continue;
    glossary.push({
      term,
      definition: definition.slice(0, COLLECTED_DEFINITION_LENGTH),
    });
  }

  return { glossary, memoryRefs };
}

export function agentInheritanceFile(userId: string, agentId: string): string {
  if (!safeId(agentId)) throw new Error('invalid agent id');
  return path.join(agentDir(userId, agentId), 'inheritance.json');
}

/** 纯函数：构建出生快照。不碰磁盘，方便调用方先预览再决定要不要落盘。 */
export function buildAgentInheritance(input: BuildAgentInheritanceInput): AgentInheritanceRecord {
  if (!safeId(input.agentId)) throw new Error('invalid agent id');
  const rolePrompt = boundedText(input.rolePrompt, 'role prompt', MAX_ROLE_PROMPT_LENGTH);
  const createdAt = boundedText(input.createdAt, 'created at', 64);
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('invalid agent inheritance created at');

  const userExcluded = input.excludedAssetIds === undefined
    ? undefined
    : normalizeMemoryRefs(input.excludedAssetIds);
  const { inherited, excluded } = freezeAssetRefs(input.assets || [], new Set(userExcluded || []));

  const glossary = normalizeGlossary(input.glossary);
  const memoryRefs = normalizeMemoryRefs(input.memoryRefs);

  return {
    schemaVersion: 2,
    agentId: input.agentId,
    inheritedAssets: inherited,
    ...(excluded.length ? { excludedAssets: excluded } : {}),
    rolePrompt,
    origin: normalizeOrigin(input.origin),
    ...(glossary?.length ? { glossary } : {}),
    ...(memoryRefs?.length ? { memoryRefs } : {}),
    createdAt,
  };
}

/** 落盘出生快照。已存在即拒绝——重复写意味着调用方把「出生」和「更新」搞混了。 */
export async function recordAgentInheritance(
  userId: string,
  input: BuildAgentInheritanceInput,
): Promise<AgentInheritanceRecord> {
  const record = buildAgentInheritance(input);
  const filePath = agentInheritanceFile(userId, record.agentId);
  return fileEditLock(filePath).runExclusive(async () => {
    try {
      await fs.access(filePath);
      throw new Error('agent inheritance already recorded');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await writeJson(filePath, record);
    return record;
  });
}

/** 把早先内嵌 capability pack 的 v1 记录读成现在的形状。
 *
 *  只在读取时转换，不回写磁盘：v1 只在被 revert 的那条分支上短暂存在过，
 *  为它写一条迁移落盘反而会让「出生快照一次写入」这条纪律出现例外。 */
function migrateLegacyRecord(record: Record<string, unknown>): Record<string, unknown> {
  if (record.schemaVersion !== 1 || record.inheritedAssets !== undefined) return record;
  const pack = record.capabilityPack as { assets?: Array<Record<string, unknown>> } | undefined;
  const assets = Array.isArray(pack?.assets) ? pack!.assets : [];
  return {
    ...record,
    schemaVersion: 2,
    inheritedAssets: assets
      .filter((ref) => typeof ref?.assetId === 'string' && typeof ref?.version === 'string')
      .map((ref) => ({
        asset_id: ref.assetId as string,
        version: ref.version as string,
        // v1 存的是 statementHash（只覆盖正文），语义比现在的 content_hash 窄，
        // 不搬过来冒充——宁可这条记录没有哈希，也不要一个对不上的哈希。
      })),
  };
}

/** 读出生快照。返回 null 表示这个 Agent 生成时还没有继承机制——
 *  调用方必须把它和「继承了空」区分开来展示。 */
export async function readAgentInheritance(
  userId: string,
  agentId: string,
): Promise<AgentInheritanceRecord | null> {
  const filePath = agentInheritanceFile(userId, agentId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('agent inheritance is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('agent inheritance is malformed');
  }
  const record = migrateLegacyRecord(parsed as Record<string, unknown>) as Partial<AgentInheritanceRecord>;
  if (
    record.agentId !== agentId ||
    typeof record.rolePrompt !== 'string' ||
    typeof record.createdAt !== 'string' ||
    !Array.isArray(record.inheritedAssets)
  ) throw new Error('agent inheritance is malformed');
  return record as AgentInheritanceRecord;
}

/** 列出该用户所有 Agent 的出生快照。
 *
 *  链路追溯要反查「这条资产进过哪些 Agent」，只能按 agentId 精确读是答不了的，
 *  所以扫一遍 agents 目录。没有继承记录的 Agent 直接跳过——
 *  它们在追溯里本来就不该出现。 */
export async function listAgentInheritance(userId: string): Promise<AgentInheritanceRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(userAgentsDir(userId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: AgentInheritanceRecord[] = [];
  for (const entry of entries) {
    if (!safeId(entry)) continue;
    try {
      const record = await readAgentInheritance(userId, entry);
      if (record) records.push(record);
    } catch {
      // 单条损坏不该让整个追溯页空白。
      continue;
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
