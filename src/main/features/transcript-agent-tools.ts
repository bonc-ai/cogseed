/**
 * 转写纠错词表 · agent 工具（会议流程的"转写 → 纠错"那一步）
 *
 * 为什么需要这个模块：纠错引擎（`features/transcript_*`）在企业端**已经完整存在**，
 * 但它此前只作为 `ipc/transcript.ts` 的 33 条通道暴露给**纠错面板**。面板是人点的，
 * agent 调不到。而会议工作流要求的是：
 *
 *   触发 → 取转写 → **纠错** → **核对新词回写词表** → 生成纪要 → 用户确认 → 形成任务
 *
 * 加粗的两步必须由 agent 在流程里主动执行，所以把已有引擎包成 agent 工具。
 * **本模块不含任何纠错算法**——只做参数校验、调用 features、把结果整理成
 * 模型可读的文本。算法与护栏（风险下限、词边界、语境黑白名单、作用域、
 * 台账）全部仍在 features 层，改规则请改那边，不要在这里加判断。
 *
 * 本模块是主进程中的共享执行接缝：SDK 兼容导出与 Runtime host adapter 都调用它。
 * 不依赖 SDK 执行器，不自建词表路径；存储仍经 transcript_glossary 的公开函数。
 *
 * ── 与"用户确认"的关系（本模块最重要的一件事）────────────────────────────
 * `applyCorrections` 的默认接受面是 `['low', 'medium']`，`high` **一律不应用**。
 * 这不是本模块的选择，是引擎既有语义：折叠后 ≤2 字的中文错形必然落在某个真实词
 * 内部（`健全` 在 `生态健全度` 里是真的），所以派生为 `high` 且要求人工确认。
 * 实测事故：出厂种子把「我们要建立健全的机制」改成了「建立鉴权的机制」。
 *
 * 因此本工具的契约是：
 *   - `transcript_glossary_apply` 返回 `status: 'applied'` → 可以继续生成纪要；
 *   - 返回 `status: 'draft'` 且 `pendingConfirm` 非空 → **必须先向用户确认**，
 *     不得径自生成纪要。确认后用 `transcript_glossary_upsert` 回写词表。
 * 这条"未确认不得继续"是引擎算出来的（`pendingTotal`），不是提示词里的君子协定。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathAllowed } from '../util/path-sandbox';
import { writeTextAtomicSync } from '../storage';
import { GLOSSARY_KINDS, TRANSCRIPT_TOOL_DEFINITIONS, type TranscriptToolResult, type TranscriptTool } from './transcript-tool-contract';
import { createLogger } from '../logger';
import * as transcriptGlossary from './transcript_glossary';
import * as transcriptAutoCorrect from './transcript_auto_correct';
import * as transcriptScanCombined from './transcript_scan_combined';
import type { GlossaryKind, RiskLevel } from './transcript_glossary';
import { transcriptScanKey, readTranscriptScan, saveTranscriptScan, persistTranscriptScan } from './transcript-scan-state';
import {
  buildConfirmItems,
  consumeGlossaryConfirmation,
  createGlossaryConfirmation,
  findResolvedGlossaryConfirmation,
} from './transcript-confirmation';

const log = createLogger('transcript-glossary-tools');

/** 与 `ipc/transcript.ts` 同源上限：转写正文上限，防止模型灌入超长文本。 */
const MAX_TRANSCRIPT_CHARS = 400_000;
/** 工具返回给模型的行数上限（超出的只报数量，避免撑爆上下文）。 */
const MAX_LISTED = 60;
/** 单条候选上下文预览长度。 */
const CONTEXT_PREVIEW = 60;
/** 一次 scan 允许的候选上限（口癖规则包会让候选量级上升，必须有界）。 */
const MAX_CANDIDATES = 1000;
/** 一张确认卡片最多问几条：卡片是给人点的，超过这个数量人就闭眼全选了。 */
const MAX_CONFIRM_ITEMS = 40;

/**
 * `TranscriptTool` 之上多一个实现体方法：`execute` 只做错误包装（见 `guarded`），
 * 真正的逻辑在 `executeImpl`。这样接口对 core-agent 仍然只是 `TranscriptTool`。
 */
type GlossaryToolWithImpl = TranscriptTool & {
  executeImpl(input: Record<string, unknown>): Promise<TranscriptToolResult>;
};

export interface TranscriptGlossaryToolsOpts {
  agentId?: string;
  taskId?: string;
  /** 词表属主。工具的生命周期内固定（与 kb-tools 同约定）。 */
  userId: string;
  /** 当前会话 id：确认卡片据此挂到正确的对话容器。 */
  cid?: string;
  /** 当前 actor turn：渲染层据此把同一轮的多张卡片合并。 */
  turnId?: string;
  /** Task workspace roots. Present only on the Runtime host path; without it
   * transcripts must be passed as `text`. */
  files?: TranscriptFileAccess;
}

export interface TranscriptFileAccess {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  workingDir?: string;
}

/** 转写文件上限：与 MAX_TRANSCRIPT_CHARS 同量级（UTF-8 中文按 3 字节估）。 */
const MAX_TRANSCRIPT_FILE_BYTES = MAX_TRANSCRIPT_CHARS * 3;

interface TranscriptSource {
  text: string;
  docId: string;
  /** The `path` input as passed: the gate's identity for a file source. */
  source?: string;
  file?: string;
}

/** Sandbox entry for every file the transcript tools touch. Relative paths are
 * resolved against the task working directory. */
function resolveWorkspacePath(raw: unknown, field: string, roots: readonly string[], workingDir?: string): string {
  const value = asString(raw, field, 1000);
  const abs = path.isAbsolute(value) ? path.normalize(value) : workingDir ? path.resolve(workingDir, value) : '';
  if (!abs) throw new Error(`${field} must be an absolute path`);
  if (!isPathAllowed(abs, roots)) throw new Error(`${field} is outside the task workspace`);
  return abs;
}

/** Read the transcript once on the host: the model passes a path, never a
 * retyped copy, and the document id is derived from the file, not guessed. */
function loadTranscriptSource(input: Record<string, unknown>, files: TranscriptFileAccess | undefined): TranscriptSource {
  const hasPath = input.path !== undefined && input.path !== null && input.path !== '';
  if (!hasPath) {
    return { text: asString(input.text, 'text', MAX_TRANSCRIPT_CHARS), docId: asString(input.docId, 'docId', 200) };
  }
  if (input.text !== undefined && input.text !== null && input.text !== '') throw new Error('pass either path or text, not both');
  if (!files) throw new Error('path input needs a task workspace; pass the transcript as text instead');
  const file = resolveWorkspacePath(input.path, 'path', [...files.readRoots, ...files.writeRoots], files.workingDir);
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { throw new Error('path does not exist'); }
  if (!stat.isFile()) throw new Error('path is not a file');
  if (stat.size > MAX_TRANSCRIPT_FILE_BYTES) throw new Error('transcript file is too large');
  return {
    text: asString(fs.readFileSync(file, 'utf8'), 'transcript file content', MAX_TRANSCRIPT_CHARS),
    docId: path.basename(file, path.extname(file)),
    source: String(input.path).trim(),
    file,
  };
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Scan-time outputs: validate where the corrected file will go and save the
 * raw transcript immediately, so no copy ever passes through write_file. */
function scanOutputs(input: Record<string, unknown>, files: TranscriptFileAccess | undefined, src: TranscriptSource): {
  outputPath?: string; rawPath?: string; lines: string[];
} {
  if (isBlank(input.outputPath) && isBlank(input.rawOutputPath)) return { lines: [] };
  if (!files) throw new Error('outputPath needs a task workspace');
  const outputPath = isBlank(input.outputPath) ? undefined
    : resolveWorkspacePath(input.outputPath, 'outputPath', files.writeRoots, files.workingDir);
  if (outputPath && src.file && path.resolve(outputPath) === path.resolve(src.file)) throw new Error('outputPath must not overwrite the source transcript');
  const raw = isBlank(input.rawOutputPath) ? { notes: [] as string[] }
    : writeApplyOutputs({ rawOutputPath: input.rawOutputPath }, files, src, undefined);
  return {
    ...(outputPath ? { outputPath } : {}),
    ...(raw.rawPath ? { rawPath: raw.rawPath } : {}),
    lines: [
      ...(raw.rawPath ? [`raw_path: ${raw.rawPath} (raw transcript saved; do not write it again)`] : []),
      ...raw.notes,
      ...(outputPath ? [`corrected transcript will be written to ${outputPath} once applied.`] : []),
    ],
  };
}

/** Host-side writes for a fully applied correction, so the model never has to
 * reproduce the transcript through write_file. */
function writeApplyOutputs(input: Record<string, unknown>, files: TranscriptFileAccess | undefined, src: TranscriptSource,
  corrected: string | undefined): { correctedPath?: string; rawPath?: string; notes: string[] } {
  const notes: string[] = [];
  const wantsOutput = !!src.file || (input.outputPath !== undefined && input.outputPath !== '');
  const wantsRaw = input.rawOutputPath !== undefined && input.rawOutputPath !== '';
  if (!wantsOutput && !wantsRaw) return { notes };
  if (!files) throw new Error('outputPath needs a task workspace');
  const writable = (candidate: string) => isPathAllowed(candidate, files.writeRoots);
  let rawPath: string | undefined;
  if (wantsRaw) {
    rawPath = resolveWorkspacePath(input.rawOutputPath, 'rawOutputPath', files.writeRoots, files.workingDir);
    const same = src.file && path.resolve(rawPath) === path.resolve(src.file);
    const existing = !same && fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : undefined;
    if (same || existing?.trim() === src.text) { /* already saved verbatim */ }
    else if (existing !== undefined) { notes.push(`raw transcript NOT saved: ${rawPath} already exists with different content.`); rawPath = undefined; }
    else writeTextAtomicSync(rawPath, src.file ? fs.readFileSync(src.file) : src.text);
  }
  let correctedPath: string | undefined;
  if (wantsOutput && corrected !== undefined) {
    if (input.outputPath !== undefined && input.outputPath !== '') {
      correctedPath = resolveWorkspacePath(input.outputPath, 'outputPath', files.writeRoots, files.workingDir);
    } else {
      const name = `${path.basename(src.file!, path.extname(src.file!))}.corrected${path.extname(src.file!) || '.md'}`;
      const sibling = path.join(path.dirname(src.file!), name);
      correctedPath = writable(sibling) ? sibling
        : files.workingDir && writable(path.join(files.workingDir, name)) ? path.join(files.workingDir, name) : undefined;
      if (!correctedPath) throw new Error('no writable location for the corrected transcript; pass outputPath');
    }
    if (src.file && path.resolve(correctedPath) === path.resolve(src.file)) throw new Error('outputPath must not overwrite the source transcript');
    writeTextAtomicSync(correctedPath, corrected);
  }
  return { ...(correctedPath ? { correctedPath } : {}), ...(rawPath ? { rawPath } : {}), notes };
}

function asString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must not be empty`);
  if (trimmed.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return trimmed;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asString(value, field, max);
}

function clip(text: string, max: number): string {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function correctionEvidence(text: string, docId: string, state: NonNullable<TranscriptToolResult['correction']>['state'], source?: string) {
  return { state, docId, sourceHash: createHash('sha256').update(text).digest('hex'), ...(source ? { source } : {}) };
}

/** 一行候选：给模型看的形态（含风险等级与上下文，供它向用户解释"为什么改"). */
function candidateLine(c: transcriptAutoCorrect.CorrectionCandidate): string {
  const via = c.fromModel ? 'model' : 'glossary';
  const action = c.action === 'delete' ? `删除「${c.wrong}」` : `「${c.wrong}」→「${c.correct}」`;
  const flags = [
    `risk=${c.riskLevel}`,
    `via=${via}`,
    c.ignoredCount > 0 ? `ignored=${c.ignoredCount}` : '',
    c.contextAllow.length > 0 ? `allow=[${c.contextAllow.join(',')}]` : '',
  ].filter(Boolean).join(' ');
  return `- ${action} @${c.span.start} (${flags}) 语境: ${clip(c.context, CONTEXT_PREVIEW)}`;
}

function errorResult(code: string, message: string): { content: string; isError: true } {
  return { content: `[${code}] ${message}`, isError: true };
}

/**
 * 把工具执行包成"永不抛"的 `ToolResult`。
 *
 * 为什么必须包：`asString` 这类输入校验会抛错。工具直接抛出去，模型拿到的是一次
 * 失败的工具调用而不是可读的纠正提示，它往往会原样重试同一个坏参数。转成
 * `isError: true` 的文本后，模型能读到「correct must be a string」并自我纠正。
 */
async function guarded(
  fn: () => Promise<TranscriptToolResult>,
): Promise<TranscriptToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('transcript glossary tool failed', { message });
    return errorResult('invalid_input', message);
  }
}

/**
 * 词表工具集。
 *
 * 注入时机：与 kb-tools 相同（主会话每次注入；`uid` 未知或工具被禁用时不注入）。
 */
export function createTranscriptGlossaryTools(opts: TranscriptGlossaryToolsOpts): TranscriptTool[] {
  const { userId } = opts;

  const scanTool: TranscriptTool & GlossaryToolWithImpl = {
    name: 'transcript_glossary_scan',
    // 只读：扫一遍不改任何东西，可与相邻只读工具并发。
    executionMode: 'parallel',
    description:
      TRANSCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'transcript_glossary_scan')!.description,
    inputSchema: TRANSCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'transcript_glossary_scan')!.inputSchema,
    async execute(input) {
      return guarded(() => this.executeImpl(input));
    },
    async executeImpl(input) {
      const src = loadTranscriptSource(input, opts.files);
      const { text, docId } = src;
      const evidenceFor = (state: NonNullable<TranscriptToolResult['correction']>['state']) =>
        correctionEvidence(text, docId, state, src.source);
      const scanKey = transcriptScanKey(userId, opts.cid, docId, text, input);
      // Save the raw transcript now (the gate allows nothing else to write
      // before correction) and remember where apply should write its outputs.
      const outputs = scanOutputs(input, opts.files, src);
      const remember = (state: import('./transcript-scan-state').TranscriptScanState) => {
        if (outputs.outputPath) state.outputPath = outputs.outputPath;
        if (outputs.rawPath) state.rawOutputPath = outputs.rawPath;
        if (outputs.outputPath || outputs.rawPath) persistTranscriptScan(scanKey, state);
      };
      const prior = readTranscriptScan(scanKey);
      if (prior && !prior.blocked) {
        remember(prior);
        return { content: ['Reusing the exact scanned candidates for this transcript. Call transcript_glossary_apply to apply them or show the pending confirmation card.',
          ...outputs.lines].join('\n'),
          correction: evidenceFor('scanned') };
      }
      const scenarioTags = Array.isArray(input.scenarioTags)
        ? input.scenarioTags.filter((t): t is string => typeof t === 'string' && !!t.trim())
        : undefined;

      const entries = transcriptGlossary.listEntries(userId, { status: 'active' });
      if (!entries.length) {
        return {
          content:
            'Correction glossary is EMPTY for this user — nothing to scan.\n'
            + 'Call `transcript_glossary_upsert` to seed the team\'s people and proper nouns first,'
            + ' or ask the user to confirm them.',
        };
      }

      /**
       * 扫描：默认走「规则 + 召回 + AI 复核」三路合一的共享接缝；
       * `includeReview: false` 时退回纯规则（同步、零成本、零依赖）。
       *
       * 为什么默认开 AI：纠错的目标是准确。ASR 错形是**开放集**，纯查表必然漏
       * （`roadmap` 这类音不近形不近的错写，任何字符串相似度都兜不住）。
       * 为了省钱而不跑，等于把准确率让掉。
       *
       * 保留纯规则路径是为了"我现在就要规则结果"的场景，以及让"关掉后行为与
       * 历史完全一致"可以被逐字核对。
       */
      const wantReview = input.includeReview !== false;
      let ruleScan: transcriptAutoCorrect.ScanResult;
      let candidates: transcriptAutoCorrect.CorrectionCandidate[];
      let review = null as Awaited<ReturnType<typeof transcriptScanCombined.scanTranscriptCombined>>['review'];
      let byChannel: { exact: number; recall: number; model: number } | null = null;

      if (wantReview) {
        const combined = await transcriptScanCombined.scanTranscriptCombined(userId, text, {
          docId,
          ...(scenarioTags && scenarioTags.length ? { scenarioTags } : {}),
          includeDelete: input.includeDelete === true,
          includeRecall: true,
          includeReview: true,
          maxCandidates: MAX_CANDIDATES,
        });
        ruleScan = combined.ruleScan;
        candidates = combined.candidates;
        review = combined.review;
        byChannel = combined.stats.byChannel;
      } else {
        ruleScan = transcriptAutoCorrect.scanText(text, entries, {
          docId,
          ...(scenarioTags && scenarioTags.length ? { scenarioTags } : {}),
          includeDelete: input.includeDelete === true,
          maxCandidates: MAX_CANDIDATES,
        });
        candidates = ruleScan.candidates;
      }

      const scan = ruleScan;
      const auto = candidates.filter((c) => c.riskLevel !== 'high' && c.fromModel !== true
        && !(c.channel === 'recall' && c.disposition === 'review'));
      const needsConfirm = candidates.filter((c) => c.fromModel !== true
        && (c.riskLevel === 'high' || (c.channel === 'recall' && c.disposition === 'review')));
      // 模型来源单独成段：它们既不是"可自动应用"，也不是"高危待确认"，
      // 而是"AI 提议、必须逐条人工拍板"的第三类。
      const modelRows = candidates.filter((c) => c.fromModel === true);

      const lines: string[] = [
        `Scanned with ${scan.stats.entriesScanned} active glossary entries.`,
        `Candidates: ${candidates.length} (auto-applicable ${auto.length}, needs-confirmation ${needsConfirm.length},`
        + ` from-model ${modelRows.length}, denied-by-context ${scan.stats.denied}).`,
      ];
      if (scan.stats.nameRosterSkipped) {
        // 口径可见：词表里"左右一样"的名册条目不参与替换扫描，否则用户以为丢了词条。
        lines.push(`Note: ${scan.stats.nameRosterSkipped} name-roster entr${scan.stats.nameRosterSkipped === 1 ? 'y' : 'ies'} skipped (wrong === correct; nothing to replace).`);
      }
      if (scan.stats.truncated) {
        // 截断必须可见，否则模型会以为"就这么多"。
        lines.push(`WARNING: candidate list was TRUNCATED at ${MAX_CANDIDATES}; more matches may exist.`);
      }

      if (auto.length) {
        lines.push('', '## Auto-applicable (risk=low|medium)');
        for (const c of auto.slice(0, MAX_LISTED)) lines.push(candidateLine(c));
        if (auto.length > MAX_LISTED) lines.push(`... ${auto.length - MAX_LISTED} more.`);
      }

      if (modelRows.length) {
        lines.push(
          '',
          '## Proposed by model review (NEVER auto-applied — the user must tick each one)',
          'These were proposed by a model reading the text, not matched against the glossary.',
          '`transcript_glossary_apply` will NOT apply them on its own. Show them to the user and let',
          'them confirm; only then do they take effect.',
        );
        for (const c of modelRows.slice(0, MAX_LISTED)) lines.push(candidateLine(c));
        if (modelRows.length > MAX_LISTED) lines.push(`... ${modelRows.length - MAX_LISTED} more.`);
      }

      if (review) {
        // AI 这一路的执行情况**必须如实透出**：没跑要说没跑，跑了一半要说跑了一半。
        const parts = [
          `chunks ${review.chunksScanned}/${review.chunksTotal}`,
          `known-targets ${review.knownCount}`,
        ];
        if (review.skipped) parts.push(`SKIPPED=${review.skipped}`);
        if (review.truncated) parts.push('TRUNCATED (text not fully reviewed)');
        if (review.failedChunks) parts.push(`failed-chunks ${review.failedChunks} (results may be incomplete)`);
        if (review.rejected) parts.push(`rejected ${review.rejected}`);
        if (review.outsideAllowlist) parts.push(`outside-known-list ${review.outsideAllowlist}`);
        lines.push('', `Model review: ${parts.join(' · ')}`);
        if (review.skipped === 'no_model') {
          lines.push('(No model is configured for this user, so review did not run. Rule + recall results above are complete.)');
        } else if (review.skipped === 'model_failed') {
          lines.push('(Model review failed. Rule + recall results above are unaffected and complete.)');
        }
      }

      if (byChannel) {
        lines.push(`By channel: exact ${byChannel.exact} · recall ${byChannel.recall} · model ${byChannel.model}.`);
      }

      if (needsConfirm.length) {
        lines.push(
          '',
          '## Needs user confirmation (risk=high) — NOT applied by apply',
          'These are two-character Chinese forms or common words: the same characters are often',
          'correct in context. Ask the user one by one before using them.',
        );
        for (const c of needsConfirm.slice(0, MAX_LISTED)) lines.push(candidateLine(c));
        if (needsConfirm.length > MAX_LISTED) lines.push(`... ${needsConfirm.length - MAX_LISTED} more.`);
      }

      const denied = scan.denied.filter((d) => d.reason === 'context_denied').slice(0, 10);
      if (denied.length) {
        lines.push('', '## Blocked by context blacklist (not applied, informational only)');
        for (const d of denied) lines.push(`- 「${d.wrong}」 blocked by 「${d.deniedBy ?? '?'}」`);
      }

      lines.push(
        '',
        src.source
          ? `Next: call \`transcript_glossary_apply\` with the same path (${src.source}) to produce the corrected`
          : 'Next: call `transcript_glossary_apply` with the same text + docId to produce the corrected',
        'transcript. Then confirm any pending items with the user and write accepted new terms via',
        '`transcript_glossary_upsert` before generating minutes.',
      );

      const blocked = !!(scan.stats.truncated || review?.skipped || review?.truncated || review?.failedChunks);
      const snapshot = saveTranscriptScan(scanKey, candidates, blocked);
      remember(snapshot);
      lines.push(...outputs.lines);
      // A scan may be the last tool of this turn. Publish the actual choices
      // before returning a pending state; never rely on another model turn to
      // invent or rediscover what the human must confirm.
      const confirmationItems = !blocked && modelRows.length
        ? buildConfirmItems(candidates.filter(c => c.fromModel || c.riskLevel === 'high'
          || (c.channel === 'recall' && c.disposition === 'review')), MAX_CONFIRM_ITEMS) : [];
      if (confirmationItems.length) {
        const card = await createGlossaryConfirmation({
          agentId: opts.agentId, taskId: opts.taskId, userId, text, docId, items: confirmationItems,
          ...(opts.cid ? { cid: opts.cid } : {}), ...(opts.turnId ? { turnId: opts.turnId } : {}) });
        snapshot.confirmationToken = card.token;
        persistTranscriptScan(scanKey, snapshot);
        lines.push('', card.visible ? 'The confirmation card is visible. Wait for the user to submit it.'
          : 'The card was not acknowledged as visible. Show the pending candidates in the reply.',
        `confirmation_token: ${card.token}`);
      }
      return {
        content: lines.join('\n'),
        correction: { ...evidenceFor(blocked ? 'blocked'
          : confirmationItems.length ? 'needs_confirmation' : 'scanned'),
          ...(confirmationItems.length ? { confirmationItems } : {}) },
      };
    },
  };

  const applyTool: TranscriptTool & GlossaryToolWithImpl = {
    name: 'transcript_glossary_apply',
    // 无副作用（纯文本变换），但会产出流程依赖的结果；仍标 sequential 以保持
    // 与 scan 的先后可读性（apply 必须在 scan 语义之后）。
    executionMode: 'sequential',
    description:
      TRANSCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'transcript_glossary_apply')!.description,
    inputSchema: TRANSCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'transcript_glossary_apply')!.inputSchema,
    async execute(input) {
      return guarded(() => this.executeImpl(input));
    },
    async executeImpl(input) {
      const src = loadTranscriptSource(input, opts.files);
      const { text, docId } = src;
      const evidenceFor = (state: NonNullable<TranscriptToolResult['correction']>['state']) =>
        correctionEvidence(text, docId, state, src.source);
      const scenarioTags = Array.isArray(input.scenarioTags)
        ? input.scenarioTags.filter((t): t is string => typeof t === 'string' && !!t.trim())
        : undefined;

      const rawLevels = Array.isArray(input.acceptRiskLevels) ? input.acceptRiskLevels : undefined;
      const levels: RiskLevel[] = rawLevels
        ? rawLevels.filter((l): l is RiskLevel => l === 'low' || l === 'medium' || l === 'high')
        : ['low', 'medium'];
      if (!levels.length) {
        return errorResult('invalid_input', 'acceptRiskLevels must contain at least one of low|medium|high');
      }

      // 用户点选卡片的回执：有 token 就按"用户勾了哪些"逐条应用。
      // `acceptedIds` 一旦提供就**完全取代**风险等级过滤，所以未被勾选的 high
      // 不会因为顺手放开了 high 而被改掉——这正是要逐条确认的意义。
      const scanKey = transcriptScanKey(userId, opts.cid, docId, text, input);
      const snapshot = readTranscriptScan(scanKey);
      if (snapshot?.blocked) return { content: 'The scan was incomplete. Scan this transcript successfully before applying corrections.',
        correction: evidenceFor('blocked') };
      const explicitToken = optionalString(input.confirmation_token, 'confirmation_token', 200);
      // Idempotent replay: this exact source was already fully applied and the
      // user has not made a new decision since. Re-running the rules here used
      // to return a *second* draft with the previously-decided high-risk items,
      // which the model then reported as "still pending" — a confusing loop
      // that cost a whole extra model round. Return the receipt instead.
      const receipt = snapshot?.appliedReceipt;
      if (receipt
        && !explicitToken
        && !snapshot?.confirmationToken
        && receipt.textSha256 === createHash('sha256').update(text).digest('hex')) {
        const changed = receipt.entries.slice(0, MAX_LISTED).map((entry) =>
          `- 「${entry.wrong}」→「${entry.correct}」 ×${entry.count}`);
        const lines = [
          'status: applied',
          `applied: ${receipt.appliedTotal} replacement(s) across ${receipt.entries.length} entr${receipt.entries.length === 1 ? 'y' : 'ies'}; already applied for this exact source`,
          'This correction was already applied in this Agent session. Do not scan or apply it again; continue with the next step.',
        ];
        if (changed.length) lines.push('', '## What changed', ...changed);
        if (receipt.rawPath) lines.push('', `raw_path: ${receipt.rawPath}`);
        if (receipt.correctedPath) {
          lines.push(`corrected_path: ${receipt.correctedPath}`,
            'The corrected transcript is saved there. Use that file; do not rewrite it with write_file.');
        }
        return { content: lines.join('\n'), correction: evidenceFor('applied') };
      }
      const confirmationToken = explicitToken
        ?? (snapshot ? snapshot.confirmationToken : findResolvedGlossaryConfirmation(userId, opts.cid, docId, text));
      if (snapshot && confirmationToken && confirmationToken !== snapshot.confirmationToken) {
        return errorResult('confirmation_stale', 'The confirmation belongs to a different scan. Apply again without the old token.');
      }
      let taggedAcceptedIds = snapshot?.decisions.size ? [...snapshot.decisions].filter(([, accepted]) => accepted).map(([id]) => id) : undefined;
      let decidedIds: string[] = snapshot ? [...snapshot.decisions.keys()] : [];
      let rewrites: Record<string, string> = { ...(snapshot?.rewrites ?? {}) };
      if (confirmationToken) {
        const outcome = consumeGlossaryConfirmation(confirmationToken, text, { userId, cid: opts.cid, docId });
        if (outcome.outcome === 'pending') {
          return {
            content:
              '[confirmation_pending] The confirmation card has not been submitted yet.\n'
              + 'End your turn with a short ask and wait for the user to tick the items, then call this\n'
              + 'tool again with the SAME token. Do not apply high-risk items before the user answers.',
            correction: { ...evidenceFor('needs_confirmation'),
              confirmationItems: buildConfirmItems(snapshot?.candidates.filter(c => !snapshot.decisions.has(c.entryRef)
                && (c.fromModel || c.riskLevel === 'high' || c.disposition === 'review')) ?? [], MAX_CONFIRM_ITEMS) },
          };
        }
        if (outcome.outcome === 'stale') {
          return {
            content:
              '[confirmation_stale] The transcript text changed since the card was issued, so the token was\n'
              + 'discarded. Call `transcript_glossary_scan` + this tool again (without a token) to issue a\n'
              + 'fresh card. Do not reuse the old decisions on different text.',
            isError: true,
          };
        }
        if (outcome.outcome === 'invalid') {
          if (snapshot) { snapshot.confirmationToken = undefined; persistTranscriptScan(scanKey, snapshot); }
          return {
            content:
              '[confirmation_invalid] Unknown, expired or already-used token. Call this tool again without\n'
              + '`confirmation_token` to issue a new card.',
            isError: true,
          };
        }
        taggedAcceptedIds = outcome.acceptedIds;
        decidedIds = outcome.decidedIds;
        if (outcome.rewrites) rewrites = { ...rewrites, ...outcome.rewrites };
        if (snapshot && Object.keys(rewrites).length) snapshot.rewrites = rewrites;
        for (const id of decidedIds) snapshot?.decisions.set(id, taggedAcceptedIds.includes(id));
        if (snapshot) {
          snapshot.confirmationToken = undefined;
          decidedIds = [...snapshot.decisions.keys()];
          taggedAcceptedIds = [...snapshot.decisions].filter(([, accepted]) => accepted).map(([id]) => id);
          persistTranscriptScan(scanKey, snapshot);
        }
      }

      const entries = transcriptGlossary.listEntries(userId, { status: 'active' });
      if (!entries.length) {
        return {
          content:
            'Correction glossary is EMPTY — no corrections applied, text returned unchanged.\n'
            + 'Seed people and proper nouns with `transcript_glossary_upsert` first.',
        };
      }

      const scanned = snapshot ? { candidates: snapshot.candidates, stats: { truncated: false } } : transcriptAutoCorrect.scanText(text, entries, {
        docId,
        ...(scenarioTags && scenarioTags.length ? { scenarioTags } : {}),
        includeDelete: input.includeDelete === true,
        maxCandidates: MAX_CANDIDATES,
      });
      // The user named the right form for a flagged span: replace with theirs,
      // not the suggestion they rejected. Only accepted refs carry a rewrite.
      const scan = { ...scanned, candidates: scanned.candidates.map((c) => rewrites[c.entryRef]
        ? { ...c, correct: rewrites[c.entryRef], action: 'replace' as const } : c) };

      // 用户已确认的条目 + 本来就低风险可自动应用的条目。
      // 有 token 时：非高危项照旧自动应用，高危项只在被勾选时才应用。
      const autoRefs = new Set(
        scan.candidates.filter((c) => levels.includes(c.riskLevel) && c.fromModel !== true
          && !(c.channel === 'recall' && c.disposition === 'review')).map((c) => c.entryRef),
      );
      const acceptedIds = [...autoRefs, ...(taggedAcceptedIds ?? [])];

      // Unchecked items are an explicit decision to keep the original text,
      // not unresolved candidates that should block every future continuation.
      const undecidedOrAccepted = scan.candidates.filter((candidate) =>
        !decidedIds.includes(candidate.entryRef) || taggedAcceptedIds?.includes(candidate.entryRef));
      const result = transcriptAutoCorrect.applyCorrections(text, undecidedOrAccepted, {
        ...(acceptedIds ? { acceptedIds } : { acceptRiskLevels: levels }),
        docId,
        ...(scenarioTags && scenarioTags.length ? { scenarioTags } : {}),
      });

      // 未确认的高危项：引擎自己算的 pendingTotal，不是本模块的估计。
      // 注意：走确认卡片时 `acceptedIds` 已经取代了风险面，所以"真正还没处理的"
      // 应当以引擎的 pendingTotal 为准；这里筛出来的是**已被确认并可再次询问**的集合，
      // 即"用户这一轮没勾、但仍是高危"的那些。
      const confirmedRefs = new Set(decidedIds);
      const pending = scan.candidates
        .filter((c) => !acceptedIds.includes(c.entryRef) && !confirmedRefs.has(c.entryRef));

      const lines: string[] = [
        `status: ${result.status}`,
        `applied: ${result.applied.reduce((n, a) => n + a.count, 0)} replacement(s)`
        + ` across ${result.applied.length} entr${result.applied.length === 1 ? 'y' : 'ies'};`
        + ` acceptedRiskLevels=[${levels.join(',')}]`
        + `; pendingTotal=${result.pendingTotal}; retention=${result.retention.toFixed(3)}`,
        `chars: ${result.charsIn} → ${result.charsOut}`,
      ];

      if (result.overRewriteSuspected) {
        lines.push(
          `WARNING: overRewriteSuspected=${result.overRewriteSuspected} — the rewrite ratio exceeded`,
          'the engine threshold. Review the diff before using this text.',
        );
      }
      if (result.deletedFillers && Object.keys(result.deletedFillers).length) {
        const removed = Object.entries(result.deletedFillers).map(([k, v]) => `${k}×${v}`).join(', ');
        lines.push(`deleted fillers: ${removed}`);
      }

      if (result.applied.length) {
        lines.push('', '## What changed');
        for (const a of result.applied.slice(0, MAX_LISTED)) {
          const action = a.action === 'delete' ? `deleted 「${a.wrong}」` : `「${a.wrong}」→「${a.correct}」`;
          lines.push(`- ${action} ×${a.count}`);
        }
      }

      // 用户确认过的新词进入学习账本；达到阈值自动升级为个人全局词。
      // 这是宿主强制写入，不再依赖模型下一轮调用 upsert。
      const learning = await import('./transcript_glossary_learning');
      const learnedResult = await learning.recordConfirmedCorrections(userId,
        result.applied
          .filter((a) => a.action === 'replace' && acceptedIds.includes(a.entryRef))
          .map((a) => ({
            wrong: a.wrong,
            correct: a.correct,
            kind: entries.find((e) => e.id === a.entryRef)?.kind || 'term',
          })));
      if (learnedResult.learned.length) {
        lines.push('', '## Learned this turn (host-written glossary)');
        for (const l of learnedResult.learned) lines.push(`- 「${l.wrong}」→「${l.correct}」 (confirmed ${l.count} times)`);
        if (learnedResult.settings.notify) {
          lines.push('Tell the user these terms will now apply to future transcripts; they can undo them in the glossary settings.');
        }
      }

      if (pending.length || result.pendingTotal > 0) {
        // 有待确认项且这次**还没**走确认卡片 → 发一张卡，把 token 交给模型。
        // 卡片是给人点的；模型要做的是"结束本轮、请用户点卡片"，不是自己替用户决定。
        let cardNote: string[] = [];
        if (pending.length) {
          const items = buildConfirmItems(pending, MAX_CONFIRM_ITEMS);
          const { token, visible } = await createGlossaryConfirmation({
          agentId: opts.agentId, taskId: opts.taskId,
            userId,
            text,
            docId,
            items,
            ...(opts.cid ? { cid: opts.cid } : {}),
            ...(opts.turnId ? { turnId: opts.turnId } : {}),
          });
          if (snapshot) { snapshot.confirmationToken = token; persistTranscriptScan(scanKey, snapshot); }
          cardNote = visible
            ? [
              '',
              '## A confirmation card has been shown to the user',
              `confirmation_token: ${token}`,
              `needs_user_confirmation: true (${items.length} item(s) to decide)`,
              'END YOUR TURN NOW with a short ask such as "上面这张卡片里有几处同音词需要你确认，',
              '勾选后我继续". Do NOT call this tool again in this turn — the token stays pending until',
              'the user submits the card. When the user replies, call this tool again with',
              '`confirmation_token` set to the value above and the SAME text.',
            ]
            : [
              '',
              '## Confirmation required — card could not be displayed',
              `confirmation_token: ${token}`,
              'The inline card did not mount (no visible chat surface acknowledged it). Ask the user',
              'in plain text instead, listing the items below one by one. Once the user answers, call',
              '`transcript_glossary_upsert` for the confirmed ones, and/or call this tool again with',
              '`confirmation_token` set to the value above if they ticked items in the card after all.',
            ];
        }

        lines.push(
          '',
          '## MUST confirm with the user before generating minutes',
          `pendingTotal=${result.pendingTotal}. These were NOT applied:`,
        );
        for (const c of pending) lines.push(candidateLine(c));
        if (result.pendingTotal > pending.length) {
          lines.push(`... and ${result.pendingTotal - pending.length} more pending.`);
        }
        lines.push('');
        if (cardNote.length) {
          lines.push(...cardNote);
        } else {
          lines.push(
            'The card outcome was applied above. For any item the user confirmed as a lasting rule,',
            'call `transcript_glossary_upsert` so it applies automatically next time.',
          );
        }
      }

      const state = scan.stats.truncated || result.overRewriteSuspected ? 'blocked'
        : result.status === 'applied' ? 'applied' : 'needs_confirmation';
      // Only a fully applied correction becomes a file; a draft or blocked
      // result must never look like a usable corrected transcript.
      const outputInput = {
        ...input,
        ...(isBlank(input.outputPath) && snapshot?.outputPath ? { outputPath: snapshot.outputPath } : {}),
        ...(isBlank(input.rawOutputPath) && snapshot?.rawOutputPath ? { rawOutputPath: snapshot.rawOutputPath } : {}),
      };
      const written = writeApplyOutputs(outputInput, opts.files, src, state === 'applied' ? result.text : undefined);
      const appliedTotal = result.applied.reduce((n, a) => n + a.count, 0);
      if (written.rawPath) lines.push('', `raw_path: ${written.rawPath}`);
      lines.push(...written.notes);
      if (written.correctedPath) {
        lines.push(`corrected_path: ${written.correctedPath}`,
          'The corrected transcript is saved there. Use that file; do not rewrite it with write_file.');
      } else if (!src.file) {
        lines.push('', '--- corrected transcript ---', result.text);
      }

      if (result.status === 'applied') {
        // Keep the scan key as an idempotency receipt for a short window
        // instead of deleting it: a repeated apply from the same model turn
        // must return "already applied", not a fresh draft.
        const base = snapshot ?? { candidates: [], blocked: false, decisions: new Map<string, boolean>(), expiresAt: Date.now() + 30 * 60_000 };
        persistTranscriptScan(scanKey, {
          ...base,
          appliedReceipt: {
            at: Date.now(),
            textSha256: createHash('sha256').update(text).digest('hex'),
            ...(written.correctedPath ? { correctedPath: written.correctedPath } : {}),
            ...(written.rawPath ? { rawPath: written.rawPath } : {}),
            appliedTotal,
            entries: result.applied.map((entry) => ({ wrong: entry.wrong, correct: entry.correct, count: entry.count })),
          },
          confirmationToken: undefined,
        });
      }
      return {
        content: lines.join('\n'),
        correction: { ...evidenceFor(state),
          ...(pending.length ? { confirmationItems: buildConfirmItems(pending, MAX_CONFIRM_ITEMS) } : {}) },
      };
    },
  };

  const upsertTool: TranscriptTool & GlossaryToolWithImpl = {
    name: 'transcript_glossary_upsert',
    // 落盘写入：必须串行，不与相邻工具并发。
    executionMode: 'sequential',
    description:
      TRANSCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'transcript_glossary_upsert')!.description,
    inputSchema: TRANSCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'transcript_glossary_upsert')!.inputSchema,
    async execute(input) {
      return guarded(() => this.executeImpl(input));
    },
    async executeImpl(input) {
      const wrong = asString(input.wrong, 'wrong', 80);
      const correct = asString(input.correct, 'correct', 200);
      const kind = typeof input.kind === 'string' && (GLOSSARY_KINDS as readonly string[]).includes(input.kind)
        ? (input.kind as GlossaryKind)
        : 'term';
      const docId = optionalString(input.docId, 'docId', 200);
      const riskLevel = input.riskLevel === 'low' || input.riskLevel === 'medium' || input.riskLevel === 'high'
        ? (input.riskLevel as RiskLevel)
        : undefined;

      let result: transcriptGlossary.UpsertResult;
      try {
        result = transcriptGlossary.upsertEntry(userId, {
          wrong,
          correct,
          kind,
          source: 'manual',
          ...(riskLevel ? { riskLevel } : {}),
          ...(docId ? { docId } : {}),
          ...(input.partial === true ? { partial: true } : {}),
        });
      } catch (err) {
        // 引擎对空/超长/纯数字变体会抛错——原样报给模型，让它纠正输入。
        const message = err instanceof Error ? err.message : String(err);
        log.warn('glossary upsert rejected', { message });
        return errorResult('upsert_rejected', message);
      }

      if (!result.entry) {
        return errorResult(
          'upsert_skipped',
          `Entry not recorded (reason: ${result.skippedReason ?? 'unknown'}).`,
        );
      }

      const entry = result.entry;
      const scopeDesc = entry.scope.global
        ? 'global (applies to every transcript)'
        : `scoped (docIds=${entry.scope.docIds.length} scenarioTags=${entry.scope.scenarioTags.length})`;

      return {
        content: [
          `${result.created ? 'Created' : 'Updated'} glossary entry.`,
          `- 「${entry.wrong}」→「${entry.correct}」`,
          `- kind=${entry.kind} risk=${entry.riskLevel} action=${entry.action} boundary=${entry.boundary}`,
          `- scope=${scopeDesc} status=${entry.status} source=${entry.source}`,
          entry.riskLevel === 'high'
            ? '- NOTE: risk=high means this will NOT be auto-applied; the user will be asked to confirm each time.'
            : '- This entry now applies automatically to future transcripts in its scope.',
        ].join('\n'),
      };
    },
  };

  const listTool: TranscriptTool & GlossaryToolWithImpl = {
    name: 'transcript_glossary_list',
    executionMode: 'parallel',
    description:
      TRANSCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'transcript_glossary_list')!.description,
    inputSchema: TRANSCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'transcript_glossary_list')!.inputSchema,
    async execute(input) {
      return guarded(() => this.executeImpl(input));
    },
    async executeImpl(input) {
      const filter: { kind?: GlossaryKind; riskLevel?: RiskLevel; search?: string } = {};
      if (typeof input.kind === 'string' && (GLOSSARY_KINDS as readonly string[]).includes(input.kind)) {
        filter.kind = input.kind as GlossaryKind;
      }
      if (input.riskLevel === 'low' || input.riskLevel === 'medium' || input.riskLevel === 'high') {
        filter.riskLevel = input.riskLevel;
      }
      const search = optionalString(input.search, 'search', 120);
      if (search) filter.search = search;

      const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(500, Math.floor(input.limit)))
        : 80;

      const entries = transcriptGlossary.listEntries(userId, filter);
      if (!entries.length) {
        return {
          content: Object.keys(filter).length
            ? 'No glossary entries match those filters.'
            : 'Correction glossary is empty. Seed people and proper nouns with `transcript_glossary_upsert`.',
        };
      }

      const byRisk = entries.reduce<Record<string, number>>((acc, e) => {
        acc[e.riskLevel] = (acc[e.riskLevel] ?? 0) + 1;
        return acc;
      }, {});

      const lines = [
        `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
        + ` (risk: ${Object.entries(byRisk).map(([k, v]) => `${k}=${v}`).join(' ')}).`,
      ];
      for (const e of entries.slice(0, limit)) {
        const scope = e.scope.global ? 'global' : 'scoped';
        lines.push(
          `- 「${e.wrong}」→「${e.correct}」 kind=${e.kind} risk=${e.riskLevel}`
          + ` scope=${scope} boundary=${e.boundary}${e.status !== 'active' ? ` status=${e.status}` : ''}`,
        );
      }
      if (entries.length > limit) {
        lines.push(`... ${entries.length - limit} more. Raise \`limit\` or narrow the filters.`);
      }
      return { content: lines.join('\n') };
    },
  };

  return [scanTool, applyTool, upsertTool, listTool];
}
