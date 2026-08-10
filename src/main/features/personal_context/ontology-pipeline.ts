/**
 * 资源 → 候选实体 → 飞书确认卡片 管线（设计稿 §5.5）。
 *
 * 只做两件事：
 * 1. 把连接器产出的 ExternalResource 转成个人本体候选（复用
 *    personal_ontology_candidates 的候选池：addCandidates / confirm / reject）；
 * 2. 把候选以飞书确认卡片形式推给归属人（manager.sendInteractiveCard），
 *    按钮回调经 messaging card action 回到 confirmCandidate / rejectCandidate。
 *
 * 抽取策略（MVP）：结构化日历事件直通候选（标题/时间/地点天然是事实）；
 * 非结构化文档的内容级 LLM 抽取留待文档正文可用后（阶段 2 增强），
 * 此处只产资源引用级候选，保证闭环可跑。
 */
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import * as ontology from '../personal_ontology_candidates';
import * as manager from '../messaging/manager';
import type { ExternalResource } from './contract';
import type { JsonCompatibleValue } from '../messaging/types';

const log = createLogger('personal-context:ontology-pipeline');

/** 日历事件的结构化详情（sync 事件级数据，MVP 最小字段） */
export interface CalendarEventDetail {
  start?: string;
  end?: string;
  location?: string;
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  calendar: '日历',
  calendar_event: '日程',
  document: '文档',
  file: '文件',
  folder: '文件夹',
  chat: '会话',
  contact: '联系人',
};

/** ExternalResource → 候选池输入（OnboardingCandidate）。 */
export function resourceToCandidates(
  resource: ExternalResource,
  detail?: CalendarEventDetail,
): Array<{ judgment: string; summary: string; suggestedType: 'personal' | 'template'; uncertainty?: string }> {
  const source = resource.sourceUrl || resource.resourceId;
  if (resource.resourceType === 'calendar_event') {
    const when = [detail?.start, detail?.end].filter(Boolean).join(' – ');
    const where = detail?.location ? `（${detail.location}）` : '';
    return [{
      judgment: `日程：${resource.title}${where}${when ? `，${when}` : ''}`,
      summary: `日程：${resource.title}${when ? `（${when}）` : ''}`,
      suggestedType: 'template', // 实例化信息 → instance / user
      uncertainty: `来源：${source}`,
    }];
  }
  const typeLabel = RESOURCE_TYPE_LABELS[resource.resourceType] ?? resource.resourceType;
  return [{
    judgment: `已接入资源：${resource.title}（${typeLabel}）`,
    summary: `已接入：${resource.title}`,
    suggestedType: 'personal', // 接入事实/画像 → preference / user
    uncertainty: `来源：${source}`,
  }];
}

/** 把资源的候选写入候选池（不确认、不落记忆），返回 candidate_id 列表。 */
export async function submitCandidatesForResource(
  uid: string,
  resource: ExternalResource,
  detail?: CalendarEventDetail,
): Promise<string[]> {
  const incoming = resourceToCandidates(resource, detail);
  if (!incoming.length) return [];
  const { candidate_ids } = await ontology.addCandidates(uid, incoming);
  log.info('personal context candidates submitted', { uid, resourceType: resource.resourceType, added: candidate_ids.length });
  return candidate_ids;
}

export interface CandidateCardView {
  candidateId: string;
  summary: string;
}

/** 构造候选确认卡片：按钮 value 携带 candidate_id，回调经 manager.ingestCardAction。 */
export function buildCandidateConfirmCard(view: CandidateCardView): Record<string, JsonCompatibleValue> {
  const button = (label: string, action: string, type: string): Record<string, JsonCompatibleValue> => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: { action, candidate_id: view.candidateId },
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { content: t('personal_context.candidate.title'), tag: 'plain_text' },
      template: 'orange',
    },
    elements: [
      { tag: 'markdown', content: view.summary.slice(0, 1500) },
      {
        tag: 'action',
        actions: [
          button(t('personal_context.candidate.approve'), 'candidate_approve', 'primary'),
          button(t('personal_context.candidate.reject'), 'candidate_reject', 'danger'),
        ],
      },
    ],
  };
}

/** 向归属人会话发送候选确认卡片（chatId 由调用方解析，如主页会话 open_id）。 */
export async function sendCandidateConfirmCard(
  uid: string,
  instanceId: string,
  chatId: string,
  view: CandidateCardView,
): Promise<{ deliveryId?: string }> {
  return manager.sendInteractiveCard(uid, instanceId, chatId, buildCandidateConfirmCard(view));
}
