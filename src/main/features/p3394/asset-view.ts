/**
 * Asset View Projection — derived views rebuilt from the event ledger.
 *
 * PRD 原则 13/14 + FR-TREE-03：树、列表、历史、关系视图必须消费同一事件账本，
 * 不维护各自独立状态。本模块从账本重放派生当前资产状态（derive on read），
 * 不落独立存储；投影失败不影响事实状态，可重建。
 */

import { listAssetEvents, eventTypeToState, type AssetEvent } from './asset-events';

export interface AssetViewState {
  asset_id: string;
  /** 账本内全部事件（按追加顺序）。 */
  events: AssetEvent[];
  /** 重放派生：最后一次状态变化事件。 */
  last_state_event?: AssetEvent;
  /** 重放派生：当前成熟度/状态（事件类型 → 用户侧状态）。 */
  derived_state: string;
  /** 出现过的版本列表（去重保序）。 */
  versions: string[];
  /** 最后一次事件时间。 */
  last_updated_at?: string;
}

/** 从事件账本重放派生资产当前视图（不写任何存储）。 */
export async function replayAssetView(uid: string, assetId: string): Promise<AssetViewState> {
  const events = await listAssetEvents(uid, assetId);
  const versions: string[] = [];
  const seen = new Set<string>();
  let lastStateEvent: AssetEvent | undefined;
  let derivedState = 'none';

  for (const ev of events) {
    if (!seen.has(ev.asset_ref.version)) {
      seen.add(ev.asset_ref.version);
      versions.push(ev.asset_ref.version);
    }
    const st = eventTypeToState(ev.event_type);
    if (st !== 'unchanged') {
      lastStateEvent = ev;
      derivedState = st;
    }
  }

  return {
    asset_id: assetId,
    events,
    ...(lastStateEvent ? { last_state_event: lastStateEvent } : {}),
    derived_state: derivedState,
    versions,
    ...(events.length ? { last_updated_at: events[events.length - 1].committed_at } : {}),
  };
}
