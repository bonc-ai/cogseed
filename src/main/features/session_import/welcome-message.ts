/**
 * Welcome message generator for imported sessions.
 *
 * When a user opens an imported conversation for the first time, we generate
 * a structured "resume" message from commander using the v1.6 resume template:
 *
 *   1. 复述 (restatement) — the same complex task has been moved into a new
 *      Session; goal, confirmed boundary, latest Artifact and next step are
 *      restored (from the TaskContinuationSnapshot) — no re-explaining needed.
 *   2. 准备携带 (carry) — what will be carried into the target:
 *      「准备携带：关于我 X项 · 我的能力 Y项 · 接续快照 1份」+
 *      「只对目标任务生效」+ 「查看依据」 (expands real sources).
 *   3. 建议 Action Plan + boundary statement — dynamic plan from the session
 *      summary (LLM), falling back to the fixed three-step v1.6 plan on any
 *      generation failure; the boundary statement is a product promise and is
 *      always included.
 *
 * All carry counts come from REAL data (confirmed assets, space template
 * bundle, TaskContinuationSnapshot) — never fabricated.
 */

import { createLogger } from '../../logger';
import { listAbilityAssets } from '../recall/asset-service';
import { getSpace } from '../spaces';
import { getRoleTemplate } from '../role_templates';
import { listSkills } from '../skills';
import { readContinuationSnapshot } from '../task_continuation';

const log = createLogger('session-import:welcome');

export interface WelcomeCarryItem {
  kind: 'personal' | 'ability' | 'snapshot';
  /** Display label (关于我 / 我的能力 / 接续快照). */
  label: string;
  /** How many items of this kind. */
  count: number;
  /** Source detail shown when「查看依据」is expanded. */
  sources: string[];
  /** Structured source facts for renderer localization. `sources` remains
   *  the model-facing and backward-compatible Chinese description. */
  sourceDetails?: Array<{
    kind: 'confirmed_personal' | 'space_template_skills' | 'confirmed_ability' | 'snapshot_restored';
    count?: number;
  }>;
  /** 真实明细（资产名/技能名 + 版本），供右栏「查看依据」逐条展示。 */
  items?: Array<{ name: string; version?: string }>;
}

export interface WelcomeMessageData {
  /** 第一部分：复述（当前目标、已确认边界、最新Artifact和下一步已恢复）。 */
  restatement: string;
  /** 第二部分：准备携带摘要（「准备携带：关于我 X项 · 我的能力 Y项 · 接续快照 1份」）。 */
  carrySummary: string;
  /** 第三部分：建议 Action Plan（动态生成，失败回退固定三条）。 */
  plan: string[];
  /** 边界声明（固定，产品承诺）。 */
  boundary: string;
  /** 结构化 carry 列表，供「查看依据」展开真实来源。 */
  carry: WelcomeCarryItem[];
  /** 会话摘要（真实来源，供面板副文案/模型上下文）。 */
  summary: string;
  /** Model-facing context (goes into model_text field). */
  modelText: string;
  /** 兼容旧调用方：拼接后的完整面板文本（复述+携带+Plan+边界）。 */
  text: string;
}

export interface GenerateWelcomeMessageInput {
  userId: string;
  /** Conversation this welcome belongs to (used to read the snapshot). */
  conversationId?: string;
  /** Space the conversation is bound to (used to resolve the space template). */
  spaceId?: string | null;
  /** The session summary extracted during import (describes what was done). */
  sessionSummary?: string;
}

/** The v1.6 fixed three-step Action Plan, used as the LLM fallback. */
const FIXED_ACTION_PLAN = [
  '核对产品对象和术语，标出尚有歧义的内容。',
  '补齐主路径、失败路径和用户可见状态。',
  '输出本轮修改建议及技术评审问题。',
];

const BOUNDARY_STATEMENT =
  '我不会在运行中静默改写正式资产；只有冲突、扩权或外发时才会停下来询问。';

/** 打开导入会话时，系统替用户发送的第一条接续引导句（v1.6 原型同款）。 */
export const WELCOME_GUIDE_SENTENCE =
  '继续这项工作。先告诉我现在做到哪里、哪些约束不能丢，以及下一步准备怎么做。';

/** Read the space template bundle's skills for the conversation's space.
 *  Real data: space → primary/secondary templates → bundle.skill_ids →
 *  listSkills() names. Returns the union of bundled skills with names. */
async function spaceTemplateSkills(
  userId: string,
  spaceId?: string | null,
): Promise<Array<{ name: string; version?: string }>> {
  if (!spaceId) return [];
  try {
    const space = await getSpace(userId, spaceId);
    if (!space) return [];
    const primary = space.primary_template_id || space.template_id;
    const secondary = space.secondary_template_ids ?? [];
    const ids = new Set<string>();
    const collect = (tplId?: string) => {
      if (!tplId) return;
      const tpl = getRoleTemplate(tplId);
      if (tpl?.bundle) tpl.bundle.skill_ids.forEach((id) => ids.add(id));
    };
    collect(primary);
    secondary.forEach(collect);
    if (!ids.size) return [];

    const skills = await listSkills();
    const byId = new Map(skills.map((s) => [s.id, s]));
    const out: Array<{ name: string; version?: string }> = [];
    for (const id of ids) {
      const s = byId.get(id);
      if (!s) continue;
      const brief: { name: string; version?: string } = { name: s.name || id };
      const ver = (s as { version?: unknown }).version;
      if (typeof ver === 'string' && ver) brief.version = ver;
      out.push(brief);
    }
    return out;
  } catch (err) {
    log.warn('space template bundle read failed', {
      userId, spaceId, error: (err as Error)?.message || String(err),
    });
    return [];
  }
}

/** Confirmed assets by type with real names/versions from the asset store. */
async function confirmedAssetDetails(
  userId: string,
): Promise<{ personal: Array<{ name: string; version?: string }>; ability: Array<{ name: string; version?: string }> }> {
  try {
    const assets = await listAbilityAssets(userId);
    const active = assets.filter((a) => a.status === 'active');
    const brief = (a: { title?: string; version?: string }) => ({ name: a.title || '未命名资产', version: a.version });
    return {
      personal: active.filter((a) => a.type === 'personal').map(brief),
      ability: active.filter((a) => a.type === 'skill_method').map(brief),
    };
  } catch (err) {
    log.warn('confirmed asset read failed', {
      userId, error: (err as Error)?.message || String(err),
    });
    return { personal: [], ability: [] };
  }
}

/** Build the「准备携带」carry list from real data. */
async function buildCarry(
  userId: string,
  hasSnapshot: boolean,
  spaceId?: string | null,
): Promise<WelcomeCarryItem[]> {
  const [spaceSkills, counts] = await Promise.all([
    spaceTemplateSkills(userId, spaceId),
    confirmedAssetDetails(userId),
  ]);

  // 「我的能力」= 空间模板内置技能 + 已确认 skill_method 资产（去重计数）。
  const abilityItems = [...spaceSkills, ...counts.ability];
  const carry: WelcomeCarryItem[] = [];
  if (counts.personal.length > 0) {
    carry.push({
      kind: 'personal', label: '关于我', count: counts.personal.length,
      sources: [`已确认「关于我」资产 ${counts.personal.length} 项`],
      sourceDetails: [{ kind: 'confirmed_personal', count: counts.personal.length }],
      items: counts.personal,
    });
  }
  if (abilityItems.length > 0) {
    const sources: string[] = [];
    if (spaceSkills.length) sources.push(`空间模板内置技能 ${spaceSkills.length} 项`);
    if (counts.ability.length) sources.push(`已确认「我的能力」资产 ${counts.ability.length} 项`);
    carry.push({
      kind: 'ability', label: '我的能力', count: abilityItems.length,
      sources,
      sourceDetails: [
        ...(spaceSkills.length ? [{ kind: 'space_template_skills' as const, count: spaceSkills.length }] : []),
        ...(counts.ability.length ? [{ kind: 'confirmed_ability' as const, count: counts.ability.length }] : []),
      ],
      items: abilityItems,
    });
  }
  if (hasSnapshot) {
    carry.push({
      kind: 'snapshot', label: '接续快照', count: 1,
      sources: ['目标、阶段、约束与下一步已恢复'],
      sourceDetails: [{ kind: 'snapshot_restored' }],
    });
  }
  return carry;
}

/** Dynamic Action Plan via the core-agent reflection runner. Always resolves;
 *  returns the fixed v1.6 plan on any failure/empty reply. */
async function generateActionPlan(userId: string, summary: string): Promise<string[]> {
  if (!summary.trim()) return [...FIXED_ACTION_PLAN];
  try {
    const { buildRunner } = await import('../../model/core-agent/runner');
    const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // sessionId 必须以受支持 kind 开头（gconv|gmember|reflect|...）。
    const { runner } = await buildRunner({
      sessionId: `reflect-welcome-${tail}`,
      userId,
    });
    const prompt =
      `根据以下导入会话的摘要，给出接下来最合理的 3 条 Action Plan（每条一句话，` +
      `编号列表，中文）。只基于摘要内容，不要编造。\n\n摘要：\n${summary.slice(0, 2000)}`;
    const text = await runner.runReflection(prompt);
    if (!text || !text.trim()) return [...FIXED_ACTION_PLAN];
    const lines = text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
    return lines.length >= 2 ? lines.slice(0, 3) : [...FIXED_ACTION_PLAN];
  } catch (err) {
    log.warn('dynamic action plan failed, using fixed plan', {
      userId, error: (err as Error)?.message || String(err),
    });
    return [...FIXED_ACTION_PLAN];
  }
}

/**
 * Generate a structured resume welcome for an imported conversation.
 * Reads the TaskContinuationSnapshot + confirmed assets + space template
 * bundle; produces the v1.6 three-part template. Always resolves.
 */
export async function generateWelcomeMessage(input: GenerateWelcomeMessageInput): Promise<WelcomeMessageData> {
  const snapshot = input.conversationId
    ? await readContinuationSnapshot(input.userId, input.conversationId, null)
    : null;
  const summary = (input.sessionSummary ?? '').trim() || (snapshot?.sourceSummary ?? '');
  const carry = await buildCarry(input.userId, !!snapshot, input.spaceId);

  // 第一部分：项目介绍（来自真实快照数据：目标 + 当前阶段 + 已知约束）。
  const goal = snapshot?.goal || summary.split('\n')[0] || '当前目标';
  const stage = snapshot?.stage || '';
  const constraints = (snapshot?.constraints ?? []).filter(Boolean);
  const projectIntro =
    `**项目**：${goal}` +
    (stage ? `\n**当前进展**：${stage}` : '') +
    (constraints.length ? `\n**不能丢的约束**：${constraints.join('；')}` : '');
  const restatement = projectIntro;

  // 第二部分：工作空间合适的能力（真实资产：空间模板技能 + 已确认能力）。
  const carrySummary = carry.length
    ? `工作空间可用能力：${carry.map((c) => `${c.label} ${c.count}项`).join(' · ')}`
    : '工作空间可用能力：无';
  const carryBlock =
    `${carrySummary}\n` +
    `只对目标任务生效`;

  // 第三部分：Action Plan——只保留最该做的一条真实任务（snapshot.nextStep，
  // 由 CLI 提炼；无则回退固定第一条）。避免一次铺多条通用步骤拖慢执行。
  const nextStep = snapshot?.nextStep || '';
  const planLines = [nextStep || FIXED_ACTION_PLAN[0]];
  const planBlock =
    `**建议 Action Plan**\n` +
    planLines.map((item, i) => `${i + 1}. ${item}`).join('\n') +
    `\n${BOUNDARY_STATEMENT}`;

  const text = `${restatement}\n\n${carryBlock}\n\n${planBlock}`;

  // Model-facing context carries the structured metadata + sources for
  // the「查看依据」expand (rendered by the renderer from model_text).
  const modelText = [
    `## 接续上下文（导入会话）`,
    summary ? `\n摘要：\n${summary}` : '',
    `\n## 准备携带`,
    carry.length ? carry.map((c) => `- ${c.label}：${c.count}（${c.sources.join('；')}）`).join('\n') : '- 无',
    `\n## 建议 Action Plan`,
    planLines.map((item, i) => `${i + 1}. ${item}`).join('\n'),
    `\n${BOUNDARY_STATEMENT}`,
  ].join('\n');

  log.info('generated structured resume welcome', {
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    hasSnapshot: !!snapshot,
    carryCount: carry.length,
    planSource: 'dynamic',
  });

  return {
    restatement,
    carrySummary,
    plan: planLines,
    boundary: BOUNDARY_STATEMENT,
    carry,
    summary,
    modelText,
    text,
  };
}
