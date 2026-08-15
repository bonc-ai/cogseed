/** Prompt blocks derived from a project's configured expert team. */
import { getProjectTeam } from './expert_teams';

export async function buildTeamContextForCommander(
  uid: string,
  projectId: string | null | undefined,
): Promise<string> {
  if (!projectId) return '';
  const team = await getProjectTeam(uid, projectId);
  if (!team || !team.members.length) return '';
  const members = team.members
    .map((member) => `- ${member.role}（agent_id: ${member.agent_id}）`)
    .join('\n');
  return [
    '## 专家团',
    `当前项目已配置「${team.name}」。`,
    '可协作成员：',
    members,
    '请按成员角色分工，并使用 agent_id 指派任务。',
  ].join('\n');
}

export async function buildMemberRolePrompt(
  uid: string,
  projectId: string | null | undefined,
  agentId: string | null | undefined,
): Promise<string> {
  if (!projectId || !agentId) return '';
  const team = await getProjectTeam(uid, projectId);
  if (!team) return '';
  const member = team.members.find((item) => item.agent_id === agentId);
  if (!member) return '';
  return [
    `## 专家团角色：${member.role}`,
    member.role_prompt,
    `你是「${team.name}」的成员；请围绕该角色完成分工，并把可复用结论交还指挥官。`,
  ].join('\n');
}
