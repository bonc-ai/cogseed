/**
 * 经验域共享分类词表（认知层）：任务类型轴 + 经验类型轴。
 *
 * KSTAR 可关闭，依赖方向只能是 KSTAR→认知。KSTAR、recall 与 core-agent
 * 复用这里的纯函数，不由认知层反向引用 KSTAR。
 */

/** 任务文本 → 短 ASCII 任务类型标签（闭集：report/code/review/product/general）。 */
export function scopeForTask(task: string): string {
  // Short ASCII tags by design (retrieval matches scope tokens whole-word /
  // bidirectional + cross-language aliases); CJK keywords keep Chinese tasks
  // out of the weak 'general' fallback.
  // NOTE: `file`/`文件` are weak words — "文件不存在时返回默认值" is CODE
  // logic, not a document/report task; matching them to 'report' mislabels
  // refactor/code tasks and breaks retrieval. Strong document words only.
  if (/report|summary|document|报告|总结/i.test(task)) return 'report';
  if (/code|function|bug|test|代码|函数|缺陷|测试/i.test(task)) return 'code';
  if (/review|audit|审查|审计|检查|评审/i.test(task)) return 'review';
  if (/product|decision|architecture|产品|决策|架构/i.test(task)) return 'product';
  return 'general';
}

/** 沉淀分支标签 → 经验目录类型轴。
 *  与 `userFacingSummary`（task-level-precipitation.ts）的既有三分支同源：
 *  lesson=可复用经验 / workflow=已验证的工作流程 / gap=待修正经验；
 *  判不出（含 null/undefined/未来新增的 kind）→ uncategorized，不抛错、
 *  不新造第四种分类词（用户可后续在目录里手动调整类型）。 */
export type ExperienceKind = 'lesson' | 'workflow' | 'gap';

const EXPERIENCE_KINDS: ReadonlySet<string> = new Set(['lesson', 'workflow', 'gap']);

export function experienceTypeOf(kind: unknown): ExperienceKind | 'uncategorized' {
  const value = String(kind ?? '');
  return EXPERIENCE_KINDS.has(value) ? value as ExperienceKind : 'uncategorized';
}
