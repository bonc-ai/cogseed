import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadEngine } from './engine-loader';
import { buildLlmComplete } from './llm-bridge';
import { evolutionDir, evolutionRunPath } from './paths';
import { createLogger } from '../../logger';
import { assertAgentChatDispatchable } from '../agent-dispatch-policy';

const log = createLogger('evolution:orchestrator');

// 引擎运行态结构（跨 ESM/CJS 边界只共享结构）。字段与引擎 types/evolution.ts 同构。
export interface EvolutionRun {
  runId: string; skillId: string;
  status: 'running' | 'awaiting_review' | 'done' | 'aborted';
  currentStep: number; startedAt: string; updatedAt: string;
  steps: Array<{ step: number; name: string; status: string; input?: unknown; output?: unknown; degraded?: boolean; error?: string; at?: string }>;
  finalDecision?: 'staged' | 'rejected' | 'applied';
}
type KSTAREpisode = { episode_id: string; situation: string; task: string; action_hat: string; result_hat: string; actual_action: string; actual_result: string; delta_r: number; delta_a: number };

interface StartInput { skillId: string; episode: KSTAREpisode; currentContent: string; agentId?: string; }
type OrchestratorInstance = { start: (o: unknown) => EvolutionRun; step: (id: string) => Promise<EvolutionRun>; abort: (id: string) => EvolutionRun };

// 每个 runId 复用一个 orchestrator 实例（内存状态机）。进程重启后从磁盘恢复只读展示，
// 继续驱动需重新 start（编排是短流程，不跨重启续跑）。
const orchestrators = new Map<string, OrchestratorInstance>();

function generateRunId(): string {
  return `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function persist(uid: string, run: EvolutionRun): Promise<void> {
  await fs.mkdir(evolutionDir(uid), { recursive: true });
  await fs.writeFile(evolutionRunPath(uid, run.runId), JSON.stringify(run, null, 2), 'utf-8');
}

export async function startEvolutionRun(uid: string, input: StartInput): Promise<EvolutionRun> {
  if (input.agentId) await assertAgentChatDispatchable(uid, input.agentId);
  const llm = buildLlmComplete({ userId: uid, agentId: input.agentId ?? '' });
  const engine = await loadEngine();
  const Ctor = engine.EvolutionOrchestrator as new (deps: { llm?: unknown }) => OrchestratorInstance;
  const orch = new Ctor({ llm });
  const runId = generateRunId();
  const run = orch.start({ runId, skillId: input.skillId, episode: input.episode, currentContent: input.currentContent });
  orchestrators.set(runId, orch);
  await persist(uid, run);
  log.info(`evolution run started uid=${uid} run=${runId} skill=${input.skillId}`);
  return run;
}

export async function stepEvolutionRun(uid: string, runId: string): Promise<EvolutionRun> {
  const orch = orchestrators.get(runId);
  if (!orch) throw new Error(`run not active (needs restart): ${runId}`);
  const run = await orch.step(runId);
  await persist(uid, run);
  return run;
}

export async function abortEvolutionRun(uid: string, runId: string): Promise<EvolutionRun> {
  const orch = orchestrators.get(runId);
  if (!orch) throw new Error(`run not active: ${runId}`);
  const run = orch.abort(runId);
  await persist(uid, run);
  return run;
}

export async function readEvolutionRun(uid: string, runId: string): Promise<EvolutionRun | null> {
  try {
    const raw = await fs.readFile(evolutionRunPath(uid, runId), 'utf-8');
    return JSON.parse(raw) as EvolutionRun;
  } catch { return null; }
}

export async function listEvolutionRuns(uid: string): Promise<EvolutionRun[]> {
  try {
    const files = await fs.readdir(evolutionDir(uid));
    const runs: EvolutionRun[] = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(evolutionDir(uid), f), 'utf-8');
        runs.push(JSON.parse(raw) as EvolutionRun);
      } catch { /* skip corrupt */ }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch { return []; }
}
