/**
 * 应用中心注册表（T2b，Tutti 式应用中心）。
 *
 * 应用 = 人与智能体共用的能力单元：
 * - direct 型：主进程直接执行（不经过 LLM），如 AI 画图（image_gen
 *   service 直连）；
 * - agent_task 型：以任务模板驱动群聊智能体执行（create_docx /
 *   create_pptx / create_xlsx 工具已注入进程内智能体，见
 *   core-agent/office-tools.ts），产物落工作空间、可经渠道回传
 *   （channel-bridge 文件投递，T2a）。
 *
 * 智能体侧"使用应用"无需注册表——群聊进程内智能体天然持有全部
 * 工具（runner.ts buildRunner 注入）；本注册表服务的是**人**的
 * 可发现、可点选（应用中心面板），以及跨渠道场景下"在飞书里让
 * 智能体出产物再发回来"的能力宣告。
 */

import { pickImageGenProfile } from '../image_gen';
import { officeCliAvailable } from '../office/office_engine';

export type AppCenterAppKind = 'direct' | 'agent_task';
export type AppCenterCapability = 'image' | 'office-doc' | 'office-ppt' | 'office-sheet';

export interface AppCenterApp {
  id: string;
  kind: AppCenterAppKind;
  capability: AppCenterCapability;
  icon: string;
  /** i18n key（apps.<id>.name / .desc，四语言）。 */
  nameKey: string;
  descKey: string;
}

export const APP_CENTER_APPS: readonly AppCenterApp[] = Object.freeze([
  {
    id: 'ai-canvas',
    kind: 'direct',
    capability: 'image',
    icon: '🎨',
    nameKey: 'apps.ai_canvas.name',
    descKey: 'apps.ai_canvas.desc',
  },
  {
    id: 'doc-writer',
    kind: 'agent_task',
    capability: 'office-doc',
    icon: '📄',
    nameKey: 'apps.doc_writer.name',
    descKey: 'apps.doc_writer.desc',
  },
  {
    id: 'ppt-maker',
    kind: 'agent_task',
    capability: 'office-ppt',
    icon: '📊',
    nameKey: 'apps.ppt_maker.name',
    descKey: 'apps.ppt_maker.desc',
  },
  {
    id: 'sheet-builder',
    kind: 'agent_task',
    capability: 'office-sheet',
    icon: '📈',
    nameKey: 'apps.sheet_builder.name',
    descKey: 'apps.sheet_builder.desc',
  },
]);

/** 每个应用的可用性（渲染层显示徽章 + 禁用态）。 */
export function appCenterAvailability(): Record<string, { available: boolean; reasonKey?: string }> {
  // 生图可用性探测要读用户配置（auth profiles → active user）——未登录
  // 或配置读取失败时按"未配置"呈现，不让整个应用列表挂掉。
  let imageReady = false;
  try {
    imageReady = !!pickImageGenProfile();
  } catch {
    imageReady = false;
  }
  const officeReady = officeCliAvailable();
  const out: Record<string, { available: boolean; reasonKey?: string }> = {};
  for (const app of APP_CENTER_APPS) {
    if (app.capability === 'image') {
      out[app.id] = imageReady
        ? { available: true }
        : { available: false, reasonKey: 'apps.unavailable_image' };
    } else {
      out[app.id] = officeReady
        ? { available: true }
        : { available: false, reasonKey: 'apps.unavailable_office' };
    }
  }
  return out;
}

/** agent_task 型应用的任务模板：应用中心入口 → 新建任务会话的首条
 *  消息。占位符 {goal} 为用户输入的目标描述。 */
export const APP_TASK_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  'doc-writer': '请生成一份文档（.docx）：{goal}。用 create_docx 工具完成，文件保存到当前工作空间，完成后告诉我文件路径。',
  'ppt-maker': '请生成一份演示文稿（.pptx）：{goal}。用 create_pptx 工具完成，文件保存到当前工作空间，完成后告诉我文件路径。',
  'sheet-builder': '请生成一份表格（.xlsx）：{goal}。用 create_xlsx 工具完成，文件保存到当前工作空间，完成后告诉我文件路径。',
});

export function appTaskMessage(appId: string, goal: string): string | null {
  const template = APP_TASK_TEMPLATES[appId];
  if (!template) return null;
  const clean = String(goal || '').trim();
  if (!clean) return null;
  return template.replace('{goal}', clean);
}
