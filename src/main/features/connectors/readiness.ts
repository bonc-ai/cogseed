/**
 * S5：模板声明的连接器类型在本机是否可用。
 *
 * 模板只声明 `connector_type`（= 目录连接器 id）。目录连接器每类最多一个实例、实例 id 即目录 id，
 * 所以按 `id === connector_type` 且来源是目录（`origin` 缺省也算目录）找唯一实例；用户自定义的
 * `custom-` 实例不参与匹配。不新增实例字段，不让用户选账号，任务里也不存实例 id 或凭据。
 */
import { isConnectorRuntimeEnabled } from './availability';
import { getInstance } from './manager';
import { isConnectorUsable, type ConnectorInstance } from './types';
import type { ConnectorReadiness, ConnectorState } from '../template_types';

/** 纯判定：`instance` 为按 id 取到的实例（可为 null），`runtimeEnabled` 为该连接器在本机是否开放。 */
export function connectorStateOf(
  connectorType: string, instance: ConnectorInstance | null, runtimeEnabled: boolean,
): ConnectorState {
  if (!instance || instance.id !== connectorType || instance.origin === 'custom') return 'missing';
  if (!runtimeEnabled) return 'disabled';
  if (instance.auth_error) return 'auth_error';
  if (!isConnectorUsable(instance.status)) return 'disconnected';
  return 'ready';
}

export function connectorReadyForType(uid: string, connectorType: string): ConnectorReadiness {
  let instance: ConnectorInstance | null = null;
  try { instance = getInstance(uid, connectorType); } catch { instance = null; }
  let runtimeEnabled = false;
  try { runtimeEnabled = isConnectorRuntimeEnabled(uid, connectorType); } catch { runtimeEnabled = false; }
  return { connector_type: connectorType, state: connectorStateOf(connectorType, instance, runtimeEnabled) };
}
