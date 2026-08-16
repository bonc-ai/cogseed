/**
 * Onboarding "从哪里开始" (where to begin) recommendation.
 *
 * Powers the FIRST card of the reworked onboarding step 2 — "继续「<项目>」".
 * It answers two questions, using ONLY real signals read from disk (never
 * fabricated — see CLAUDE.md hard rule "DO NOT fabricate sessions or
 * cognitions"):
 *
 *   1. Which real prior session is the best one to continue?
 *      Ranked across EVERY detected agent (Claude / WorkBuddy / Codex /
 *      OpenCode) by a blend the product owner chose:
 *
 *          score = 0.6 * normalized(contextLength) + 0.4 * normalized(recency)
 *
 *      - contextLength: real jsonl line count (Claude/WorkBuddy/Codex — one
 *        record per turn/event) or real messageCount (OpenCode, from its DB).
 *        This is a faithful proxy for "how much was invested / how long the
 *        context ran". No estimation, no rounding up.
 *      - recency: real newest timestamp (mtime for jsonl agents, time_updated
 *        for OpenCode). More recent ranks higher.
 *      Both are min-max normalized across the actual candidate set, so the
 *      weights compare like with like.
 *
 *   2. Which workspace scenario best fits that session?
 *      Local keyword match (product-owner choice A) between the session's
 *      REAL text sample (first user message + a bounded content sample) and
 *      each built-in scenario's REAL description keywords. Returns the
 *      top-scoring scenario (with its suggested primary role template) ONLY
 *      when the match clears a confidence floor; below it we honestly return
 *      `null` so the UI falls back to a temporary workspace rather than
 *      pushing a guess.
 *
 * Everything is read-only. jsonl reads are line-capped so a giant transcript
 * can't stall onboarding.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import { createLogger } from '../../logger.js';
import { detectAll, type LocalCliType } from '../local_agents/registry.js';
import { listClaudeSessions } from '../local_agents/claude_sessions.js';
import { listWorkbuddySessions } from '../local_agents/workbuddy_sessions.js';
import { listCodexSessions } from './codex-import.js';
import { listOpencodeSessions } from '../local_agents/opencode_sessions.js';
import { listScenarios } from '../role_templates.js';

const log = createLogger('session-import:recommend-start');

/** How many jsonl lines we count before giving up (a faithful upper bound —
 *  beyond this the session is already "very long" and the exact count does
 *  not change the ranking). Also caps the read cost during onboarding. */
const LINE_COUNT_CAP = 5000;
/** Bytes of transcript text we sample for template keyword matching. First
 *  user message dominates intent; a small tail sample catches topic drift. */
const SAMPLE_BYTES = 8 * 1024;
/** Minimum keyword score (matched keyword count, weighted) for us to surface
 *  a template recommendation instead of an honest "no clear match". */
const TEMPLATE_MATCH_FLOOR = 2;

export type RecommendSource = Extract<LocalCliType, 'claude' | 'workbuddy' | 'codex' | 'opencode'>;

/** One ranked candidate — normalized across agents so scoring is uniform. */
export interface StartCandidate {
  source: RecommendSource;
  sessionId: string;
  filePath: string;
  /** Decoded working dir / project path (may be ''). */
  projectPath: string;
  /** First user message (or session title) snippet. */
  firstMessage: string;
  /** ISO timestamp of the newest activity we could read. */
  timestamp: string;
  /** Real turn/message count proxy (jsonl lines or DB messageCount). */
  contextLength: number;
  /** Final blended rank score in [0,1]; higher = better starting point. */
  score: number;
}

export interface TemplateSuggestion {
  /** 命中的场景 id（education / writing / workplace / custom）。 */
  scenarioId: string;
  /** 场景建议主角色模板 id（无 = custom 场景，由用户自选）。 */
  templateId: string;
  name: string;
  /** Why this scenario — the matched keywords, shown to the user verbatim so
   *  the recommendation is transparent, never a black box. */
  matchedKeywords: string[];
  /** Raw keyword score (for debugging / thresholding). */
  score: number;
}

export interface RecommendStartResult {
  /** Best session to continue, or null when no readable sessions exist. */
  top: StartCandidate | null;
  /** Suggested scenario (with its primary template) for `top`, or null when
   *  no confident match. Kept as `suggestedTemplate` for renderer compatibility;
   *  scenarioId identifies the workspace scenario, templateId its primary role. */
  suggestedTemplate: TemplateSuggestion | null;
  /** Matched EXISTING real workspace (when the session text is closer to a
   *  user's existing space than to any scenario keyword match). null when no
   *  confident reuse — the renderer then creates/reuses by scenario instead. */
  suggestedSpace: {
    spaceId: string;
    name: string;
    spaceType?: string;
  } | null;
  /** How many total candidates were ranked (across all agents). */
  candidateCount: number;
  /** Per-agent candidate counts, for diagnostics / honest empty states. */
  perSource: Partial<Record<RecommendSource, number>>;
}

/** Count lines in a text file up to LINE_COUNT_CAP. Real signal, bounded cost.
 *  Returns 0 on any read failure (candidate still ranks, just with no context
 *  weight — honest degradation, not a fabricated number). */
async function countLinesCapped(filePath: string): Promise<number> {
  try {
    const buf = await fsp.readFile(filePath);
    let count = 0;
    for (let i = 0; i < buf.length && count < LINE_COUNT_CAP; i++) {
      if (buf[i] === 0x0a) count++;
    }
    // A file without a trailing newline still has one logical last line.
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a && count < LINE_COUNT_CAP) count++;
    return count;
  } catch {
    return 0;
  }
}

/** Newest mtime as ISO, falling back to a provided ISO string, then epoch. */
function fileMtimeIso(filePath: string, fallbackIso: string): string {
  try {
    const st = fs.statSync(filePath);
    return st.mtime.toISOString();
  } catch {
    return fallbackIso || new Date(0).toISOString();
  }
}

/** Read a bounded UTF-8 sample from the head of a file for keyword matching. */
async function readSample(filePath: string): Promise<string> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SAMPLE_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => { /* ignore */ });
  }
}

/** Gather raw candidates from every detected agent. Each is normalized into
 *  the uniform StartCandidate shape (score filled in later). Best-effort:
 *  a failing agent lister is logged and skipped, never fatal. */
async function gatherCandidates(home: string): Promise<{ list: StartCandidate[]; perSource: Partial<Record<RecommendSource, number>> }> {
  const list: StartCandidate[] = [];
  const perSource: Partial<Record<RecommendSource, number>> = {};

  let available: Set<string>;
  try {
    const entries = await detectAll({ force: false });
    available = new Set(entries.filter(e => e.available).map(e => e.type));
  } catch (err) {
    log.warn('detectAll failed; recommending across all listers anyway', { error: String(err) });
    available = new Set(['claude', 'workbuddy', 'codex', 'opencode']);
  }

  // Claude
  if (available.has('claude')) {
    try {
      const rows = await listClaudeSessions();
      perSource.claude = rows.length;
      for (const r of rows) {
        list.push({
          source: 'claude', sessionId: r.sessionId, filePath: r.filePath,
          projectPath: r.projectPath || '', firstMessage: r.firstMessage || '',
          timestamp: fileMtimeIso(r.filePath, r.timestamp),
          contextLength: await countLinesCapped(r.filePath), score: 0,
        });
      }
    } catch (err) { log.warn('listClaudeSessions failed', { error: String(err) }); }
  }

  // WorkBuddy
  if (available.has('workbuddy')) {
    try {
      const rows = await listWorkbuddySessions(home);
      perSource.workbuddy = rows.length;
      for (const r of rows) {
        list.push({
          source: 'workbuddy', sessionId: r.sessionId, filePath: r.filePath,
          projectPath: r.projectPath || '', firstMessage: r.firstMessage || '',
          timestamp: fileMtimeIso(r.filePath, r.timestamp),
          contextLength: await countLinesCapped(r.filePath), score: 0,
        });
      }
    } catch (err) { log.warn('listWorkbuddySessions failed', { error: String(err) }); }
  }

  // Codex
  if (available.has('codex')) {
    try {
      const rows = await listCodexSessions(home);
      perSource.codex = rows.length;
      for (const r of rows) {
        list.push({
          source: 'codex', sessionId: r.sessionId, filePath: r.filePath,
          projectPath: r.cwd || '', firstMessage: r.title || '',
          timestamp: fileMtimeIso(r.filePath, r.createdAt),
          contextLength: await countLinesCapped(r.filePath), score: 0,
        });
      }
    } catch (err) { log.warn('listCodexSessions failed', { error: String(err) }); }
  }

  // OpenCode (SQLite): counted for an HONEST per-source total, but NOT added
  // to the rankable pool. Card ①'s promise is "continue this project AND
  // extract its four asset types", and OpenCode has no per-session transcript
  // import pipeline (only memory/todos), so it can never be a truthful "top".
  // Surfacing it as continuable would be a broken promise, not a real one.
  if (available.has('opencode')) {
    try {
      const res = listOpencodeSessions(home);
      if (!('error' in res)) perSource.opencode = res.sessions.length;
    } catch (err) { log.warn('listOpencodeSessions failed', { error: String(err) }); }
  }

  return { list, perSource };
}

/** Min-max normalize a value into [0,1] against the observed range. When all
 *  values are equal (or a single candidate), everything maps to 1 so the
 *  other signal breaks the tie rather than a divide-by-zero. */
function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 1;
  return (value - min) / (max - min);
}

/** Rank candidates by 0.6*contextLength + 0.4*recency (both normalized). */
function rank(list: StartCandidate[]): StartCandidate[] {
  if (!list.length) return list;
  const lengths = list.map(c => c.contextLength);
  const times = list.map(c => Date.parse(c.timestamp) || 0);
  const minLen = Math.min(...lengths), maxLen = Math.max(...lengths);
  const minT = Math.min(...times), maxT = Math.max(...times);
  for (const c of list) {
    const nl = normalize(c.contextLength, minLen, maxLen);
    const nr = normalize(Date.parse(c.timestamp) || 0, minT, maxT);
    c.score = 0.6 * nl + 0.4 * nr;
  }
  return [...list].sort((a, b) => b.score - a.score);
}

/**
 * Per-scenario keyword sets. Each scenario bundles a suggested primary role
 * template (education → student, writing → technical_writer, workplace →
 * product_manager); matching a session to a scenario means the created
 * workspace carries that scenario's primary template. `custom` has no preset
 * templates and is intentionally NOT auto-matched — it exists for free
 * assembly. Keyword matching is a legitimate heuristic, not fabricated data:
 * it maps observed session vocabulary to the scenario whose description
 * covers that vocabulary. Kept deliberately small and high-signal.
 */
const SCENARIO_KEYWORDS: Record<string, string[]> = {
  education: ['学习', '课程', '作业', '考试', '复习', '笔记', '掌握', '知识点', '题目', '练习', '截止', '学期', '教材', '论文', '研究', '文献', '引文', '综述', '假设', '证据', '实验', '数据集', '方法', '复现', '理论', '学术', '发表'],
  writing: ['文档', '写作', '说明', '教程', '手册', 'readme', '注释', '章节', '排版', 'markdown', '发布说明', '术语', '润色'],
  workplace: ['需求', '产品', '功能', '用户', '迭代', '路线图', 'roadmap', '优先级', '竞品', '方案', '验收', 'prd', '增长', '指标', '体验', '客户', '交付', '解决方案', '集成', 'poc', '部署', '现场', '架构', '对接', '需求澄清', '回滚', 'readiness', '项目', '进度', '排期', '里程碑', '风险', '依赖', '资源', '甘特', '计划', '协调', '交付物', '会议', 'timeline', '招聘', '候选人', '简历', '面试', 'jd', '岗位', '人才', '入职', '评估', 'offer', '猎头', '筛选'],
};

/** Match a text sample against scenario keywords; return the best scenario
 *  above the confidence floor, or null. Longer keyword wins ties. */
function matchScenario(sampleText: string): TemplateSuggestion | null {
  const scenarios = listScenarios();
  const byId = new Map(scenarios.map(s => [s.scenario_id, s]));
  const hay = sampleText.toLowerCase();

  let best: TemplateSuggestion | null = null;
  for (const [scenarioId, keywords] of Object.entries(SCENARIO_KEYWORDS)) {
    const scenario = byId.get(scenarioId);
    if (!scenario) continue; // scenario not present in this build — skip honestly
    const matched: string[] = [];
    let score = 0;
    for (const kw of keywords) {
      if (hay.includes(kw.toLowerCase())) {
        matched.push(kw);
        // Longer keywords are more specific → weight slightly higher.
        score += kw.length >= 3 ? 1.5 : 1;
      }
    }
    if (score > (best?.score ?? 0)) {
      best = {
        scenarioId,
        templateId: scenario.suggested_primary_template_id || '',
        name: scenario.name,
        matchedKeywords: matched,
        score,
      };
    }
  }
  if (!best || best.score < TEMPLATE_MATCH_FLOOR) return null;
  return best;
}

/** Weighted token match of session text against a space's real features
 *  (name + sustained outcome + instructions). Returns the matched token count
 *  (0 = no overlap). Kept token-based and honest: only REAL user-visible
 *  space text is compared, never fabricated signals. */
function matchSpaceText(sampleText: string, spaceText: string): number {
  if (!sampleText || !spaceText) return 0;
  const hay = sampleText.toLowerCase();
  const tokens = spaceText.toLowerCase()
    .replace(/[，。！？、；：""''（）\s/\\_-]+/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const seen = new Set<string>();
  let score = 0;
  for (const tok of tokens) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    if (hay.includes(tok)) {
      score += tok.length >= 4 ? 2 : 1;
    }
  }
  return score;
}

/** Match the top session against the user's EXISTING real workspaces.
 *  Returns the best-scoring space above the confidence floor, or null. */
async function matchExistingSpace(
  userId: string,
  sampleText: string,
): Promise<NonNullable<RecommendStartResult['suggestedSpace']>> {
  try {
    const { listSpaces } = await import('../spaces');
    const spaces = await listSpaces(userId);
    let best: NonNullable<RecommendStartResult['suggestedSpace']> | null = null;
    let bestScore = 0;
    for (const space of spaces) {
      if (!space || !space.space_id) continue;
      const parts = [
        space.name,
        space.sustained_outcome,
        space.instructions,
        space.template_names,
      ].filter((v): v is string => typeof v === 'string' && !!v.trim());
      const score = matchSpaceText(sampleText, parts.join(' '));
      if (score > bestScore) {
        bestScore = score;
        best = {
          spaceId: space.space_id,
          name: space.name || '',
          spaceType: space.space_type,
        };
      }
    }
    // A space must clear a real overlap floor to be recommended; a single
    // two-char token match is noise, not a confident reuse.
    return bestScore >= 4 ? best : null;
  } catch (err) {
    log.warn('existing-space match failed', { error: String(err) });
    return null;
  }
}

/**
 * Compute the onboarding start recommendation. Read-only, best-effort, always
 * returns a result (top:null when nothing readable). `home` override is for
 * tests; production uses the real home dir.
 */
export async function recommendStartingPoint(home = os.homedir(), userId?: string): Promise<RecommendStartResult> {
  const { list, perSource } = await gatherCandidates(home);
  const candidateCount = list.length;
  if (!candidateCount) {
    return { top: null, suggestedTemplate: null, suggestedSpace: null, candidateCount: 0, perSource };
  }

  const ranked = rank(list);
  const top = ranked[0];

  // Template match uses the top session's REAL text: its first message plus a
  // bounded body sample (jsonl agents have a file; OpenCode contributes only
  // its title, which is still real session-derived text).
  let sampleText = top.firstMessage || '';
  if (top.filePath) {
    sampleText = `${sampleText}\n${await readSample(top.filePath)}`;
  }
  const suggestedTemplate = matchScenario(sampleText);

  // Reuse-first: when the session text is close to one of the user's EXISTING
  // real workspaces, prefer that over inventing a new scenario space. This is
  // the "用真实工作空间" matching the product owner asked for — sessions land
  // in the workspace that already fits instead of spawning lookalikes.
  const suggestedSpace = userId
    ? await matchExistingSpace(userId, sampleText)
    : null;

  return { top, suggestedTemplate, suggestedSpace, candidateCount, perSource };
}
