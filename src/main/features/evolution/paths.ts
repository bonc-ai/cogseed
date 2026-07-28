import * as path from 'node:path';

// 工作区根在调用时解析，绝不缓存（CLAUDE.md：uid 派生路径不做模块级常量）。
function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}
function userKstarDir(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'kstar');
}
export function evolutionDir(uid: string): string {
  return path.join(userKstarDir(uid), 'evolution');
}
export function evolutionRunPath(uid: string, runId: string): string {
  return path.join(evolutionDir(uid), `${runId}.json`);
}
export function evalsDir(uid: string): string {
  return path.join(userKstarDir(uid), 'evals');
}
export function evalRecordPath(uid: string, skillId: string): string {
  return path.join(evalsDir(uid), `${skillId}.json`);
}
