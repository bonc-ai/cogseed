/**
 * cognition_kernel/task_field_packs — 任务槽位需求包。
 *
 * 一个任务包声明它开工前需要哪些认知内容，
 * 由取件窗口（resolve.ts / slots.ts）算出"已有/缺"。三轴：
 *   personal（个人字段）  关于我的短句事实；
 *   ontology（本体）      本体事实（对象 × 关系）与适用规则——按名字模式声明，
 *                         主体在调用时从任务上下文绑定（如"项目甲"）；
 *   asset（方法资产）     方法／规则／模板能力资产——按资产类型＋标题声明。
 *
 * 注意边界：包只声明"要哪些槽位"；任务自己的结构（单据类目、字段定义）
 * 属于任务侧，不写进个人档案。ontology/asset 轴走各自唯一读口，不复制正文。
 */

import type { PersonalFieldRef } from './types';

export interface TaskFieldPack {
  id: string;
  title: string;
  /** 该任务开工前必须齐备的个人字段（顺序即提问顺序）。 */
  fields: readonly PersonalFieldRef[];
  /** 本体轴槽位：对象/关系事实与适用规则。 */
  ontologySlots?: readonly OntologySlotRef[];
  /** 方法资产轴槽位：方法／规则／模板能力资产。 */
  assetSlots?: readonly AssetSlotRef[];
}

/** 本体轴槽位声明：fact＝"某对象在某关系上的当前事实"；rule＝"适用规则"。 */
export interface OntologySlotRef {
  /** 槽位名（回执与提问都用它，跨轴唯一）。 */
  slot: string;
  kind: 'fact' | 'rule';
  /** fact：关系／属性定义名（如"接收周报"）。 */
  relation?: string;
  /** rule：规则名或要求关键词（如"周报"）。 */
  ruleKeyword?: string;
  /** fact：调用时是否必须绑定主体名（来自任务上下文，如"项目甲"）。 */
  subjectRequired?: boolean;
  /** 可选：限定在哪个本体模块内解析。 */
  moduleId?: string;
  /** 缺省视为必需；非必需缺失不进 missing（只记录）。 */
  required?: boolean;
}

/** 方法资产轴槽位声明：按类型＋标题找一条可用能力资产。 */
export interface AssetSlotRef {
  slot: string;
  assetType: 'skill_method' | 'rule' | 'template';
  title: string;
  required?: boolean;
}

/**
 * 周报任务同时使用三轴槽位。
 * 本体轴绑定"项目的固定接收人"事实与周报规则；资产轴找周报模板。
 */
const WEEKLY_REPORT_SLOTS = {
  fields: [{ fieldName: '姓名' }, { fieldName: '部门' }] as readonly PersonalFieldRef[],
  ontologySlots: [
    { slot: '周报-固定接收人', kind: 'fact', relation: '接收周报', subjectRequired: true },
    { slot: '周报-适用要求', kind: 'rule', ruleKeyword: '周报', required: false },
  ] as readonly OntologySlotRef[],
  assetSlots: [
    { slot: '周报-内容模板', assetType: 'template', title: '周报模板', required: false },
  ] as readonly AssetSlotRef[],
};

export const TASK_FIELD_PACKS: Record<string, TaskFieldPack> = {
  weekly_report: { id: 'weekly_report', title: '周报', ...WEEKLY_REPORT_SLOTS },
};

export function getTaskFieldPack(packId: string): TaskFieldPack | undefined {
  return TASK_FIELD_PACKS[String(packId ?? '').trim()];
}
