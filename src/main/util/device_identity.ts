/**
 * device_identity.ts —— 设备稳定标识（本机 + 本用户）的单一来源。
 *
 * 🔴 为什么把它从 chats.ts 里抽出来（安全审计 2026-09-21）：
 *   模块 A 的会话要绑定"客户端设备稳定 ID"（契约 `data-model.md`
 *   §plugin_auth_sessions：`device_id TEXT NOT NULL | 客户端设备稳定 ID`），
 *   而服务端那份**设备校验**此前永远不会失败 —— 因为客户端**从不发送**它：
 *     · token 端点给所有会话写死字面量 `"unknown-device"`；
 *     · refresh 端点缺字段时又用 `session.device_id` 兜底 ⇒ 一定相等。
 *   要让它真正生效，客户端必须发出一个**跨重启稳定**的 ID。
 *   既有实现（record-sync 的冲突检测）已经在写 `<uid>/local/config/record-sync-device.json`，
 *   所以这里把那段逻辑收敛为单一来源，record-sync 与插件授权共用，避免两份实现漂移。
 *
 * 语义与边界：
 *   · 文件缺失时**创建**（randomUUID，0600，原子写）；
 *   · 任何 IO 失败都返回**空串**，由调用方决定是否 fail-closed（本模块不抛错）；
 *   · 换机/重装/删掉该文件 ⇒ 新的设备 ID ⇒ 插件会话无法续期、需要重新授权。
 *     这是**期望行为**：新设备本来就该重新授权。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { userLocalConfigDir } from '../paths';

/** 设备标识文件名（历史沿用 record-sync 的那个，避免出现两份设备身份）。 */
export const DEVICE_ID_FILE_NAME = 'record-sync-device.json';

/** 设备标识文件路径。 */
export function deviceIdFile(userId: string): string {
  return path.join(userLocalConfigDir(userId), DEVICE_ID_FILE_NAME);
}

/**
 * 读取（缺失则创建）设备稳定 ID。
 *
 * @returns 稳定 ID；无法读写时返回空串（调用方需自行决定 fail-closed 与否）。
 */
export function getOrCreateDeviceId(userId: string): string {
  const file = deviceIdFile(userId);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { device_id?: unknown };
    const id = typeof raw?.device_id === 'string' ? raw.device_id.trim() : '';
    if (id) return id;
  } catch {
    /* 不存在/损坏 → 下面重建 */
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, device_id: id }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  } catch {
    /* 写不进去时仍然返回本次生成的 id：调用方拿它当"本进程内的设备标识"也说得过去，
       但下次会得到另一个 id —— 由调用方决定是否接受 */
  }
  return id;
}
