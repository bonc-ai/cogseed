import { AttributionEngine } from './attribution-engine.js';
import { PatchGenerator } from './patch-generator.js';
import { GovernanceGates } from './governance-gates.js';
import { ruleFallbackComplete, type LlmComplete } from './llm-port.js';
import { KSTAR_STEPS, type EvolutionRun, type EvolutionStep } from '../types/evolution.js';
import type { KSTAREpisode } from '../types/index.js';

interface StartOptions { runId: string; skillId: string; episode: KSTAREpisode; currentContent: string; }
interface RunContext { run: EvolutionRun; episode: KSTAREpisode; currentContent: string; attribution?: unknown; proposedContent?: string; }

/**
 * 进化编排器：把引擎零件按 KSTAR 7 步装配成可驱动的状态机。
 * 纯内存（落盘在 Feature 层）。LLM 只在步 3(Propose)/4(Evaluate) 介入。
 */
export class EvolutionOrchestrator {
  private attribution = new AttributionEngine();
  private patchGen = new PatchGenerator();
  private gates = new GovernanceGates();
  private llm: LlmComplete;
  private hasLlm: boolean;
  private runs = new Map<string, RunContext>();

  constructor(deps: { llm?: LlmComplete }) {
    this.llm = deps.llm ?? ruleFallbackComplete;
    this.hasLlm = !!deps.llm;
  }

  start(opts: StartOptions): EvolutionRun {
    const now = new Date().toISOString();
    const steps: EvolutionStep[] = KSTAR_STEPS.map((name, i) => ({ step: i + 1, name, status: 'pending' }));
    const run: EvolutionRun = {
      runId: opts.runId, skillId: opts.skillId, status: 'running', currentStep: 0,
      startedAt: now, updatedAt: now, steps,
    };
    this.runs.set(opts.runId, { run, episode: opts.episode, currentContent: opts.currentContent });
    return run;
  }

  get(runId: string): EvolutionRun | undefined { return this.runs.get(runId)?.run; }

  abort(runId: string): EvolutionRun {
    const ctx = this.mustGet(runId);
    ctx.run.status = 'aborted';
    ctx.run.updatedAt = new Date().toISOString();
    return ctx.run;
  }

  async step(runId: string): Promise<EvolutionRun> {
    const ctx = this.mustGet(runId);
    const { run } = ctx;
    if (run.status !== 'running') return run;
    const idx = run.currentStep;
    if (idx >= run.steps.length) return run;

    const step = run.steps[idx];
    step.status = 'running';
    step.at = new Date().toISOString();
    try {
      await this.runStep(ctx, step);
      if (step.status === 'running') step.status = 'done';
    } catch (e) {
      step.status = 'failed';
      step.error = e instanceof Error ? e.message : String(e);
    }
    run.currentStep = idx + 1;
    run.updatedAt = new Date().toISOString();
    if (run.currentStep >= run.steps.length && run.status === 'running') run.status = 'done';
    return run;
  }

  private async runStep(ctx: RunContext, step: EvolutionStep): Promise<void> {
    switch (step.name) {
      case 'Capture':
        step.input = ctx.episode.episode_id;
        step.output = { situation: ctx.episode.situation, task: ctx.episode.task };
        return;
      case 'Attribution': {
        const rec = this.attribution.analyze(ctx.episode);
        ctx.attribution = rec;
        step.output = rec;
        return;
      }
      case 'Propose': {
        const prompt = `基于归因结论对以下技能正文给出改进版正文：\n${ctx.currentContent}`;
        const { text, degraded } = await this.llm(prompt);
        ctx.proposedContent = text;
        step.output = text;
        if (degraded || !this.hasLlm) { step.status = 'degraded'; step.degraded = true; }
        return;
      }
      case 'Evaluate': {
        const prompt = `判断改进正文是否优于原文，只输出 JSON {passed,reason}。\n原:${ctx.currentContent}\n新:${ctx.proposedContent ?? ''}`;
        const { text, degraded } = await this.llm(prompt);
        let verdict: { passed: boolean; reason?: string } | null = null;
        try { const m = text.match(/\{[\s\S]*\}/); if (m) verdict = JSON.parse(m[0]); } catch { verdict = null; }
        step.output = verdict ?? { passed: false, reason: '解析失败' };
        if (degraded || !this.hasLlm || !verdict) { step.status = 'degraded'; step.degraded = true; }
        return;
      }
      case 'Govern': {
        const attribution = ctx.attribution as Parameters<PatchGenerator['generate']>[0];
        const proposal = this.patchGen.generate(attribution, {
          target_id: ctx.run.skillId, target_version: '0.1.0',
          current_content: ctx.currentContent, proposed_content: ctx.proposedContent ?? ctx.currentContent,
          description: 'evolution propose',
        });
        const decision = await this.gates.runGates(proposal);
        step.output = decision;
        // GovernanceDecision.final_status: 'staged'|'rejected'|'needs_more_evidence';
        // human_review_required 为真时进入人工复核态（治理硬门槛，非自动应用）。
        if (decision.human_review_required || decision.final_status !== 'staged') {
          ctx.run.status = 'awaiting_review';
        }
        return;
      }
      case 'Apply':
        step.output = { note: 'Apply 写盘由 Feature 层执行', proposedContent: ctx.proposedContent };
        return;
      case 'Evolve':
        step.output = { note: '沉淀新版由 Feature 层执行' };
        return;
    }
  }

  private mustGet(runId: string): RunContext {
    const ctx = this.runs.get(runId);
    if (!ctx) throw new Error(`Unknown runId: ${runId}`);
    return ctx;
  }
}
