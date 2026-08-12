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
 *  2. **带引用，不搬正文**。项目、会话、记忆都只记 id。正文会变，复制一份
 *     就等于在 Agent 目录下埋了一份悄悄过期的影子副本。
 *     唯一的例外是认知资产——它走能力包，本来就要冻结版本与内容哈希。
 *  3. **缺失就是缺失**。没有术语表就不写空数组式的假承诺；
 *     `readAgentInheritance` 对老 Agent 返回 null，调用方必须显式处理
 *     「这个 Agent 生成时还没有继承机制」，不能假装它继承了空。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { agentDir } from '../paths';
import { safeId, writeJson } from '../storage';
import { fileEditLock } from '../util/locks';
import {
  buildCapabilityPack,
  type MinimumCapabilityPack,
} from './p3394/capability-pack';
import type { RecallAbilityAssetRecord } from './recall/candidate-service';

const MAX_ROLE_PROMPT_LENGTH = 8_000;
const MAX_GLOSSARY_ENTRIES = 200;
const MAX_TERM_LENGTH = 200;
const MAX_DEFINITION_LENGTH = 1_000;
const MAX_MEMORY_REFS = 200;
/** 出生能力包的有效期。Agent 的继承不是一次限时授权，但能力包 schema 要求
 *  必须有有效期，这里给一个远期上界，语义是「随 Agent 长期有效」。 */
const INHERITANCE_PACK_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface AgentGlossaryEntry {
  term: string;
  definition: string;
}

export interface AgentInheritanceOrigin {
  conversationId?: string;
  projectId?: string;
  workspaceId?: string;
}

export interface AgentInheritanceRecord {
  schemaVersion: 1;
  agentId: string;
  /** 出生时冻结的认知资产（含版本与内容哈希）。 */
  capabilityPack: MinimumCapabilityPack;
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

/** 一个 Agent 出生时最多带走多少条术语。超出的不带——术语表是给模型消歧用的，
 *  不是把整个本体塞进提示词。 */
const MAX_COLLECTED_GLOSSARY = 40;
/** 单条释义的取材上限，超出截断。 */
const COLLECTED_DEFINITION_LENGTH = 300;

/**
 * 从用户的个人本体分组采集术语表与记忆引用。
 *
 * 术语来自**用户自己定义过的**分组标题与字段，不做 LLM 抽取、不编造释义——
 * 一个 Agent 出生时该知道的「KSTAR 在这里指什么」，只能是用户已经写下来的那个
 * 意思，不能是模型现编的。取不到内容的分组直接跳过，不用标题硬凑一条空释义。
 *
 * 术语表存的是文本而非引用，这是 `memoryRefs` 那条「只记 id」纪律的**有意例外**：
 * 术语的价值正在于「出生那一刻它指什么」，跟着本体改动漂移就失去了消歧作用，
 * 与能力包冻结资产版本是同一个道理。
 */
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
  const expiresAt = new Date(Date.parse(createdAt) + INHERITANCE_PACK_TTL_MS).toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('invalid agent inheritance created at');

  const capabilityPack = buildCapabilityPack({
    packId: `pack-agent-${input.agentId}`,
    purpose: `agent ${input.agentId} inheritance`,
    targetAgent: input.agentId,
    frozenAt: createdAt,
    expiresAt,
    assets: input.assets,
    ...(input.excludedAssetIds ? { userExcludedAssetIds: input.excludedAssetIds } : {}),
  });

  const glossary = normalizeGlossary(input.glossary);
  const memoryRefs = normalizeMemoryRefs(input.memoryRefs);

  return {
    schemaVersion: 1,
    agentId: input.agentId,
    capabilityPack,
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

/** 列出该用户所有 Agent 的出生快照。
 *
 *  链路追溯要反查「这条资产进过哪些 Agent 的能力包」，只能按 agentId 精确读
 *  是答不了的，所以扫一遍 agents 目录。没有继承记录的 Agent 直接跳过——
 *  它们在追溯里本来就不该出现。 */
export async function listAgentInheritance(userId: string): Promise<AgentInheritanceRecord[]> {
  const agentsRoot = path.dirname(agentDir(userId, 'placeholder'));
  let entries: string[];
  try {
    entries = await fs.readdir(agentsRoot);
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
  const record = parsed as Partial<AgentInheritanceRecord>;
  if (
    record.agentId !== agentId ||
    typeof record.rolePrompt !== 'string' ||
    typeof record.createdAt !== 'string' ||
    !record.capabilityPack ||
    typeof record.capabilityPack !== 'object'
  ) throw new Error('agent inheritance is malformed');
  return record as AgentInheritanceRecord;
}
