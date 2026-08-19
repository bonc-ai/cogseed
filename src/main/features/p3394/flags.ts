/**
 * P3394 Feature Flags — 渐进上线开关（架构文档 §13）。
 *
 * 用户偏好文件（config.UserPreferences.p3394_flags）持久化。
 *
 * ## N-14：只剩一个开关，其余 9 个已删除
 *
 * 原来这里有 10 个开关，只有 `skilllifecycle` 有读取点。**删掉而不是接上**，
 * 理由是它们描述的功能已经**无条件上线并有测试覆盖**：
 *
 *   - `snapshot`（任务接续快照）→ `recall.continuation.list/read` 已开通并渲染
 *   - `nightly`（本地夜间整理）→ capture-service 的夜间调度已在跑
 *   - `rolecomposition` / `relationship` / `realtime` / `gateb` / `blueprint` /
 *     `federation` / `community` → 无实现，也无正式产品规划在推
 *
 * 这些开关的默认值全是 `false`。把它们接到已上线的功能上，等于**默认关掉正在
 * 工作的能力**——那不是"补上遗漏的接线"，是制造回归。
 *
 * 存量偏好里的旧字段会被 `readP3394Flags` 自然忽略（只读已知键），不需要迁移。
 * 要再加开关，必须同时给出读取点，否则不要加。
 */

import { readPreferences, writePreferences } from '../config';

export interface P3394Flags {
  /** Skill 生命周期四分支建议（保底最小分支）。唯一消费者：
   *  `features/skills/skill-lifecycle.ts::recordSkillLifecycle`。 */
  skilllifecycle: boolean;
}

const DEFAULTS: P3394Flags = {
  skilllifecycle: true,
};

const FLAG_KEYS = Object.keys(DEFAULTS) as (keyof P3394Flags)[];

export function readP3394Flags(): P3394Flags {
  const prefs = readPreferences();
  const raw = (prefs.p3394_flags ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULTS };
  for (const key of FLAG_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
  }
  return out;
}

export function isP3394FlagEnabled(key: keyof P3394Flags): boolean {
  return readP3394Flags()[key];
}

export function setP3394Flag(key: keyof P3394Flags, value: boolean): P3394Flags {
  const prefs = readPreferences();
  const raw = { ...((prefs.p3394_flags ?? {}) as Record<string, unknown>) };
  raw[key] = value;
  writePreferences({ ...prefs, p3394_flags: raw });
  return readP3394Flags();
}
