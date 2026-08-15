/**
 * Project-scoped expert team presets and persistence.
 *
 * Teams are configuration only: a project stores the selected preset snapshot
 * beside project.json so later preset edits do not silently rewrite an active
 * project's roles.
 */
import * as path from 'node:path';

import { projectDir } from '../paths';
import { readJson, safeId, writeJson } from '../storage';
import { projectExists } from './projects';

export interface ExpertTeamMember {
  agent_id: string;
  role: string;
  role_prompt: string;
}

export interface ExpertTeam {
  team_id: string;
  name: string;
  description?: string;
  leader_agent_id?: string;
  members: ExpertTeamMember[];
}

const PRESET_TEAMS: Readonly<Record<string, ExpertTeam>> = Object.freeze({
  et_academic_writing: Object.freeze({
    team_id: 'et_academic_writing',
    name: '学术写作专家团',
    description: '面向研究、论证与成稿的协作团队。',
    leader_agent_id: 'commander',
    members: Object.freeze([
      Object.freeze({
        agent_id: 'researcher',
        role: '研究员',
        role_prompt: '你是学术论文研究员，负责资料检索、来源核验、证据整理与研究边界说明。',
      }),
      Object.freeze({
        agent_id: 'writer',
        role: '写手',
        role_prompt: '你是学术写手，负责根据已核验材料组织论证、统一结构与完成可读成稿。',
      }),
    ]),
  } as ExpertTeam),
});

function teamFile(uid: string, projectId: string): string {
  return path.join(projectDir(uid, projectId), 'expert-team.json');
}

function cloneTeam(team: ExpertTeam): ExpertTeam {
  return {
    ...team,
    members: team.members.map((member) => ({ ...member })),
  };
}

function validTeam(raw: unknown): raw is ExpertTeam {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const team = raw as ExpertTeam;
  return safeId(team.team_id)
    && typeof team.name === 'string'
    && Array.isArray(team.members)
    && team.members.every((member) => (
      member && safeId(member.agent_id)
      && typeof member.role === 'string'
      && typeof member.role_prompt === 'string'
    ));
}

export function listPresetTeams(): ExpertTeam[] {
  return Object.values(PRESET_TEAMS).map(cloneTeam);
}

export function getPresetTeam(teamId: string): ExpertTeam | null {
  const team = PRESET_TEAMS[teamId];
  return team ? cloneTeam(team) : null;
}

export async function getProjectTeam(uid: string, projectId: string): Promise<ExpertTeam | null> {
  if (!safeId(uid) || !safeId(projectId)) return null;
  if (!await projectExists(uid, projectId)) return null;
  const raw = await readJson<unknown>(teamFile(uid, projectId));
  return validTeam(raw) ? cloneTeam(raw) : null;
}

export async function setProjectTeam(
  uid: string,
  projectId: string,
  team: ExpertTeam | null,
): Promise<{ ok: true; team: ExpertTeam | null } | { ok: false; error: 'invalid' | 'not_found' }> {
  if (!safeId(uid) || !safeId(projectId)) return { ok: false, error: 'invalid' };
  if (!await projectExists(uid, projectId)) return { ok: false, error: 'not_found' };
  if (team === null) {
    await writeJson(teamFile(uid, projectId), {});
    return { ok: true, team: null };
  }
  if (!validTeam(team)) return { ok: false, error: 'invalid' };
  const snapshot = cloneTeam(team);
  await writeJson(teamFile(uid, projectId), snapshot);
  return { ok: true, team: snapshot };
}
