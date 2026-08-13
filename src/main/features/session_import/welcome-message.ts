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
  const pending = (candidates || []).filter((c) => c.status === 'pending_review');

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

  // Build human-facing greeting with proactive continuation
  let greeting = '欢迎回来！我整理了你之前的工作。';

  // Add session summary context if available
  if (input.sessionSummary && input.sessionSummary.trim()) {
    const summary = input.sessionSummary.trim();
    // Extract key work context from summary
    const lines = summary.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      greeting += `\n\n📋 **之前在做什么**\n${lines[0]}`;
      // Add more context if available (up to 3 key points)
      const additionalContext = lines.slice(1, 3);
      if (additionalContext.length > 0) {
        greeting += '\n' + additionalContext.map(l => `• ${l}`).join('\n');
      }
    }
  }

  if (total > 0) {
    greeting += `\n\n🎯 **提取的能力资产（${total} 条待确认）**`;
    for (const { type, label } of TYPE_LABELS) {
      const items = byType[type] || [];
      if (items.length > 0) {
        greeting += `\n• ${label}：${items.length} 条`;
        // Show first example to give concrete preview
        if (items[0]) {
          const preview = items[0].length > 60 ? items[0].slice(0, 57) + '...' : items[0];
          greeting += ` _（例如：${preview}）_`;
        }
      }
    }
  }

  // Proactive continuation suggestions based on context
  greeting += '\n\n💡 **可以这样继续**';
  if (input.sessionSummary && input.sessionSummary.trim()) {
    // Give concrete suggestions based on what was being worked on
    greeting += '\n• 直接告诉我："继续刚才的工作"，我会接着之前的进度推进';
    greeting += '\n• 或者说明你想调整的方向，我基于已有上下文帮你';
  } else {
    greeting += '\n• 告诉我你想继续哪项工作，我会基于历史上下文推进';
  }
  if (total > 0) {
    greeting += '\n• 去「Recall 确认」页面查看和确认这些能力资产';
  }
  greeting += '\n\n准备好了就告诉我！';

  // Build model-facing context with strong continuation guidance
  let modelContext = '这是一个从其他 AI 助手导入的会话。用户希望在已有工作的基础上继续推进，而不是从头开始。';

  if (input.sessionSummary && input.sessionSummary.trim()) {
    modelContext += `\n\n## 原会话工作内容\n${input.sessionSummary.trim()}`;
  }

  if (total > 0) {
    modelContext += `\n\n## 已提取的候选认知（${total} 条，待确认）`;
    for (const { type, label } of TYPE_LABELS) {
      const items = byType[type] || [];
      if (items.length > 0) {
        modelContext += `\n### ${label}（${items.length} 条）`;
        // Show more examples to model for better context
        for (const example of items.slice(0, 3)) {
          modelContext += `\n- ${example}`;
        }
        if (items.length > 3) {
          modelContext += `\n- _...还有 ${items.length - 3} 条_`;
        }
      }
    }
  }

  modelContext += '\n\n## 你的任务';
  modelContext += '\n1. **理解用户之前在做什么** - 仔细阅读上面的工作内容摘要';
  modelContext += '\n2. **主动识别可继续的点** - 找出未完成的任务、待解决的问题、或可以深化的方向';
  modelContext += '\n3. **等待用户明确意图** - 当用户说"继续之前的工作"或类似表述时，基于上述上下文提出3-5个具体可行的下一步选项';
  modelContext += '\n4. **避免重复劳动** - 不要让用户重新解释已经做过的事情，直接在已有基础上推进';
  modelContext += '\n5. **利用提取的认知** - 这些候选认知反映了用户的工作方式和偏好，在建议时要考虑进去';

  modelContext += '\n\n**重要**：用户打开这个导入的会话，很可能是想继续之前中断的工作。如果他们说"继续"、"接着做"、"继续之前的工作"等，你应该：';
  modelContext += '\n- 快速回顾："你之前在做[具体任务]，已经完成了[已完成部分]"';
  modelContext += '\n- 给出选项："接下来可以：1) [选项A] 2) [选项B] 3) [选项C]"';
  modelContext += '\n- 询问偏好："你想从哪个开始？"或直接开始最明显的下一步';

  modelContext += '\n\n**不要**只是笼统地说"我可以帮你"，而要给出具体的、可操作的建议。';

  log.info(`generated welcome message userId=${input.userId} totalCandidates=${total}`);

  return {
    text: greeting,
    modelText: modelContext,
  };
}
