import { describe, expect, it } from 'vitest';

import { validatePromotionByAssetType } from '../../../../src/main/features/recall/formal-assets/promotion';

const base = { suggestedScope: 'review', suggestedAction: 'create' as const };

describe('formal asset promotion gate', () => {
  // PRD 3.4：项目与任务事实留在 Workspace / Project 支撑记录，不是"关于我"。
  it('blocks a task fact from becoming a personal asset', () => {
    const result = validatePromotionByAssetType({
      ...base,
      judgment: '我今天在修 KSTAR 的候选池',
      value: '记录当前进度',
      summary: '当前任务',
      suggestedType: 'personal',
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('personal_is_project_fact');
  });

  // PRD 3.2：原文件保持 CognitionSource 身份，只有提炼出的可复用结构才是模板。
  it('blocks a source file from becoming a template asset', () => {
    const result = validatePromotionByAssetType({
      ...base,
      judgment: '保存这份 PRD.docx 以后参考',
      value: '以后可以再看',
      summary: '上传的文件',
      suggestedType: 'template',
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('template_not_reusable_structure');
  });

  it('blocks a capability claim from becoming a method asset', () => {
    const result = validatePromotionByAssetType({
      ...base,
      judgment: '我擅长写 PRD',
      value: '以后写 PRD 会更快',
      summary: '写作能力',
      suggestedType: 'skill_method',
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('skill_not_executable');
  });

  // PRD 3.1 给 RuleAsset 的最低门槛：用户确认来源、作用域、适用与禁止范围。
  // 系统线没有人可确认，缺边界只能停在候选——把 undefined 当「无限制」写进
  // 正式资产，等于凭空造出一条没有边界的规则。
  it('blocks a boundary-less rule on the system line', () => {
    const candidate = {
      ...base,
      judgment: '正式评审必须先讲产品模型，再谈实现细节',
      value: '避免评审跑偏到实现细节上',
      summary: '评审顺序规则',
      suggestedType: 'rule' as const,
    };
    const system = validatePromotionByAssetType(candidate, { actor: 'system' });
    expect(system.ok).toBe(false);
    expect(system.reasons).toContain('rule_boundary_required');

    // 用户路径可以在评审时补边界，所以只提示、不阻断。
    const user = validatePromotionByAssetType(candidate, { actor: 'user' });
    expect(user.ok).toBe(true);
    expect(user.advisories).toContain('rule_missing_boundary');
  });

  it('lets a rule through once the extraction proposed both boundaries', () => {
    const result = validatePromotionByAssetType({
      ...base,
      judgment: '正式评审必须先讲产品模型，再谈实现细节',
      value: '避免评审跑偏到实现细节上',
      summary: '评审顺序规则',
      suggestedType: 'rule',
      applicableWhen: ['正式评审'],
      forbiddenWhen: ['内部快速对齐'],
    }, { actor: 'system' });

    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.advisories).not.toContain('rule_missing_boundary');
  });

  it('accepts a method that states its executable shape', () => {
    const result = validatePromotionByAssetType({
      ...base,
      judgment: '进入新产品定义阶段时，先做问题定义，再建对象模型，然后画 Golden Path；输出一份 PRD，验收标准是完整性与可验证性都通过复核。',
      value: '同类任务可以按同一套步骤走完',
      summary: '复杂产品 PRD 编写方法',
      suggestedType: 'skill_method',
    }, { actor: 'system' });

    expect(result.ok).toBe(true);
  });
  // 审计实测：真实候选池里出现过「有用且可复用」「有用，体现用户对智能体的
  // 期望行为」——它们评价的是"这条候选值不值得留"，不是任何可复用内容。
  it.each([
    '有用且可复用',
    '有用，体现用户对智能体的期望行为',
    '很有价值，值得沉淀',
  ])('blocks meta-commentary judgment: %s', (judgment) => {
    for (const suggestedType of ['personal', 'rule', 'template', 'skill_method'] as const) {
      const result = validatePromotionByAssetType({
        ...base,
        judgment,
        value: '以后能用上',
        summary: '有用',
        suggestedType,
        applicableWhen: ['任意场景'],
        forbiddenWhen: ['无'],
      });
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('judgment_is_meta_commentary');
    }
  });

  it('keeps a normal judgment that merely mentions reuse', () => {
    const result = validatePromotionByAssetType({
      ...base,
      judgment: '接口评审先定错误码，这条做法可复用到所有对外接口。',
      value: '避免联调阶段才补错误码',
      summary: '错误码先定',
      suggestedType: 'rule',
      applicableWhen: ['对外接口评审'],
      forbiddenWhen: ['内部临时脚本'],
    });
    expect(result.ok).toBe(true);
  });

  // 审计实测：「有用且可复用」同时以 template 和 skill_method 各存一条。
  // 同一句话被分成两类，至少一边分错了——谁都不晋升。
  it('blocks when the same wording already exists under another type', () => {
    const result = validatePromotionByAssetType({
      ...base,
      judgment: '接口评审按边界、错误码、意见的顺序进行：先划边界，再核错误码，最后给意见。',
      value: '同类评审可以直接照这个顺序走',
      summary: '评审顺序',
      suggestedType: 'skill_method',
      conflictingTypes: ['template'],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('type_conflicts_with_existing');
  });

  it('ignores a conflicting type entry that matches its own type', () => {
    const result = validatePromotionByAssetType({
      ...base,
      judgment: '接口评审按边界、错误码、意见的顺序进行：先划边界，再核错误码，最后给意见。',
      value: '同类评审可以直接照这个顺序走',
      summary: '评审顺序',
      suggestedType: 'skill_method',
      conflictingTypes: ['skill_method'],
    });
    expect(result.ok).toBe(true);
  });
});
