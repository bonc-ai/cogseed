import { loadEngine } from './engine-loader';
import { createCustomSkill } from '../skills';

// 技能创建向导:捕获结构化意图 + 访谈问题(引擎,无副作用),再委托既有
// skills.createCustomSkill 沙箱路径建技能目录。不自绕沙箱写盘。
type CreateFn = (name: string, description: string, category: string) => Promise<{ id: string; name: string }>;

interface IntentInput {
  name: string;
  purpose: string;
  trigger_contexts: string[];
  output_format: string;
  edge_cases?: string[];
  dependencies?: string[];
  examples?: Array<{ input: string; expected_output: string }>;
}

export async function captureSkillIntent(
  _uid: string, input: IntentInput,
): Promise<{ skill_id: string; intent: unknown; questions: string[] }> {
  const engine = await loadEngine();
  const Ctor = engine.SkillCreator as new () => {
    captureIntent: (opts: IntentInput) => { skill_id: string; intent: unknown; questions: string[] };
  };
  const sc = new Ctor();
  return sc.captureIntent(input);
}

interface DraftInput { name: string; description: string; category: string; }

export async function createSkillFromDraft(
  _uid: string, input: DraftInput, createFn: CreateFn = createCustomSkill,
): Promise<{ skill: { id: string; name: string } }> {
  const name = (input.name || '').trim();
  if (!name) throw new Error('missing skill name');
  const skill = await createFn(name, input.description || '', input.category || '');
  return { skill };
}
