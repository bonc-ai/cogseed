import { describe, it, expect } from 'vitest';
import * as engine from '../src/engine';

describe('engine public exports (pure barrel, no server start)', () => {
  it('导出 OntologyWriter / EvolutionOrchestrator / llm-port / KSTAR_STEPS', () => {
    expect(engine.OntologyWriter).toBeTypeOf('function');
    expect(engine.OntologyReader).toBeTypeOf('function');
    expect(engine.EvolutionOrchestrator).toBeTypeOf('function');
    expect(engine.SkillCreator).toBeTypeOf('function');
    expect(engine.ruleFallbackComplete).toBeTypeOf('function');
    expect(engine.KSTAR_STEPS).toEqual(['Capture', 'Attribution', 'Propose', 'Evaluate', 'Govern', 'Apply', 'Evolve']);
  });
});
