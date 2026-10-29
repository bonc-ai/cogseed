/** Read-only task field gaps; answers are used in the current task. */

import { resolvePersonalFields } from './resolve';
import { resolveAssetSlots, resolveOntologySlots, type AssetSlotResolution, type OntologySlotResolution } from './slots';
import type { TaskFieldPack } from './task_field_packs';
import type {
  MissingReason,
  PersonalFieldResolution,
  ResolvePersonalFieldsRequest,
} from './types';

export interface FieldGap {
  /** 缺的是哪一轴的槽位（asset 轴缺资产不算缺口，不进此列表）。 */
  axis: 'personal' | 'ontology';
  fieldName: string;
  groupId?: string;
  required: boolean;
  /** 为什么缺——直接来自取件窗口，四种原因对应四种不同的用户动作。 */
  reason: MissingReason;
  /** 给用户看的提问文案（界面直接用，不再拼接）。 */
  question: string;
  /** 用户该做什么（回答 / 改设置 / 先治理 / 重填）。 */
  action: 'answer' | 'open_settings' | 'open_inbox' | 'refill';
  /** 同名未区分、未绑定主体等补充说明。 */
  note?: string;
}

export interface TaskFieldCheck {
  packId: string;
  packTitle: string;
  resolution: PersonalFieldResolution;
  /** 本体轴槽位解析结果（包未声明时缺省）。 */
  ontology?: OntologySlotResolution;
  /** 方法资产轴槽位解析结果（包未声明时缺省）。 */
  assets?: AssetSlotResolution;
  /** 只含必需且取不到的槽位（非必需缺失仍记录在各轴 resolution 里）。 */
  gaps: FieldGap[];
  boundCount: number;
  totalCount: number;
}

const GAP_PRESENTATION: Record<MissingReason, { question: (field: string) => string; action: FieldGap['action'] }> = {
  no_value: { question: (field) => '请补充：' + field, action: 'answer' },
  restricted: {
    question: (field) => field + ' 标了「仅自己可见」，需要在设置里放开才能用于任务',
    action: 'open_settings',
  },
  not_authorized: {
    question: (field) => field + ' 的来源已被暂停或超出适用范围，请先在待处理里处理',
    action: 'open_inbox',
  },
  stale: { question: (field) => field + ' 的来源已不存在，请重新填一次', action: 'refill' },
};

/** 算一次任务的槽位缺口（只读；缺什么、为什么缺、该怎么问）。三轴合并体检。 */
export async function checkTaskFields(
  uid: string,
  pack: TaskFieldPack,
  context?: ResolvePersonalFieldsRequest['context'],
  subjects?: Record<string, string>,
): Promise<TaskFieldCheck> {
  const resolution = await resolvePersonalFields(uid, {
    fields: pack.fields,
    ...(context ? { context } : {}),
  });
  const gaps: FieldGap[] = [];
  for (const miss of resolution.missing) {
    if (!miss.required) continue;
    const presentation = GAP_PRESENTATION[miss.reason] ?? GAP_PRESENTATION.no_value;
    gaps.push({
      axis: 'personal',
      fieldName: miss.fieldName,
      ...(miss.groupId ? { groupId: miss.groupId } : {}),
      required: true,
      reason: miss.reason,
      question: presentation.question(miss.fieldName),
      action: presentation.action,
    });
  }
  let ontology: OntologySlotResolution | undefined;
  if (pack.ontologySlots?.length) {
    ontology = await resolveOntologySlots(uid, pack.ontologySlots, { context, subjects });
    for (const miss of ontology.missing) {
      if (!miss.required) continue;
      gaps.push({
        axis: 'ontology',
        fieldName: miss.slot,
        required: true,
        reason: miss.reason,
        question: `请补充：${miss.slot}` + (miss.note ? `（${miss.note}）` : ''),
        action: 'answer',
        ...(miss.note ? { note: miss.note } : {}),
      });
    }
  }
  let assets: AssetSlotResolution | undefined;
  if (pack.assetSlots?.length) {
    assets = await resolveAssetSlots(uid, pack.assetSlots, context);
    // 缺方法资产不是缺口：没有就如实没有，不逼用户现场造资产。
  }
  const ontologyCount = pack.ontologySlots?.length ?? 0;
  const assetCount = pack.assetSlots?.length ?? 0;
  return {
    packId: pack.id,
    packTitle: pack.title,
    resolution,
    ...(ontology ? { ontology } : {}),
    ...(assets ? { assets } : {}),
    gaps,
    boundCount: resolution.bound.length + (ontology?.bound.length ?? 0) + (assets?.bound.length ?? 0),
    totalCount: pack.fields.length + ontologyCount + assetCount,
  };
}
