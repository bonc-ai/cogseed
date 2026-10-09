/**
 * 语言脚本判定（确定性，无模型依赖）。
 *
 * 用途：沉淀链路的语言硬闸——提示词里的"用任务语言写 lesson"是软约束，
 * 模型会不遵守（实机观测：中文任务产出英文 lesson 两次，污染候选池）。
 * 这里用 CJK / Latin 字符占比判定任务与 lesson 的主导脚本，不匹配就丢弃，
 * 而不是再依赖模型自觉。
 */

export type DominantScript = 'cjk' | 'latin' | 'none';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{2f800}-\u{2fa1f}]/gu;
const LATIN_RE = /[A-Za-z]/g;

/** 文本的主导脚本。无法判定（几乎无字符）返回 'none'，不参与拦截。 */
export function dominantScript(text: string): DominantScript {
  const cjk = (text.match(CJK_RE) || []).length;
  const latin = (text.match(LATIN_RE) || []).length;
  if (cjk === 0 && latin === 0) return 'none';
  if (cjk === latin) return 'none';
  return cjk > latin ? 'cjk' : 'latin';
}

/**
 * lesson 与任务语言是否不匹配。
 *
 * - 任务或 lesson 无法判定主导脚本 → 不拦截（宁放行不错杀：代码/符号文本）。
 * - 中英混合 lesson（中文主导）与中文任务 → 匹配（用户可读）。
 * - 英文任务产出中文 lesson、中文任务产出英文 lesson → 不匹配。
 */
export function lessonLanguageMismatches(taskText: string, lessonText: string): boolean {
  const task = dominantScript(taskText);
  const lesson = dominantScript(lessonText);
  if (task === 'none' || lesson === 'none') return false;
  return task !== lesson;
}
