/**
 * P3394 事件游标持久化（R-06/S-05 恢复链路）。
 *
 * 每个任务记录"最后确认送达对端/写入下游的事件序列"（cursor）。
 * 恢复控制器按该游标 resumeForward，断线重连后不重放已确认事件。
 *
 * 存储为 Agent Home 下的 JSON 状态文件（原子写）；损坏/缺失/错误
 * schema 时以空游标启动（从 0 全量重放，宁可重复也不丢）。
 */

import * as fs from 'node:fs';
import { writeJsonSync } from '../../storage';
import { p3394StateFile } from './runtime-paths';

const CURSOR_FILE_SCHEMA_VERSION = 1;

export function p3394EventCursorFile(): string {
  return p3394StateFile('p3394-event-cursors.json');
}

/** 读取持久化游标；损坏/缺失/错误 schema 一律返回空 Map。 */
export function loadP3394EventCursors(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    if (!fs.existsSync(p3394EventCursorFile())) return out;
    const parsed = JSON.parse(fs.readFileSync(p3394EventCursorFile(), 'utf8')) as {
      schema_version?: unknown;
      cursors?: unknown;
    };
    if (parsed.schema_version !== CURSOR_FILE_SCHEMA_VERSION) return out;
    if (!parsed.cursors || typeof parsed.cursors !== 'object' || Array.isArray(parsed.cursors)) return out;
    for (const [taskId, value] of Object.entries(parsed.cursors as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out.set(taskId, value);
    }
  } catch {
    // 损坏文件：空游标启动。
  }
  return out;
}

/** 原子持久化游标表（best-effort：失败不影响事件投递）。 */
export function persistP3394EventCursors(cursors: Map<string, number>): void {
  try {
    writeJsonSync(p3394EventCursorFile(), {
      schema_version: CURSOR_FILE_SCHEMA_VERSION,
      cursors: Object.fromEntries(cursors),
    });
  } catch {
    // 持久化失败：内存游标仍保证本进程内恢复正确。
  }
}

/** 记录一次确认送达；只前进不后退（游标单调）。 */
export function recordP3394EventCursor(cursors: Map<string, number>, taskId: string, sequence: number): void {
  const safe = Math.max(0, Math.floor(Number(sequence) || 0));
  if (safe > (cursors.get(taskId) ?? 0)) cursors.set(taskId, safe);
}
