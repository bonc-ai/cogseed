/**
 * Cognition extraction from Claude Code session history.
 *
 * Analyzes conversation transcripts using a locally-detected CLI Agent
 * (Claude Code, Codex, …) to extract candidate cognitions (user
 * preferences, rules, learned skills). Used by the onboarding flow's
 * "confirm candidate cognitions" step.
 *
 * **Why a local CLI instead of a hosted API key:** the user has already
 * installed and authenticated a CLI Agent (that's how the sessions we're
 * importing got created). Reusing it means zero extra configuration — no
 * API key to paste during onboarding. We dispatch a one-shot print-mode
 * turn through the shared runner and parse its final text output.
 *
 * **Design constraints:**
 *   - Does NOT touch existing recall/candidate-service.ts backend logic
 *   - Returns raw extraction results; the renderer decides whether to
 *     save them via recall.candidates.save IPC
 *   - Generic prompt; no domain-specific rules (those live in the
 *     recall module's future LLM integration)
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createLogger } from '../logger';
import { run } from './local_agents/runner';
import type { LocalCliType } from './local_agents/registry';

const log = createLogger('cognition-extraction');

/** How long we allow a single extraction dispatch to run. A local CLI
 *  turn is slower than a raw API call (process spawn + model latency),
 *  so we give it more headroom than the old 30s HTTP timeout. */
const EXTRACTION_TIMEOUT_MS = 90_000;

export interface ExtractionCandidate {
  /** The cognition judgment/statement. */
  judgment: string;
  /** Short summary (optional). */
  summary?: string;
  /** Suggested type: personal preference, rule, skill, or template. */
  suggestedType: 'personal' | 'rule' | 'template' | 'skill_method';
  /** Suggested scope: global or project-specific. */
  suggestedScope: string;
  /** Brief explanation of uncertainty/confidence. */
  uncertainty?: string;
}

/** Diagnostic breadcrumbs for the onboarding UI. When extraction yields
 *  zero candidates we must distinguish "the session had no parseable
 *  messages" from "the CLI ran and returned an empty result" from "the
 *  CLI returned prose we couldn't parse" — otherwise the user sees a
 *  vague "nothing found" and can't tell what broke. Honest-state
 *  instrumentation, never fabricated. */
export interface ExtractionDiagnostic {
  /** How many user/assistant messages were parsed from the session file. */
  messageCount: number;
  /** Length of the raw text the CLI returned (0 = CLI produced nothing). */
  rawOutputChars: number;
  /** First 300 chars of the CLI's raw output, for eyeballing format issues. */
  rawOutputPreview: string;
  /** How many array items the CLI returned before validation filtering. */
  parsedRawCount: number;
  /** First 300 chars of the transcript actually fed to the model, so a
   *  zero-result can be traced to "wrong/empty content in" vs "model was
   *  too conservative". Never fabricated — it's the literal input. */
  transcriptPreview: string;
}

export interface ExtractionResult {
  candidates: ExtractionCandidate[];
  diagnostic: ExtractionDiagnostic;
}

interface ExtractionInput {
  /** Path to the Claude Code session jsonl file. */
  sessionFilePath: string;
  /** Active user id — scopes the run record on disk. */
  uid: string;
  /** Which detected local CLI Agent to dispatch the extraction through.
   *  The IPC layer picks an available one (preferring `claude`). */
  cli: LocalCliType;
}

const EXTRACTION_PROMPT = `You are analyzing a conversation between a user and an AI coding assistant. Your job is to extract "candidate cognitions" — reusable facts about WHO THE USER IS and HOW THEY LIKE TO WORK, so a future assistant can serve them better.

Extract a cognition whenever the transcript reveals any of:
- Identity & role: the user's job, title, team, seniority, or how they describe themselves (e.g. "I'm a product manager", "我是一名后端工程师")
- Domain & context: the industry, product, or kind of work they do
- Preferences: tools, languages, libraries, frameworks, formats, or styles they favor or dislike (e.g. "prefers pnpm over npm", "喜欢简洁直接的回答")
- Communication style: the language they write in, the tone or level of detail they want
- Work rules & constraints: things they always or never want done (e.g. "always add type hints")
- Skills & techniques: capabilities or workflows they have demonstrated or described

Be generous: a clearly stated fact about the user counts even if it is mentioned only once. Capture it and note the low confidence in "uncertainty" rather than discarding it.

For each cognition provide:
1. **judgment**: a clear, actionable statement (1-2 sentences)
2. **summary**: a very short title (5-10 words)
3. **type**: one of "personal" (identity/preference), "rule" (must-follow constraint), "skill_method" (learned technique), "template" (reusable pattern)
4. **scope**: "global" (applies to all work) or the specific project/domain it applies to
5. **uncertainty**: brief note on confidence (optional)

Write judgment, summary, and uncertainty in the SAME language the user writes in. If the user writes in Chinese, respond in Chinese.

Example output:
[
  {
    "judgment": "用户是一名产品经理，主要负责 B 端 SaaS 产品的需求设计。",
    "summary": "身份：B 端 SaaS 产品经理",
    "type": "personal",
    "scope": "global",
    "uncertainty": "用户自述，未跨会话确认"
  },
  {
    "judgment": "User prefers concise, direct answers in Chinese over long explanations.",
    "summary": "Prefers concise Chinese answers",
    "type": "personal",
    "scope": "global"
  }
]

IMPORTANT output rules:
- Do NOT use any tools. Do not read files or run commands. Analyze ONLY the transcript text below.
- Respond with ONLY a raw JSON array — no prose before or after, no markdown fences.
- Return [] ONLY if the transcript truly reveals nothing about who the user is or how they work. Prefer a low-confidence candidate over an empty result.

Conversation transcript to analyze:`;

/** Extract cognitions from a Claude Code session file. Returns candidates
 *  plus honest diagnostics so the onboarding UI can explain a zero-result
 *  outcome instead of masking it as a vague "nothing found". */
export async function extractCognitionsFromSession(input: ExtractionInput): Promise<ExtractionResult> {
  // Read and parse the session file
  let content: string;
  try {
    content = await fs.readFile(input.sessionFilePath, 'utf8');
  } catch (err) {
    log.warn('failed to read session file', { path: input.sessionFilePath, error: String(err) });
    throw new Error(`Cannot read session file: ${(err as Error).message}`);
  }

  const lines = content.split('\n').filter(l => l.trim());
  const messages: Array<{ role: string; content: string }> = [];

  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'user' && obj.message?.role === 'user') {
      const content = obj.message.content;
      let text: string | undefined;

      // New format (Claude Code 2.1.220+): content is a string
      if (typeof content === 'string') {
        text = content;
      }
      // Old format: content is an array of content blocks
      else if (Array.isArray(content)) {
        text = content.find((c: any) => c.type === 'text')?.text;
      }

      if (text) messages.push({ role: 'user', content: text });
    } else if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
      const content = obj.message.content;
      let text: string | undefined;

      // New format: content is a string
      if (typeof content === 'string') {
        text = content;
      }
      // Old format: content is an array
      else if (Array.isArray(content)) {
        text = content.find((c: any) => c.type === 'text')?.text;
      }

      if (text) messages.push({ role: 'assistant', content: text });
    }
  }

  if (messages.length === 0) {
    log.info('no messages found in session file', { path: input.sessionFilePath });
    return {
      candidates: [],
      diagnostic: { messageCount: 0, rawOutputChars: 0, rawOutputPreview: '', parsedRawCount: 0, transcriptPreview: '' },
    };
  }

  // Truncate to last 20 messages to stay within token limits
  const recentMessages = messages.slice(-20);
  const transcript = recentMessages.map(m => `${m.role}: ${m.content}`).join('\n\n');
  const transcriptPreview = transcript.slice(0, 300);

  // Dispatch a one-shot print-mode turn through the detected CLI Agent.
  // The agent is already authenticated on the user's machine (that's how
  // these sessions were created), so no API key is needed. We hand it the
  // full prompt (instructions + transcript) and read its final text.
  const prompt = `${EXTRACTION_PROMPT}\n\n${transcript}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  let result;
  try {
    result = await run({
      uid: input.uid,
      cid: 'onboarding-cognition-extract',
      agentId: 'onboarding-cognition-extractor',
      agentName: 'Cognition Extractor',
      cli: input.cli,
      prompt,
      cwd: os.tmpdir(),
      signal: controller.signal,
      // Synthetic internal agent id — not a registered user Agent, so the
      // chat-dispatch policy assertion does not apply. The CLI binary itself
      // (and its local auth) is what actually runs the turn.
      skipDispatchCheck: true,
      onEvent: () => {},
    });
  } catch (err) {
    log.warn('cli extraction dispatch failed', { cli: input.cli, error: String(err) });
    throw new Error(`Extraction agent failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (result.status !== 'completed') {
    log.warn('cli extraction did not complete', { cli: input.cli, status: result.status, error: result.error });
    throw new Error(`Extraction agent ${result.status}${result.error ? `: ${result.error}` : ''}`);
  }

  const rawContent = result.output;
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    log.warn('cli extraction produced no output', { cli: input.cli });
    throw new Error('Extraction agent returned no output');
  }

  const rawOutputPreview = rawContent.trim().slice(0, 300);

  // Parse the JSON array from the response. The model is told to return a
  // bare array, but real CLI output sometimes wraps it in a markdown fence
  // or prepends a sentence of prose. Use GREEDY `\[[\s\S]*\]` so we grab
  // from the first `[` to the LAST `]` — a lazy match truncates at the
  // first `]`, which breaks the common case where the model adds a
  // trailing explanation after the array.
  let extracted: any[];
  try {
    const match = rawContent.match(/```(?:json)?\s*(\[[\s\S]*\])\s*```/) || rawContent.match(/(\[[\s\S]*\])/);
    const jsonStr = match ? match[1] : rawContent;
    extracted = JSON.parse(jsonStr);
  } catch (err) {
    log.warn('failed to parse extraction result', { rawContent: rawContent.slice(0, 500), error: String(err) });
    throw new Error(`模型返回内容无法解析为 JSON 数组。原始输出预览：${rawOutputPreview}`);
  }

  if (!Array.isArray(extracted)) {
    throw new Error('Extraction result is not an array');
  }

  const parsedRawCount = extracted.length;

  // Validate and normalize
  const candidates: ExtractionCandidate[] = [];
  for (const item of extracted) {
    if (!item || typeof item.judgment !== 'string' || !item.judgment.trim()) continue;
    const type = ['personal', 'rule', 'template', 'skill_method'].includes(item.type) ? item.type : 'personal';
    candidates.push({
      judgment: item.judgment.trim(),
      summary: typeof item.summary === 'string' ? item.summary.trim() : undefined,
      suggestedType: type,
      suggestedScope: typeof item.scope === 'string' ? item.scope.trim() : 'global',
      uncertainty: typeof item.uncertainty === 'string' ? item.uncertainty.trim() : undefined,
    });
  }

  log.info('extracted cognitions', {
    sessionPath: input.sessionFilePath,
    messageCount: messages.length,
    rawOutputChars: rawContent.length,
    parsedRawCount,
    count: candidates.length,
  });
  return {
    candidates,
    diagnostic: {
      messageCount: messages.length,
      rawOutputChars: rawContent.length,
      rawOutputPreview,
      parsedRawCount,
      transcriptPreview,
    },
  };
}
