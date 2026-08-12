/**
 * P3394 Feature Flags — 渐进上线开关（架构文档 §13）。
 *
 * 用户偏好文件（config.UserPreferences.p3394_flags）持久化，主进程与
 * 渲染层双读同一来源；flag 关闭时 UI 入口不渲染（不展示空壳）。
 * 默认值遵循"保底 on、完整目标/条件增强 off"的渐进上线纪律。
 */

import { readPreferences, writePreferences } from '../config';

export interface P3394Flags {
  /** Skill 生命周期四分支建议（保底最小分支）。 */
  skilllifecycle: boolean;
  /** 主导/辅助角色组合（Sprint 3/4）。 */
  rolecomposition: boolean;
  /** 任务接续快照（Sprint 3/4；D-1 决策项）。 */
  snapshot: boolean;
  /** 关系断言最小谓词（Sprint 3/4）。 */
  relationship: boolean;
  /** 本地夜间整理（条件增强）。 */
  nightly: boolean;
  /** 实时发现（条件增强）。 */
  realtime: boolean;
  /** 空间蓝图安装（Later）。 */
  blueprint: boolean;
  /** 跨空间联邦（Later）。 */
  federation: boolean;
  /** 社区（SCR-06 隐藏，Later）。 */
  community: boolean;
  /** KSTAR Gate B 隔离复用验证（Sprint 3 完整目标）。 */
  gateb: boolean;
}

const DEFAULTS: P3394Flags = {
  skilllifecycle: true,
  rolecomposition: false,
  snapshot: false,
  relationship: false,
  nightly: false,
  realtime: false,
  blueprint: false,
  federation: false,
  community: false,
  gateb: false,
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
