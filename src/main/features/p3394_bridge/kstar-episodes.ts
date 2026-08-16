/**
 * P3394 KSTAR episode persistence (guide §5.4: 每个完成的 Work Session 形成
 * KSTAR Episode → AAR → Learn-What)。Path B（会话路径）的任务在终态时落盘一
 * 份 episode 记录：goal/situation、动作轨迹、结果、自动 AAR 摘要与
 * proposed_updates（待评审，绝不自动修改认知资产）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { p3394StateFile, variantRoot } from './runtime-paths';

const log = createLogger('p3394-bridge:kstar-episodes');

export const P3394_KSTAR_EPISODE_SCHEMA_VERSION = 1 as const;

export type P3394EpisodeStatus = 'completed' | 'failed' | 'cancelled';

export interface P3394EpisodeAction {
  sequence: number;
  kind: string;
  at: string;
  text?: string;
  error?: string;
}

export interface P3394KstarEpisode {
  schema_version: number;
  session_id: string;
  task_id: string;
  goal: string;
  agent_id: string;
  status: P3394EpisodeStatus;
  actions: P3394EpisodeAction[];
  result?: string;
  /** 自动生成的行动后回顾（After-Action Review）。 */
  aar: string;
  /** Learn-What 候选：只建议，不自动写回任何认知资产。 */
  proposed_updates: unknown[];
  created_at: string;
  completed_at: string;
}

function episodeDir(sessionId: string): string {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
  return path.join(variantRoot(), 'p3394-kstar', safe);
}

export function episodeFilePath(sessionId: string, taskId: string): string {
  const safeTask = String(taskId || 'task').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'task';
  return path.join(episodeDir(sessionId), safeTask + '.json');
}

/** Auto AAR：goal/status/result 的机械摘要，人工评审前的占位结论。 */
export function buildAar(goal: string, status: P3394EpisodeStatus, result?: string): string {
  const outcome =
    status === 'completed'
      ? '任务完成' + (result ? '；结果摘要：' + String(result).slice(0, 300) : '。')
      : status === 'failed'
        ? '任务失败，需人工复盘失败原因。'
        : '任务被取消，未形成完整结果。';
  return '目标：' + String(goal || '(未声明)').slice(0, 300) + '。' + outcome;
}

export function recordP3394Episode(
  episode: Omit<P3394KstarEpisode, 'schema_version' | 'aar' | 'created_at' | 'completed_at' | 'proposed_updates'> & { created_at?: string; proposed_updates?: unknown[] },
): string {
  const now = new Date().toISOString();
  const file = episodeFilePath(episode.session_id, episode.task_id);
  const record: P3394KstarEpisode = {
    ...episode,
    schema_version: P3394_KSTAR_EPISODE_SCHEMA_VERSION,
    aar: buildAar(episode.goal, episode.status, episode.result),
    proposed_updates: episode.proposed_updates ?? [],
    created_at: episode.created_at ?? now,
    completed_at: now,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  log.info('P3394 KSTAR episode recorded', { file, status: episode.status });
  return file;
}
