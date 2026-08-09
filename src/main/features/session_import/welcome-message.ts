/**
 * Welcome message generator for imported sessions.
 *
 * When a user opens an imported conversation for the first time, we generate
 * a personalized welcome message from commander that:
 * - Acknowledges the imported work context
 * - Summarizes the previous work from the session summary
 * - Lists extracted cognition candidates grouped by the four ability asset
 *   types: 关于我 (personal) / 规则与判断 (rule) / 模板与范例 (template) /
 *   技能与方法 (skill_method)
 * - Proactively suggests how to continue the work
 *
 * The message is concise and actionable, not a verbose dump of all candidates.
 */

import { listRecallCandidates } from '../recall/candidate-service';
import { createLogger } from '../../logger';

const log = createLogger('session-import:welcome');

export interface WelcomeMessageData {
  /** Human-facing greeting text (rendered in the chat UI) */
  text: string;
  /** Model-facing context (goes into model_text field) */
  modelText: string;
}

export interface GenerateWelcomeMessageInput {
  userId: string;
  /** The session summary extracted during import (describes what was done) */
  sessionSummary?: string;
}

/** The four ability asset types, in display order. */
const TYPE_LABELS: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'personal', label: '关于我' },
  { type: 'rule', label: '规则与判断' },
  { type: 'template', label: '模板与范例' },
  { type: 'skill_method', label: '技能与方法' },
];

/**
 * Generate a welcome message for an imported conversation.
 * Reads pending Recall candidates (routed by the session importer) and
 * formats them into a concise greeting grouped by the four asset types,
 * with actionable next-step suggestions.
 */
export async function generateWelcomeMessage(input: GenerateWelcomeMessageInput): Promise<WelcomeMessageData> {
  const candidates = await listRecallCandidates(input.userId);
  const pending = (candidates || []).filter((c) => c.status === 'pending');

  // Group by suggestedType; judgment is the primary text, summary the fallback.
  const byType: Record<string, string[]> = {};
  for (const c of pending) {
    const key = c.suggestedType || 'personal';
    const text = (c.judgment || c.summary || '').trim();
    if (!text) continue;
    if (!byType[key]) byType[key] = [];
    byType[key].push(text);
  }

  const total = pending.length;

  // Build human-facing greeting
  let greeting = '欢迎回来！';

  // Add session summary context if available
  if (input.sessionSummary && input.sessionSummary.trim()) {
    const summary = input.sessionSummary.trim();
    // Extract first meaningful line as the work description
    const firstLine = summary.split('\n').map(l => l.trim()).find(Boolean) || '';
    if (firstLine) {
      greeting += `\n\n我看到你之前在做：${firstLine}`;
    }
  }

  if (total === 0) {
    greeting += '\n\n我已经了解了你之前的工作内容。';
  } else {
    greeting += `\n\n我已经从你的历史会话中提取了 ${total} 条候选资产：`;
    for (const { type, label } of TYPE_LABELS) {
      const n = (byType[type] || []).length;
      if (n > 0) greeting += `\n· ${label} ${n} 条`;
    }
  }

  // Add proactive continuation suggestion
  greeting += '\n\n如果需要继续这项工作，可以直接告诉我具体要做什么，我会基于已有的上下文继续推进。如果有其他需求也可以随时提出。';

  // Build model-facing context
  let modelContext = '这是一个从其他 AI 助手导入的会话。';

  if (input.sessionSummary && input.sessionSummary.trim()) {
    modelContext += `\n\n原会话工作内容：\n${input.sessionSummary.trim()}`;
  }

  if (total > 0) {
    modelContext += `\n\n已从历史会话提取 ${total} 条候选认知（待用户确认后才会成为正式资产）：`;
    for (const { type, label } of TYPE_LABELS) {
      const items = byType[type] || [];
      if (items.length > 0) {
        modelContext += `\n- ${label} ${items.length} 条`;
        for (const example of items.slice(0, 2)) {
          modelContext += `\n  · ${example}`;
        }
      }
    }
  }

  modelContext += '\n\n用户很可能希望继续之前未完成的工作。请主动提出具体的下一步建议，基于已提取的上下文提供帮助。不要让用户重复已完成的工作，而是在已有基础上推进。';

  log.info(`generated welcome message userId=${input.userId} totalCandidates=${total}`);

  return {
    text: greeting,
    modelText: modelContext,
  };
}
