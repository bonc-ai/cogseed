/**
 * meeting_doc — 会议文档统一模型 `MeetingDocRef`（specs/013 · FR-010 / US-502）
 *
 * 是什么：三场景（纠错/纪要/待办）共用的**文档身份与快照索引**——标题、
 * 知识库文件版本信号（mtime）、最近纠错 run 锚点、说话人名单、场景标签。
 * 它**不是**文档正文的副本：正文永远在知识库里（`contexts.read` 是唯一读口），
 * 本模块只存 id/版本/名单/锚点（隐私边界，specs/013 D20）。
 *
 * 生命周期（research D3）：**惰性创建、无存量迁移**——首次对某文档产生落盘
 * 需求（打开纠错/引用面板）时才建；已存在则刷新（`createdAt` 不变）。
 * `docId` 沿用现有取值（锚点路径），不重新 id 化；文件名用确定性派生的
 * `docKey`（安全化 + 超长截断 + 短 hash，防路径注入，对齐
 * `cognition/review-decision.ts:85-89` 的既有做法）。
 *
 * 说话人为什么在主进程算：渲染层已被证明会漂（anchored-source-view 只认三段
 * 时钟导致 77% 内容不进 DOM 的事故），而 `parseTranscriptBlocks` 在主进程
 * （research D6）——所以 `input.text` 只进不出：现算完 speakers 即弃，绝不落盘。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../logger';
import { userMeetingDocsDir } from '../paths';
import { parseTranscriptBlocks } from './transcript_speaker_merge';

const log = createLogger('meeting-doc');

export const MEETING_DOC_SCHEMA_VERSION = 1;

/** `docId` 上限（IPC 契约 `contracts/ipc.md` §4：文本有界）。 */
export const MAX_DOC_ID_CHARS = 1000;
/** `title` 上限（对齐 `source-service.ts` 的标题上限）。 */
export const MAX_TITLE_CHARS = 120;
/** `sourceVersion` 上限（mtime 字符串化，留足余量）。 */
const MAX_SOURCE_VERSION_CHARS = 128;
/** 说话人名单上限（data-model §1.1）。 */
export const MAX_SPEAKERS = 50;
/** 单个说话人长度上限（data-model §1.1）。 */
const MAX_SPEAKER_CHARS = 60;
/** 场景标签上限（对齐 `ipc/transcript.ts` 的 `stringList(..., 20)`）。 */
export const MAX_SCENARIO_TAGS = 20;

/** 会议侧 schema 类错误（归因 schema：渲染层按码翻四语，不上屏英文原文）。 */
export class MeetingDocError extends Error {
  constructor(message: string, readonly code: 'invalid_doc_id' | 'invalid_input') {
    super(message);
    this.name = 'MeetingDocError';
  }
}

/** 最近一次纠错产物锚点（哪个 run、基于哪一版原文）。 */
export interface MeetingDocTranscript {
  runId: string;
  /** 原文 sha1（既有 transcript_correction_runs 的 before sha1）。 */
  beforeSha1: string;
  /** 清理版 sha1（未 apply 时缺失）。 */
  afterSha1?: string;
  at: string;
}

export interface MeetingDocRef {
  schemaVersion: 1;
  /** 原样保留的文档标识（= 锚点路径）。唯一键。 */
  docId: string;
  /** 展示用标题（文件名，≤120）。 */
  title: string;
  /** 知识库文件版本信号（mtime 字符串化）——判断"文档变了"用。 */
  sourceVersion: string;
  transcript?: MeetingDocTranscript;
  /** 说话人名单（主进程现算，去重保序，≤50）。无则缺省。 */
  speakers?: string[];
  /** 场景标签（来自既有 transcript_doc_tags，≤20）。无则缺省。 */
  scenarioTags?: string[];
  /** 降级原因（specs/013 T021 填写；本模块只建字段位）。 */
  degraded?: Array<'no_speakers' | 'no_scenario_tags' | 'no_transcript_run'>;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingDocInput {
  /** 缺省 true：缺失即惰性创建；false = 只读探测（缺失返回 null，不抛错）。 */
  create?: boolean;
  /** 展示标题（≤120；缺省从 docId 派生文件名）。 */
  title?: string;
  /** 知识库文件版本信号（mtime 字符串化）。 */
  sourceVersion?: string;
  /**
   * 转写正文——**只进不出**：仅供主进程现算 speakers（`parseTranscriptBlocks`），
   * 绝不落盘（记录里只有名单，没有正文）。
   */
  text?: string;
  /** 场景标签（≤20；空数组 = 无标签 → 字段缺省）。 */
  scenarioTags?: string[];
  /** 最近一次纠错 run 锚点。 */
  transcript?: MeetingDocTranscript;
}

/**
 * `docId` → 确定性 `docKey`：安全化（只留 `[A-Za-z0-9._-]`）+ 超长截断 +
 * 恒带 sha1 短 hash 后缀（安全化会把不同 docId 折成同一名，hash 兜住碰撞）。
 * 同一 `docId` 永远同一 `docKey`（幂等）；文件名用途，非用户可见标识。
 */
export function docKeyForDocId(docId: string): string {
  const digest = createHash('sha1').update(docId, 'utf8').digest('hex').slice(0, 10);
  let safe = docId.replace(/[^A-Za-z0-9._-]/g, '_');
  // `..` 虽已是单段的一部分（无分隔符不构成穿越），仍替换掉——路径注入的
  // 表面特征不该出现在文件名里，防误读误用。
  safe = safe.replace(/\.\.+/g, '__');
  if (safe.length > 80) safe = safe.slice(0, 80);
  // 首字符不得为点/下划线/横线：防隐藏文件与怪异前缀（保留名场景）。
  safe = safe.replace(/^[._-]+/, 'm');
  if (!safe) safe = 'doc';
  return `${safe}-${digest}`;
}

export function meetingDocFile(uid: string, docKey: string): string {
  return path.join(userMeetingDocsDir(uid), `${docKey}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 【specs/013 T021】降级如实标注：三种可判定缺失各自记名，不编造定位——
 *   no_speakers      —— 算不出说话人名单（无块头/正文不是转写块格式）
 *   no_scenario_tags —— 没有场景标签（"仅本场景"作用域无从谈起）
 *   no_transcript_run —— 该文档还没有任何纠错 run 锚点
 * 三者都齐 → 字段缺省（空数组不落盘）。只记"缺什么"，不猜"缺在哪/为什么缺"
 * （界面文案按码出"缺失说明"，不得编造说话人或定位）。
 */
export function degradedFlagsOf(doc: Pick<MeetingDocRef, 'speakers' | 'scenarioTags' | 'transcript'>): Array<'no_speakers' | 'no_scenario_tags' | 'no_transcript_run'> {
  const degraded: Array<'no_speakers' | 'no_scenario_tags' | 'no_transcript_run'> = [];
  if (!doc.speakers?.length) degraded.push('no_speakers');
  if (!doc.scenarioTags?.length) degraded.push('no_scenario_tags');
  if (!doc.transcript) degraded.push('no_transcript_run');
  return degraded;
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return Array.from(text).slice(0, max).join('');
}

/** 说话人现算：块头解析 → 去重保序 → ≤50 项、每项 ≤60；算不出名单则缺省。 */
export function computeSpeakers(text: string): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of parseTranscriptBlocks(String(text ?? ''))) {
    const speaker = String(block.speaker ?? '').trim().slice(0, MAX_SPEAKER_CHARS).trim();
    if (!speaker) continue;
    const key = speaker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(speaker);
    if (out.length >= MAX_SPEAKERS) break;
  }
  return out.length ? out : undefined;
}

function readDoc(uid: string, docId: string): MeetingDocRef | null {  const file = meetingDocFile(uid, docKeyForDocId(docId));
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MeetingDocRef>;
    if (!raw || typeof raw !== 'object' || raw.docId !== docId) return null;
    if (raw.schemaVersion !== MEETING_DOC_SCHEMA_VERSION) {
      // 记录版本不认识：如实报，不猜字段（data-model §3）。
      log.warn('meeting doc unknown schema version; treated as missing', { schemaVersion: raw.schemaVersion });
      return null;
    }
    return raw as MeetingDocRef;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') log.warn('meeting doc unreadable; treated as missing', { code });
    return null;
  }
}

function writeDoc(uid: string, doc: MeetingDocRef): void {
  const file = meetingDocFile(uid, docKeyForDocId(doc.docId));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 读/建/刷新统一文档模型。
 *
 * - 命中既有记录 → 按 `input` 刷新（`title`/`sourceVersion`/`transcript`/
 *   `speakers`/`scenarioTags` 只在**传入时**更新，`createdAt` 永不覆盖）；
 * - 缺失且 `create !== false` → 惰性创建；
 * - 缺失且 `create === false` → 返回 `null`（只读探测，不抛错）；
 * - 幂等：同一 `docId` 的 `docKey` 确定 ⇒ 永远同一文件，不产生第二条。
 */
export function getMeetingDoc(uid: string, docId: string, input: MeetingDocInput = {}): MeetingDocRef | null {
  const id = typeof docId === 'string' ? docId.trim() : '';
  if (!id || id.length > MAX_DOC_ID_CHARS) {
    throw new MeetingDocError('invalid meeting docId', 'invalid_doc_id');
  }
  if (input.create !== undefined && typeof input.create !== 'boolean') {
    throw new MeetingDocError('invalid meeting doc create flag', 'invalid_input');
  }

  const existing = readDoc(uid, id);
  const at = nowIso();

  // 刷新：只在调用方**传入**时覆盖对应字段（不传 = 保留既有值，不猜）。
  if (existing) {
    const next: MeetingDocRef = { ...existing, updatedAt: at };
    const title = bounded(input.title, MAX_TITLE_CHARS);
    if (title) next.title = title;
    const sourceVersion = bounded(input.sourceVersion, MAX_SOURCE_VERSION_CHARS);
    if (sourceVersion) next.sourceVersion = sourceVersion;
    if (input.transcript) {
      const runId = bounded(input.transcript.runId, 128);
      const beforeSha1 = bounded(input.transcript.beforeSha1, 128);
      if (runId && beforeSha1) {
        const afterSha1 = bounded(input.transcript.afterSha1, 128);
        next.transcript = { runId, beforeSha1, ...(afterSha1 ? { afterSha1 } : {}), at };
      }
    }
    if (typeof input.text === 'string') {
      const speakers = computeSpeakers(input.text);
      if (speakers) next.speakers = speakers;
      else delete next.speakers;
    }
    if (Array.isArray(input.scenarioTags)) {
      const tags = [...new Set(input.scenarioTags.map((t) => bounded(t, 64)).filter((t): t is string => !!t))].slice(0, MAX_SCENARIO_TAGS);
      if (tags.length) next.scenarioTags = tags;
      else delete next.scenarioTags;
    }
    // 【specs/013 T021】刷新时按最终字段重算降级标注（写前一刻的状态，如实）。
    const degradedRefresh = degradedFlagsOf(next);
    if (degradedRefresh.length) next.degraded = degradedRefresh;
    else delete next.degraded;
    writeDoc(uid, next);
    return next;
  }

  if (input.create === false) return null;

  const fallbackTitle = (id.split('/').pop() || id).trim();
  const created: MeetingDocRef = {
    schemaVersion: MEETING_DOC_SCHEMA_VERSION,
    docId: id,
    title: bounded(input.title, MAX_TITLE_CHARS) || bounded(fallbackTitle, MAX_TITLE_CHARS) || '未命名会议文档',
    sourceVersion: bounded(input.sourceVersion, MAX_SOURCE_VERSION_CHARS) || '',
    createdAt: at,
    updatedAt: at,
  };
  if (input.transcript) {
    const runId = bounded(input.transcript.runId, 128);
    const beforeSha1 = bounded(input.transcript.beforeSha1, 128);
    if (runId && beforeSha1) {
      const afterSha1 = bounded(input.transcript.afterSha1, 128);
      created.transcript = { runId, beforeSha1, ...(afterSha1 ? { afterSha1 } : {}), at };
    }
  }
  if (typeof input.text === 'string') {
    const speakers = computeSpeakers(input.text);
    if (speakers) created.speakers = speakers;
  }
  if (Array.isArray(input.scenarioTags)) {
    const tags = [...new Set(input.scenarioTags.map((t) => bounded(t, 64)).filter((t): t is string => !!t))].slice(0, MAX_SCENARIO_TAGS);
    if (tags.length) created.scenarioTags = tags;
  }
  // 【specs/013 T021】创建时同样落降级标注（缺失要在界面上有说明，不静默）。
  const degradedCreated = degradedFlagsOf(created);
  if (degradedCreated.length) created.degraded = degradedCreated;
  writeDoc(uid, created);
  return created;
}

/** 只读列一份文档清单（docKey 反查 docId 用；不做索引，单用户量级直扫）。 */
export function listMeetingDocs(uid: string): MeetingDocRef[] {
  try {
    const names = fs.readdirSync(userMeetingDocsDir(uid));
    const out: MeetingDocRef[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(userMeetingDocsDir(uid), name), 'utf8')) as Partial<MeetingDocRef>;
        if (raw && raw.schemaVersion === MEETING_DOC_SCHEMA_VERSION && typeof raw.docId === 'string') {
          out.push(raw as MeetingDocRef);
        }
      } catch {
        // 单文件损坏不拖垮清单（对齐 listRecentReviewDecisions 的容错口径）
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  } catch {
    return [];
  }
}
