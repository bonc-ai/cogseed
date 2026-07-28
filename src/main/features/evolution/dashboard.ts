import { listSkills } from '../skills';
import { listKstarCompatProjections } from '../p3394';
import { listEvolutionRuns } from './orchestrator-bridge';

export interface DashboardData {
  skillCount: number;
  enabledSkillCount: number;
  pendingReviewCount: number;   // status === 'needs_review'
  evolutionRunCount: number;
  runningEvolutionCount: number;
  degraded: boolean;
}

interface DashboardDeps {
  listSkills?: () => Promise<Array<{ id: string; enabled?: boolean }>>;
  listProjections?: (uid: string) => Promise<Array<{ status: string }>>;
  listRuns?: (uid: string) => Promise<Array<{ status: string }>>;
}

export async function buildDashboard(uid: string, deps: DashboardDeps = {}): Promise<DashboardData> {
  const getSkills = deps.listSkills ?? (() => listSkills());
  const getProjections = deps.listProjections ?? ((u: string) => listKstarCompatProjections(u));
  const getRuns = deps.listRuns ?? ((u: string) => listEvolutionRuns(u) as unknown as Promise<Array<{ status: string }>>);

  let degraded = false;
  let skills: Array<{ id: string; enabled?: boolean }> = [];
  let projections: Array<{ status: string }> = [];
  let runs: Array<{ status: string }> = [];
  try { skills = await getSkills(); } catch { degraded = true; }
  try { projections = await getProjections(uid); } catch { degraded = true; }
  try { runs = await getRuns(uid); } catch { degraded = true; }

  return {
    skillCount: skills.length,
    enabledSkillCount: skills.filter(s => s.enabled !== false).length,
    pendingReviewCount: projections.filter(p => p.status === 'needs_review').length,
    evolutionRunCount: runs.length,
    runningEvolutionCount: runs.filter(r => r.status === 'running').length,
    degraded,
  };
}
