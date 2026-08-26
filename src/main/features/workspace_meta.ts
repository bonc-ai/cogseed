/**
 * 工作空间持久化元数据表 —— 对齐 Codex（SQLite 会话索引）与 DSH（storages/
 * workspace.json + session_projcache.json）的"列表查表、内容按需"架构。
 *
 * 按分区落盘为多个小 JSON 文件（<uid>/local/workspace/meta-<section>.json）：
 *   spaces / conversations / artifacts / fileTrees
 * 每条 = { stamp, at, data }：stamp 是数据来源的廉价指纹（目录 mtime:size、
 * 索引文件 mtime:size 等），读取路径"指纹命中 → 直接查表返回"，未命中才
 * 实时计算并回写。表是纯派生缓存——可随时整表丢弃重建，不影响任何数据
 * 正确性（真源仍是 cloud 域文件与扫描结果）。
 *
 * 为什么分区而不是单文件：单大文件里每写一条都要整表重读（实测 46 空间
 * + 800 会话时 table hit 被整文件解析拖到 112ms）；分区后工作空间查询只
 * 读 meta-spaces.json，会话查询只读 meta-conversations.json，加载成本与
 * 各自数据量成正比，互不拖累（DSH 正是 workspace.json / projcache.json
 * 分开放）。
 *
 * 写盘：原子写（tmp+rename）+ 300ms 防抖合并（按分区）；进程内内存表
 * 同步维护，启动后按文件 mtime 热载。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { workspaceMetaSectionFile } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('workspace_meta');

export interface WorkspaceMetaEntry<T = unknown> {
  /** 数据来源指纹：读取侧用它决定"要不要信这张表"。 */
  stamp: string;
  /** 写入时间（epoch ms，诊断用）。 */
  at: number;
  data: T;
}

export type WorkspaceMetaSection = 'spaces' | 'conversations' | 'artifacts' | 'fileTrees';

interface SectionFileShape {
  version: 1;
  entries: Record<string, WorkspaceMetaEntry>;
}

interface SectionState {
  entries: Record<string, WorkspaceMetaEntry>;
  fileMtimeMs: number;
}

const WRITE_DEBOUNCE_MS = 300;

const _states = new Map<string, Map<WorkspaceMetaSection, SectionState>>();
const _writeTimers = new Map<string, NodeJS.Timeout>();

function sectionStateFor(uid: string, section: WorkspaceMetaSection): SectionState | undefined {
  return _states.get(uid)?.get(section);
}

async function loadSection(uid: string, section: WorkspaceMetaSection): Promise<SectionState> {
  const file = workspaceMetaSectionFile(uid, section);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* 不存在 → 空表 */ }
  let perUid = _states.get(uid);
  if (!perUid) {
    perUid = new Map();
    _states.set(uid, perUid);
  }
  const cached = perUid.get(section);
  if (cached && cached.fileMtimeMs === mtime) return cached;
  let entries: Record<string, WorkspaceMetaEntry> = {};
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SectionFileShape>;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      entries = parsed.entries;
    }
  } catch { /* 首次或损坏 → 空表 */ }
  const state: SectionState = { entries, fileMtimeMs: mtime };
  perUid.set(section, state);
  return state;
}

function scheduleWrite(uid: string): void {
  if (_writeTimers.has(uid)) return;
  const timer = setTimeout(() => {
    _writeTimers.delete(uid);
    void flush(uid);
  }, WRITE_DEBOUNCE_MS);
  _writeTimers.set(uid, timer);
}

/** 立即落盘全部已加载分区（防抖定时器到期时调用；测试/关停可用）。 */
export async function flush(uid: string): Promise<void> {
  const perUid = _states.get(uid);
  if (!perUid) return;
  for (const section of Array.from(perUid.keys())) {
    const state = perUid.get(section);
    if (!state) continue;
    const file = workspaceMetaSectionFile(uid, section);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      const shape: SectionFileShape = { version: 1, entries: state.entries };
      await fsp.writeFile(tmp, JSON.stringify(shape), 'utf8');
      await fsp.rename(tmp, file);
      state.fileMtimeMs = fs.statSync(file).mtimeMs;
    } catch (err) {
      log.warn('workspace meta write failed', {
        uid,
        section,
        error: (err as Error)?.message || String(err),
      });
    }
  }
}

export async function getEntry<T>(
  uid: string,
  section: WorkspaceMetaSection,
  key: string,
): Promise<WorkspaceMetaEntry<T> | null> {
  const state = await loadSection(uid, section);
  const entry = state.entries[key];
  if (!entry) return null;
  return { stamp: entry.stamp, at: entry.at, data: entry.data as T };
}

export async function putEntry<T>(
  uid: string,
  section: WorkspaceMetaSection,
  key: string,
  stamp: string,
  data: T,
): Promise<void> {
  const state = await loadSection(uid, section);
  state.entries[key] = { stamp, at: Date.now(), data: data as unknown };
  scheduleWrite(uid);
}

export async function dropEntry(uid: string, section: WorkspaceMetaSection, key: string): Promise<void> {
  const state = await loadSection(uid, section);
  if (state.entries[key]) {
    delete state.entries[key];
    scheduleWrite(uid);
  }
}

export async function dropSection(uid: string, section: WorkspaceMetaSection): Promise<void> {
  const state = await loadSection(uid, section);
  const count = Object.keys(state.entries).length;
  if (count) {
    state.entries = {};
    scheduleWrite(uid);
  }
}

/** 测试用：清空内存表与防抖定时器。 */
export function _resetForTests(): void {
  for (const timer of _writeTimers.values()) clearTimeout(timer);
  _writeTimers.clear();
  _states.clear();
}
