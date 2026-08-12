import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-team-orch';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-team-orch-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadOrch() {
  return import('../../../src/main/features/expert_team_orchestration');
}
async function loadTeams() {
  return import('../../../src/main/features/expert_teams');
}
async function loadProjects() {
  return import('../../../src/main/features/projects');
}
async function loadCandidates() {
  return import('../../../src/main/features/personal_ontology_candidates');
}

async function makeProjectWithTeam(teamId = 'et_academic_writing') {
  const projects = await loadProjects();
  const teams = await loadTeams();
  const p = await projects.createProject(UID, 'P');
  if (!p.ok) throw new Error('create failed');
  const preset = teams.getPresetTeam(teamId)!;
  await teams.setProjectTeam(UID, p.project.project_id, preset);
  return p.project.project_id;
}

describe('expert_team_orchestration › Commander 上下文', () => {
  it('有专家团 → 返回成员清单块（角色 + agent_id）', async () => {
    const pid = await makeProjectWithTeam();
    const orch = await loadOrch();
    const block = await orch.buildTeamContextForCommander(UID, pid);
    expect(block).toContain('专家团');
    expect(block).toContain('研究员');
    expect(block).toContain('写手');
    expect(block).toContain('researcher');
    expect(block).toContain('writer');
  });

  it('无项目/无团队/通用团队 → 空串', async () => {
    const orch = await loadOrch();
    expect(await orch.buildTeamContextForCommander(UID, null)).toBe('');
    expect(await orch.buildTeamContextForCommander(UID, 'p_nope')).toBe('');
    const projects = await loadProjects();
    const p = await projects.createProject(UID, 'P2');
    if (!p.ok) throw new Error('create failed');
    expect(await orch.buildTeamContextForCommander(UID, p.project.project_id)).toBe(''); // 缺省通用团队
  });
});

describe('expert_team_orchestration › 成员 role_prompt', () => {
  it('成员 agent_id 命中 → 返回 role_prompt 块（含角色名）', async () => {
    const pid = await makeProjectWithTeam();
    const orch = await loadOrch();
    const block = await orch.buildMemberRolePrompt(UID, pid, 'researcher');
    expect(block).toContain('研究员');
    expect(block).toContain('检索');
    expect(block).toContain('学术论文研究员');
  });

  it('非成员/无项目/leader → 空串', async () => {
    const pid = await makeProjectWithTeam();
    const orch = await loadOrch();
    expect(await orch.buildMemberRolePrompt(UID, pid, 'commander')).toBe(''); // leader 不在 members
    expect(await orch.buildMemberRolePrompt(UID, pid, 'nobody')).toBe('');
    expect(await orch.buildMemberRolePrompt(UID, null, 'researcher')).toBe('');
    expect(await orch.buildMemberRolePrompt(UID, pid, null)).toBe('');
  });
});

describe('personal_ontology_candidates › addCandidate（专家团产出入口）', () => {
  it('追加候选入池：默认值填充 + 列表返回', async () => {
    const candidates = await loadCandidates();
    const res = await candidates.addCandidate(UID, {
      summary: '用户偏好 APA 引用格式',
      memory_text: '写论文时引用统一用 APA 格式',
      project_id: 'p_abc',
    });
    expect(res.ok).toBe(true);
    expect(res.candidate.candidate_id).toBeTruthy();
    expect(res.candidate.kind).toBe('instance');
    expect(res.candidate.confidence).toBe('medium');
    expect(res.candidate.sensitivity).toBe('standard');
    expect(res.candidate.write_actor).toBe('llm');
    expect(res.candidate.project_id).toBe('p_abc');
    expect(res.candidates.length).toBe(1);

    const listed = await candidates.listCandidates(UID);
    expect(listed.candidate_updates.length).toBe(1);
    expect(listed.candidate_updates[0].memory_text).toContain('APA');
  });

  it('同 candidate_id 幂等：覆盖不重复入池', async () => {
    const candidates = await loadCandidates();
    await candidates.addCandidate(UID, { candidate_id: 'c_x', summary: 'v1' });
    const res = await candidates.addCandidate(UID, { candidate_id: 'c_x', summary: 'v2' });
    expect(res.candidates.length).toBe(1);
    expect(res.candidates[0].summary).toBe('v2');
  });

  it('空文本 → 抛错', async () => {
    const candidates = await loadCandidates();
    await expect(candidates.addCandidate(UID, { summary: '' })).rejects.toThrow();
  });
});
