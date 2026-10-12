/**
 * experience-tools.ts — 任务经验的模型工具面（specs/016 T024 / research D8）。
 *
 * **2 读 + 0 写**（拍板 C-7）：经验的写入只由沉淀线与界面动作发起，「经验→资产」
 * 由用户手动创建——模型没有写通道。独立工厂而非并入 asset-steward-tools：
 * 管家精确断言「3 读 + 6 写」，且这两条本就不是管家能力（管家管的是资产写操作）。
 *
 * 与 recall-tools（search_ability_assets）的分工：那边管**资产**（aa-），这边管
 * **任务经验**（exp-），两套集合完全隔离；但留痕口径**同源**——正文真正进了
 * 模型上下文就写 agent_read 注入回执 + 使用流水，模型自取也算一次真实带入，
 * 否则"模型自选"永远进不了使用统计。除回执/流水外不写任何存储。
 *
 * 清单数据走 buildExperienceCatalog（任务书口径：类型过滤 + ★ 相关度 + 近度序，
 * 与提示词里注入的清单同一份构建规则）；显式 taskType 浏览与无文本兜底走
 * listExperiences（与 search_ability_assets 的目录模式同款：只筛 active，
 * 门禁在取正文时执行）。
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import {
  buildExperienceCatalog,
  experienceCatalogLine,
  experienceVersion,
  type ExperienceCatalogEntry,
} from '../../features/recall/experience-catalog';
import { catalogTruncate } from '../../features/recall/asset-catalog';
import {
  evaluateExperienceRuntimeEligibility,
  listExperiences,
  readExperience,
  type ExperienceRecord,
  type ExperienceTaskType,
  type ExperienceType,
} from '../../features/recall/experience-service';
import { scopeForTask } from '../../features/kstar/extraction-service';
import type { AssetRuntimeContext } from '../../features/recall/formal-assets/runtime';
import { recordInjectionReceipt, listInjectionReceipts } from '../../features/recall/injection-receipt';
import { recordRecallUsage } from '../../features/recall/usage-service';
import { safeId } from '../../storage';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('experience-tools');

export interface ExperienceToolsOpts {
  userId: string;
  agentId?: string;
  /** 当前回合 id：写 agent_read 注入回执/使用流水用；缺省时只读不记账。 */
  turnId?: string;
  /** Conversation id（预留：回执/流水定位用）。 */
  cid?: string;
  /** 当前空间 id：只用于空间归属准入，不是经验适用任务类型。 */
  spaceId?: string;
  /** 当前用户消息文本：模型不带 taskText 调清单时的兜底任务文本。 */
  taskText?: string;
}

/** 单批正文上限：与 read_ability_asset 的 READ_CHUNK_CHARS 同值（≤2000 字分批
 *  是既有口径，T024 明文沿用），再大就等于绕回"整块塞正文"。 */
export const EXPERIENCE_READ_CHUNK_CHARS = 2_000;
const LIST_PAGE_DEFAULT = 30;
const LIST_PAGE_MAX = 50;

const EXPERIENCE_TYPES = new Set<string>(['lesson', 'workflow', 'gap', 'uncategorized']);
const TASK_TYPES = new Set<string>(['report', 'code', 'review', 'product', 'general']);

/** 准入被拦的原因 → 人话（码值与 recall-tools 的 BLOCK_REASON_LABELS 同源；
 *  这里的用途是"告知为什么不给正文"，经验没有成熟度轴，maturity 一档不会出现）。 */
const BLOCK_REASON_LABELS: Record<string, string> = {
  status_not_active: '已暂停/归档/合并，当前不可使用',
  source_unavailable: '来源被撤权，已停止使用',
  scope_mismatch: '作用范围与当前任务不匹配',
  forbidden_context: '命中它自己声明的禁用场景',
  not_applicable_context: '与它自己声明的适用场景不符',
  target_agent_not_allowed: '不允许注入给当前 Agent',
};

function blockReasonText(reasons: readonly string[]): string {
  // 人话 + 稳定理由码（管家同款 `标签[码]`）：码是规格里可翻文案的稳定标识
  // （受限正文边界：回执只存码，界面按码翻话），人话帮模型当场理解。
  const labels = reasons.map((reason) => `${BLOCK_REASON_LABELS[reason] || reason}[${reason}]`);
  return labels.length ? labels.join('；') : '当前上下文不可使用';
}

// 展示标签与 experience-catalog 的标签表同源（那边未导出；这里不碰基座文件，
// 复制同一份字符串，两处不一致会在清单/正文对照时露馅）。
const EXPERIENCE_TYPE_LABELS: Record<string, string> = {
  lesson: '教训', workflow: '工作流', gap: '缺口', uncategorized: '未分类',
};
const TASK_TYPE_LABELS: Record<string, string> = {
  report: '报告类', code: '代码类', review: '审查类', product: '产品类', general: '通用',
};
const OUTCOME_LABELS: Record<string, string> = {
  better_than_expected: '优于预期', met_expected: '符合预期',
  worse_than_expected: '低于预期', unclear: '结果不明',
};

/** 正文模式一行的元信息（模型判断适用性要看的字段，同 formatReadEntry 量级）。 */
function metaLine(exp: ExperienceRecord): string {
  return [
    `类型:${EXPERIENCE_TYPE_LABELS[exp.experienceType] || exp.experienceType}`,
    `任务类型:${TASK_TYPE_LABELS[exp.source.taskType] || exp.source.taskType}`,
    `结果:${OUTCOME_LABELS[exp.verification.outcome] || exp.verification.outcome}`,
    `版本:v${experienceVersion(exp).slice(0, 10)}`,
    `来源:${catalogTruncate(String(exp.source.taskGoal || ''), 24)}`,
  ].join(' | ');
}

/** 浏览模式的清单条目（与 buildExperienceCatalog 的条目同形，relevant 恒 false：
 *  没有任务文本就没有相关度可言，宁可不标，不编分数）。 */
function browseEntry(exp: ExperienceRecord): ExperienceCatalogEntry {
  return {
    id: exp.id,
    title: String(exp.title || ''),
    experienceType: exp.experienceType,
    taskType: exp.source.taskType,
    outcome: exp.verification.outcome,
    version: experienceVersion(exp),
    relevant: false,
    sourceTaskLabel: catalogTruncate(String(exp.source.taskGoal || ''), 24),
  };
}

function stringInput(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function enumInput(value: unknown, allowed: Set<string>): string | undefined {
  const raw = stringInput(value);
  return raw && allowed.has(raw) ? raw : undefined;
}

function experienceRuntimeContext(
  opts: ExperienceToolsOpts,
  taskText = '',
  taskScope?: string,
): AssetRuntimeContext {
  return {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.spaceId ? { workspaceId: opts.spaceId } : {}),
    ...((taskScope || taskText) ? { scope: taskScope || scopeForTask(taskText) } : {}),
    ...(taskText ? { taskText } : {}),
    silentDefaultInjection: true,
  };
}

/**
 * agent_read 留痕（口径同 recall-tools 的 recordAgentReads）：
 *   - 回执幂等（同回合同经验只一条），重复取用不刷次数；
 *   - 使用流水按"该回合首次取用"记一次；
 *   - 记账失败只告警，绝不影响工具结果（模型拿得到内容优先）。
 */
async function recordAgentReads(
  opts: ExperienceToolsOpts,
  entries: Array<{ experienceId: string; version: string }>,
): Promise<void> {
  const turnId = String(opts.turnId || '');
  if (!entries.length) return;
  if (!turnId) {
    // 没有回合 id 就记不了账（taskRunId 必填）：如实告警而不是静默丢弃——
    // 静默丢弃正是"模型自取等于统计黑洞"的成因。
    log.warn('agent_read not recorded: tool built without a turn id', { userId: maskId(opts.userId) });
    return;
  }
  try {
    const seenThisTurn = new Set(
      (await listInjectionReceipts(opts.userId, turnId))
        .filter((row) => String(row.channel || '') === 'agent_read')
        .map((row) => String(row.assetId || '')),
    );
    for (const entry of entries) {
      await recordInjectionReceipt(opts.userId, {
        taskRunId: turnId,
        assetId: entry.experienceId,
        assetVersion: entry.version,
        boundary: 'real',
        status: 'injected',
        channel: 'agent_read',
      });
      if (seenThisTurn.has(entry.experienceId)) continue;
      seenThisTurn.add(entry.experienceId);
      await recordRecallUsage(opts.userId, {
        assetId: entry.experienceId,
        assetVersion: entry.version,
        taskRunId: turnId,
        ...(opts.spaceId ? { workspaceId: opts.spaceId } : {}),
        boundary: 'real',
        outcome: 'agent_read',
      });
    }
  } catch (err) {
    log.warn('agent_read accounting failed', { userId: maskId(opts.userId), error: logErrorRef(err as Error) });
  }
}

function createListTaskExperiencesTool(opts: ExperienceToolsOpts): AgentTool {
  const userId = opts.userId;

  return {
    name: 'list_task_experiences',
    executionMode: 'parallel',
    description: [
      '用户的任务经验目录：从做完的任务里沉淀的教训、工作流、缺口——与认知资产（[asset:…]）是两套独立集合，这里只列任务经验（[exp:…]）。',
      '**接到同类任务先看一眼**：上次踩过的坑、验证过的工作流常常直接适用；每条一行（类型/任务类型/结果/版本/来源任务），不含正文。',
      '不给参数 = 按当前任务文本列同类经验；给 taskText 可换一个任务视角；给 taskType 浏览指定类型（report/code/review/product/general）；给 type 按经验类型过滤（lesson/workflow/gap/uncategorized）。',
      '看中哪条用 read_task_experience 取正文；引用格式 [exp:<id>]。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        taskText: {
          type: 'string',
          description: '可选：任务文本（按它推断任务类型并算相关度★）。不传时用本轮用户消息；两者都没有则浏览全量在用经验。',
        },
        type: {
          type: 'string',
          description: '可选：按经验类型过滤（lesson 教训 / workflow 工作流 / gap 缺口 / uncategorized 未分类）。',
        },
        taskType: {
          type: 'string',
          description: '可选：按来源任务类型浏览（report / code / review / product / general）。给定时不再按任务文本推断，直接列该类型。',
        },
        offset: {
          type: 'number',
          description: '从第几条开始（默认 0）。上一页末尾会提示还有多少条、下一页的 offset。',
        },
        limit: {
          type: 'number',
          description: `本页条数（默认 ${LIST_PAGE_DEFAULT}、最大 ${LIST_PAGE_MAX}）。`,
        },
      },
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const limit = Math.min(LIST_PAGE_MAX, Math.max(1, Math.floor(Number(input.limit) || LIST_PAGE_DEFAULT)));
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
      const typeFilter = enumInput(input.type, EXPERIENCE_TYPES) as ExperienceType | undefined;
      const taskTypeFilter = enumInput(input.taskType, TASK_TYPES) as ExperienceTaskType | undefined;
      const taskText = stringInput(input.taskText).slice(0, 2_000) || stringInput(opts.taskText).slice(0, 2_000);
      const filterNote = [
        typeFilter ? `type=${typeFilter}` : '',
        taskTypeFilter ? `taskType=${taskTypeFilter}` : '',
      ].filter(Boolean).join('，');

      // 任务模式（有任务文本且未显式指定 taskType）：与提示词清单同一份构建规则
      // （准入 + 类型过滤 + ★ 相关度 + 近度序）——工具与提示词看到同一套目录，
      // 不会出现"提示词里有、工具里没有"的分叉。
      let entries: ExperienceCatalogEntry[];
      try {
        if (taskText && !taskTypeFilter) {
          const built = await buildExperienceCatalog(userId, taskText, {
            runtimeContext: experienceRuntimeContext(opts, taskText),
          });
          entries = built.entries;
        } else {
          // 浏览模式（显式 taskType 或无任务文本）：taskType 表示经验来自哪类
          // 任务，不是本轮用途 scope。仍检查状态、Agent、workspace 和禁用场景；
          // 缺少任务文本时不因 applicableWhen 无法判断而隐藏目录元数据。
          const all = await listExperiences(userId);
          const runtimeContext = experienceRuntimeContext(opts, taskText);
          entries = all
            .filter((exp) => exp.status === 'active')
            .filter((exp) => evaluateExperienceRuntimeEligibility(userId, exp, runtimeContext)
              .reasons.every((reason) => reason === 'not_applicable_context'))
            .filter((exp) => !taskTypeFilter || exp.source.taskType === taskTypeFilter)
            .map(browseEntry);
        }
      } catch (err) {
        log.warn('experience catalog list failed', { userId: maskId(userId), error: logErrorRef(err as Error) });
        return { content: '读取任务经验目录失败', isError: true };
      }

      if (typeFilter) entries = entries.filter((entry) => entry.experienceType === typeFilter);
      if (!entries.length) {
        return { content: `任务经验目录为空（共 0 条${filterNote ? `；过滤条件：${filterNote}` : ''}）。` };
      }
      const page = entries.slice(offset, offset + limit);
      if (!page.length) {
        // offset 越界：给"已到末尾 + 总数"的明确语义，模型据此停止翻页。
        return { content: `已到目录末尾（共 ${entries.length} 条${filterNote ? `；过滤条件：${filterNote}` : ''}，offset 从 0 开始）。用 offset=0 从头看，或去掉过滤条件。` };
      }
      const more = entries.length - (offset + page.length);
      return {
        content: [
          `任务经验目录（在用 ${entries.length} 条${filterNote ? `，过滤：${filterNote}` : ''}；本页 ${offset + 1}-${offset + page.length} 条）：`,
          '',
          // 行号用绝对序号（翻页后与首页衔接），行格式与提示词清单同一份
          // experienceCatalogLine——两处目录不会长出两套写法。
          ...page.map((entry, index) => experienceCatalogLine(entry, offset + index + 1)),
          '',
          more > 0 ? `还有 ${more} 条：用 offset=${offset + page.length} 继续翻页。` : '这是最后一页。',
          '看中哪条用 read_task_experience 取正文；引用格式 [exp:<id>]，例如 [exp:exp-xxx]。',
        ].join('\n'),
      };
    },
  };
}

function createReadTaskExperienceTool(opts: ExperienceToolsOpts): AgentTool {
  const userId = opts.userId;

  return {
    name: 'read_task_experience',
    executionMode: 'parallel',
    description: [
      '读出一条任务经验的**完整正文**：单批最多 2000 字，长正文用 chunk 逐批读完（返回里会写明第几批/共几批与下一批的 chunk）。',
      '经验不可用时不会返回正文，而是如实说明原因（已暂停/已归档/范围不符/命中禁用场景等）——这不是"找不到"，别当成经验不存在，也别试图绕过。',
      '与 read_ability_asset 分工：那边读认知资产（aa-），这边读任务经验（exp-）；id 前缀不对会直接报错。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        experienceId: { type: 'string', description: '清单里的经验 id（exp- 开头）。' },
        chunk: { type: 'number', description: `第几批（从 0 开始），默认 0。一批 ${EXPERIENCE_READ_CHUNK_CHARS} 字；返回会写明总批数与下一批编号。` },
      },
      required: ['experienceId'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
      const experienceId = stringInput(input.experienceId);
      if (!safeId(experienceId) || !experienceId.startsWith('exp-')) {
        return { content: `不是合法的经验 id：${experienceId || '(空)'}（任务经验的 id 以 exp- 开头；aa- 开头的是认知资产，用 read_ability_asset）`, isError: true };
      }
      const chunk = Math.max(0, Math.floor(Number(input.chunk) || 0));

      let exp: ExperienceRecord | undefined;
      try {
        exp = await readExperience(userId, experienceId);
      } catch (err) {
        log.warn('experience read failed', { userId: maskId(userId), experienceId, error: logErrorRef(err as Error) });
      }
      if (!exp) {
        return { content: `[exp:${experienceId}] 未找到（可能已删除或不属于当前用户）。`, isError: true };
      }

      // 与清单/注入同一道运行时准入门（FR-005：与资产同一套闸门）。同
      // search_ability_assets 的读取口径：applicableWhen 是软提示不进硬闸——
      // 模型看过清单、已自行判断适用性，按词面匹配否掉模型的明确选择会把
      // 功能废掉。硬闸照旧：状态 / scope / 禁用场景 / 敏感度 / targetAgents。
      const eligibility = evaluateExperienceRuntimeEligibility(
        userId,
        exp,
        experienceRuntimeContext(opts, opts.taskText || ''),
      );
      const reasons = eligibility.reasons.filter((reason) => reason !== 'not_applicable_context');
      if (reasons.length) {
        // 「被拦截不得计为成功」：isError 是平台自身的成功/失败信号，回执同时
        // 写明具体命中哪条规则——不静默当不存在，也不把正文交出去、不写账。
        return {
          content: [
            `[exp:${experienceId}] ${exp.title || '(无标题)'}：当前不可读出正文。`,
            `拦截规则：${blockReasonText(reasons)}`,
            '这是状态/门禁的结果，不是"经验不存在"；被拦的经验在清单里也会缺席或标注。',
          ].join('\n'),
          isError: true,
        };
      }

      const body = String(exp.body || '');
      const totalChunks = Math.max(1, Math.ceil(body.length / EXPERIENCE_READ_CHUNK_CHARS));
      if (chunk >= totalChunks) {
        return {
          content: `chunk 越界：这条经验正文共 ${totalChunks} 批（chunk 从 0 开始），收到 ${chunk}。`,
          isError: true,
        };
      }
      const text = body.slice(chunk * EXPERIENCE_READ_CHUNK_CHARS, (chunk + 1) * EXPERIENCE_READ_CHUNK_CHARS);
      const applies = (exp.applicableWhen || []).join('；');
      const forbids = (exp.forbiddenWhen || []).join('；');
      const nextHint = chunk + 1 < totalChunks
        ? `还有 ${totalChunks - chunk - 1} 批：用 chunk=${chunk + 1} 继续。`
        : '这是最后一批，正文已读完。';

      // 留痕：正文进了模型上下文才算一次真实带入（同 search_ability_assets）。
      await recordAgentReads(opts, [{ experienceId: exp.id, version: experienceVersion(exp) }]);

      return {
        content: [
          `[exp:${exp.id}] ${exp.title || '(无标题)'}`,
          metaLine(exp),
          ...(applies ? [`适用于: ${applies}`] : []),
          ...(forbids ? [`禁用: ${forbids}`] : []),
          `正文（第 ${chunk + 1}/${totalChunks} 批，共 ${body.length} 字）:`,
          text,
          '',
          nextHint,
        ].join('\n'),
      };
    },
  };
}

/** Read-only task-experience tools (exactly two; zero write). No localExec needed. */
export function createExperienceTools(opts: ExperienceToolsOpts): AgentTool[] {
  return [createListTaskExperiencesTool(opts), createReadTaskExperienceTool(opts)];
}
