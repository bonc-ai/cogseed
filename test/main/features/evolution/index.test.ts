import { describe, it, expect } from 'vitest';
import * as evolution from '../../../../src/main/features/evolution/index';

describe('evolution feature barrel', () => {
  it('导出编排/评估/看板/本体/补丁的公共函数', () => {
    expect(evolution.startEvolutionRun).toBeTypeOf('function');
    expect(evolution.stepEvolutionRun).toBeTypeOf('function');
    expect(evolution.abortEvolutionRun).toBeTypeOf('function');
    expect(evolution.readEvolutionRun).toBeTypeOf('function');
    expect(evolution.listEvolutionRuns).toBeTypeOf('function');
    expect(evolution.readEvalRecord).toBeTypeOf('function');
    expect(evolution.saveEvalRecord).toBeTypeOf('function');
    expect(evolution.buildDashboard).toBeTypeOf('function');
    expect(evolution.extractAndSaveOntology).toBeTypeOf('function');
    expect(evolution.listSkillOntologies).toBeTypeOf('function');
    expect(evolution.applyPatchToSkill).toBeTypeOf('function');
  });
});
