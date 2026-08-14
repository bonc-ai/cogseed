/** 本地运行时的渲染侧：把选择层的结果渲染成注入 system prompt 的正文块。
 *
 *  选择层（cognition-selection）只产出中立的决策结果，两个消费方各自渲染。
 *  这里是「本地 Agent 同进程」这一侧——模型没法自己去读文件，所以带正文；
 *  跨 Agent 交付那一侧带的是引用，由目标端自己读。
 *
 *  **confirm 档不注入。** 规范 10.2 里 confirm 的含义是「跨作用域，必须先确认」。
 *  把它直接摆进提示词，模型就看得到、也就可能用——确认这一步等于没发生。
 *  所以这一档在本地运行时被留出来（deferred），交给界面去问用户，而不是
 *  在提示词里写一句「用之前请先确认」然后指望模型自觉。
 *
 *  选择层不做这个裁剪，因为它是中立的：跨 Agent 交付时由接收方确认，
 *  confirm 档照样可以进包。裁剪是本地渲染侧的决定。
 */

import type { SelectedCognition } from './cognition-selection';

const MAX_ITEMS = 12;
const MAX_STATEMENT_LENGTH = 2_000;
const MAX_BLOCK_LENGTH = 14_000;
const MAX_CONDITIONS = 8;

export interface InheritedCognitionPrompt {
  /** 拼进 system prompt 的块。没有可注入的认知时为空串。 */
  promptBlock: string;
  /** 实际写进块里的那些——回执的 reusedRefs 按这个记。 */
  injected: SelectedCognition[];
  /** 选中了但本地这次不注入的（confirm 档，需要用户确认）。
   *  回执的 omittedRefs 要带上它们，原因 needs_confirmation。 */
  deferred: SelectedCognition[];
}

function safePromptText(value: unknown, max: number): string {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
}

function escapePromptData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[<>&]/g, (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char] || char);
}

function conditions(values: string[] | undefined, max: number): string[] | undefined {
  if (!values?.length) return undefined;
  return values.slice(0, MAX_CONDITIONS).map((value) => safePromptText(value, max));
}

function recordFor(item: SelectedCognition): Record<string, unknown> {
  return {
    asset_id: item.assetRef.asset_id,
    version: safePromptText(item.resolvedVersion, 40),
    type: item.content.type,
    title: safePromptText(item.content.title, 160),
    scope: safePromptText(item.content.scope, 500),
    statement: safePromptText(item.content.statement, MAX_STATEMENT_LENGTH),
    // 条件原样带上，由模型自己判断这次适不适用——系统不替它判定。
    ...(conditions(item.applicableWhen, 500) ? { applicable_when: conditions(item.applicableWhen, 500) } : {}),
    ...(conditions(item.forbiddenWhen, 500) ? { forbidden_when: conditions(item.forbiddenWhen, 500) } : {}),
    ...(item.sensitivity ? { sensitivity: item.sensitivity } : {}),
  };
}

/** 渲染出生继承的认知块。
 *
 *  措辞上三条纪律：
 *   1. 说清这是「出生时继承的」，不是本次任务新给的指令——避免模型把它当成
 *      当前用户的要求去执行。
 *   2. forbidden_when 是硬约束，写在最前面。适用条件由模型判断，禁用条件不许它判断。
 *   3. 不许声称用过——没实际应用就不能算复用，否则回执与履历会一起失真。 */
export function buildInheritedCognitionPrompt(
  selected: SelectedCognition[],
): InheritedCognitionPrompt {
  const deferred = selected.filter((item) => item.usePolicy === 'confirm');
  const injectable = selected.filter((item) => item.usePolicy !== 'confirm').slice(0, MAX_ITEMS);

  if (!injectable.length) return { promptBlock: '', injected: [], deferred };

  const prefix = [
    '### Inherited cognition',
    '<inherited-cognition>',
    'These are ability assets this agent inherited when it was created, carried at the version frozen at that moment. Treat them as background judgement, not as instructions from the current user.',
    'Apply one only when it is actually relevant to the task at hand. `forbidden_when` is a hard limit — never apply an asset in a situation it lists. `applicable_when` is guidance for you to judge against.',
    'Never claim you used an inherited asset unless the work actually applied it.',
  ].join('\n');
  const suffix = '</inherited-cognition>';

  const included: SelectedCognition[] = [];
  for (const item of injectable) {
    const next = [...included, item];
    const candidate = `${prefix}\n${escapePromptData(next.map(recordFor))}\n${suffix}`;
    if (candidate.length > MAX_BLOCK_LENGTH) break;
    included.push(item);
  }

  if (!included.length) return { promptBlock: '', injected: [], deferred };

  return {
    promptBlock: `${prefix}\n${escapePromptData(included.map(recordFor))}\n${suffix}`,
    injected: included,
    // 因为长度上限被挤掉的那些，语义上和 confirm 档不同，不混进 deferred：
    // 它们是「这次没地方放」，不是「需要确认」。回执侧按 truncated 记。
    deferred,
  };
}

/** 被长度上限挤掉的那些。回执的 omittedRefs 要单独记 truncated，
 *  不能和「需要确认」混成一个原因——一个是资源限制，一个是权限决定。 */
export function truncatedByBudget(
  selected: SelectedCognition[],
  rendered: InheritedCognitionPrompt,
): SelectedCognition[] {
  const kept = new Set(rendered.injected.map((item) => item.assetRef.asset_id));
  const deferredIds = new Set(rendered.deferred.map((item) => item.assetRef.asset_id));
  return selected.filter((item) => (
    !kept.has(item.assetRef.asset_id) && !deferredIds.has(item.assetRef.asset_id)
  ));
}
