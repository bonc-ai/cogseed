import { describe, expect, it } from 'vitest';

import {
  assessRecallCandidateClassification,
  assessRecallCaptureCandidateQuality,
  screenRecallCaptureValue,
} from '../../../../src/main/features/recall/capture-value-screening';

describe('Recall capture value screening', () => {
  it.each([
    ['你好', '你好，有什么可以帮你？'],
    ['谢谢', '不客气。'],
    ['同意', '好的。'],
    ['现在到哪阶段了', '正在处理中。'],
  ])('filters trivial exchange: %s', (userText, assistantText) => {
    expect(screenRecallCaptureValue([
      { role: 'user', text: userText },
      { role: 'assistant', text: assistantText },
    ])).toEqual({ eligible: false, signals: [], reason: 'trivial_exchange' });
  });

  it('recognizes durable intent stated by the user and delivered artifacts', () => {
    const result = screenRecallCaptureValue([
      { role: 'user', text: '以后请保持结论简短，并且所有决策必须附带来源。' },
      {
        role: 'assistant',
        text: '已完成决策记录模板，并校验了来源字段。',
        artifacts: [{ id: 'artifact-a' }],
      },
    ]);

    expect(result.eligible).toBe(true);
    expect(result.signals).toEqual(expect.arrayContaining([
      'preference',
      'rule',
      'artifact',
    ]));
  });

  it('does not treat the assistant restating a rule as user intent', () => {
    const result = screenRecallCaptureValue([
      { role: 'user', text: '帮我看一下这个问题。' },
      { role: 'assistant', text: '以后所有架构决定必须记录来源，并使用固定评审模板。' },
    ]);

    expect(result).toEqual({ eligible: false, signals: [], reason: 'low_reuse_value' });
  });

  it('filters a long exchange when the assistant produced no result', () => {
    const result = screenRecallCaptureValue([
      {
        role: 'user',
        text: '请分析这份较长的项目材料，整理其中的背景、问题、影响范围和后续建议，供团队下一轮讨论使用。',
      },
      {
        role: 'assistant',
        text: '无法访问相关材料，因此未能完成分析，也没有生成可交付的结果。',
      },
    ]);

    expect(result).toMatchObject({ eligible: false, reason: 'no_result' });
  });

  it('allows a substantial exchange through for model-level judgment', () => {
    const result = screenRecallCaptureValue([
      {
        role: 'user',
        text: '请比较当前两套信息组织方案的维护成本、协作风险和扩展边界，并给出适用于这个项目的取舍依据。',
      },
      {
        role: 'user',
        text: '还需要覆盖多人协作时的信息同步成本、后续维护负担，以及团队规模变化后的适配边界。',
      },
      {
        role: 'assistant',
        text: '方案一维护入口集中，适合当前规模；方案二扩展能力更强，但会增加同步成本。结合团队人数和交付周期，当前应采用方案一，并保留后续迁移边界。',
      },
    ]);

    expect(result).toEqual({ eligible: true, signals: ['substantive_exchange'] });
  });
});

describe('Recall capture candidate quality', () => {
  const evidence = [{ role: 'user' as const, text: '所有架构决定必须记录来源。' }];

  it('allows an explicit future rule to be written automatically', () => {
    expect(assessRecallCaptureCandidateQuality({
      judgment: '所有架构决定必须记录来源。',
      value: '减少后续评审时重复追溯决策背景的成本。',
      summary: '架构决定来源规则',
      suggestedType: 'rule',
      suggestedScope: 'project',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '以后所有架构决定都必须记录来源。' }])).toEqual({
      reviewable: true,
      reasons: [],
      automaticEligible: true,
      automaticIneligibilityReasons: [],
    });
  });

  it('rejects a candidate that omits value and action', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '记录一下。',
      value: '',
      summary: '记录',
      suggestedType: 'rule',
      suggestedScope: 'project',
      valueProvided: false,
      actionProvided: false,
    }, evidence);

    expect(quality.reviewable).toBe(false);
    expect(quality.reasons).toEqual(expect.arrayContaining([
      'missing_value',
      'missing_action',
      'candidate_too_short',
      'candidate_not_reusable',
    ]));
    expect(quality.automaticEligible).toBe(false);
    expect(quality.automaticIneligibilityReasons).toEqual(expect.arrayContaining([
      'missing_value',
      'missing_action',
    ]));
  });

  it('flags a judgment that merely restates a task request (platitude_restates_task)', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '写一份成都资料，500 字',
      value: '减少用户重复发同类请求的成本。',
      summary: '成都资料',
      suggestedType: 'template',
      suggestedScope: 'general',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '帮我写一份成都资料，500 字' }]);

    expect(quality.reviewable).toBe(false);
    expect(quality.reasons).toContain('platitude_restates_task');
  });

  it('does NOT flag a judgment that matches a user-stated rule (message itself is knowledge)', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '所有架构决定必须记录来源。',
      value: '减少后续评审时重复追溯决策背景的成本。',
      summary: '架构决定来源规则',
      suggestedType: 'rule',
      suggestedScope: 'project',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: 'Always keep decisions traceable.' }]);

    expect(quality.reviewable).toBe(true);
    expect(quality.reasons).not.toContain('platitude_restates_task');
  });

  it('flags a platitude without any specific signal (platitude_no_specifics)', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '认真完成了任务，已按时交付。',
      value: '以后同类任务也能顺利完成。',
      summary: '完成任务',
      suggestedType: 'rule',
      suggestedScope: 'general',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '帮我写一份成都资料，500 字' }]);

    expect(quality.reviewable).toBe(false);
    expect(quality.reasons).toContain('platitude_no_specifics');
  });

  it('requires a target asset for update-like actions', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '将项目评审模板增加来源字段。',
      value: '让每次评审都能直接追溯输入依据。',
      summary: '更新评审模板',
      suggestedType: 'template',
      suggestedScope: 'project',
      suggestedAction: 'update',
      valueProvided: true,
      actionProvided: true,
    }, evidence);

    expect(quality).toMatchObject({ reviewable: false });
    expect(quality.reasons).toContain('missing_target');
    expect(quality.automaticEligible).toBe(false);
    expect(quality.automaticIneligibilityReasons).toContain('missing_target');
  });

  it('keeps a one-off request manually reviewable but blocks automatic writing', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '将这次对话整理为可复用的智能体工作流。',
      value: '减少本次会话整理和配置智能体的重复操作。',
      summary: '对话转智能体',
      suggestedType: 'skill_method',
      suggestedScope: 'project',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '帮我把以上对话整理成一个新的智能体。' }]);

    expect(quality.reviewable).toBe(true);
    expect(quality.automaticEligible).toBe(false);
    expect(quality.automaticIneligibilityReasons).toEqual(expect.arrayContaining([
      'missing_durable_user_intent',
      'one_off_request',
    ]));
  });

  it('requires explicit reuse intent before an artifact can be written automatically', () => {
    const candidate = {
      judgment: '保留架构评审模板。',
      value: '让后续评审可以直接沿用一致的字段和记录方式。',
      summary: '架构评审模板',
      suggestedType: 'template' as const,
      suggestedScope: 'project',
      suggestedAction: 'create' as const,
      valueProvided: true,
      actionProvided: true,
    };
    const artifact = { id: 'review-template' };

    const oneOff = assessRecallCaptureCandidateQuality(candidate, [
      { role: 'user', text: '请生成一份架构评审模板。' },
      { role: 'assistant', text: '模板已生成。', artifacts: [artifact] },
    ]);
    expect(oneOff.reviewable).toBe(true);
    expect(oneOff.automaticEligible).toBe(false);
    expect(oneOff.automaticIneligibilityReasons).toEqual(expect.arrayContaining([
      'missing_durable_user_intent',
      'artifact_without_reuse_intent',
    ]));

    const reusable = assessRecallCaptureCandidateQuality(candidate, [
      { role: 'user', text: '请生成一份以后每次架构评审都复用的模板。' },
      { role: 'assistant', text: '模板已生成。', artifacts: [artifact] },
    ]);
    expect(reusable).toEqual({
      reviewable: true,
      reasons: [],
      automaticEligible: true,
      automaticIneligibilityReasons: [],
    });
  });

  it('keeps an uncertain candidate reviewable but blocks automatic writing', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '所有架构决定必须记录来源。',
      value: '减少后续评审时重复追溯决策背景的成本。',
      summary: '架构决定来源规则',
      uncertainty: '不确定这条规则是否只适用于当前项目。',
      suggestedType: 'rule',
      suggestedScope: 'project',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '以后所有架构决定都必须记录来源。' }]);

    expect(quality).toEqual({
      reviewable: true,
      reasons: [],
      automaticEligible: false,
      automaticIneligibilityReasons: ['uncertainty_present'],
    });
  });

  it('keeps a high-risk candidate reviewable but requires a manual risk gate', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '所有生产部署必须执行可回滚发布流程。',
      value: '降低生产变更失败后无法恢复的风险。',
      summary: '生产部署回滚流程',
      suggestedType: 'skill_method',
      suggestedScope: 'project',
      suggestedAction: 'create',
      risk: 'high',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '以后所有生产部署都必须执行可回滚发布流程。' }]);

    expect(quality).toEqual({
      reviewable: true,
      reasons: [],
      automaticEligible: false,
      automaticIneligibilityReasons: ['high_risk_requires_review'],
    });
  });

  it('does not allow assistant-only evidence to qualify for automatic writing', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '所有架构决定必须记录来源。',
      value: '减少后续评审时重复追溯决策背景的成本。',
      summary: '架构决定来源规则',
      suggestedType: 'rule',
      suggestedScope: 'project',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'assistant', text: '以后所有架构决定都必须记录来源。' }]);

    expect(quality.reviewable).toBe(false);
    expect(quality.automaticEligible).toBe(false);
    expect(quality.automaticIneligibilityReasons).toEqual(expect.arrayContaining([
      'missing_user_evidence',
      'assistant_only_evidence',
    ]));
  });

  it('keeps vague ordinary exchanges out of automatic writing', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '使用简短审阅模板。',
      value: '让日常审阅的结论更容易阅读和归档。',
      summary: '简短审阅模板',
      suggestedType: 'template',
      suggestedScope: 'project',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '这段内容怎么样？' }]);

    expect(quality.reviewable).toBe(true);
    expect(quality.automaticEligible).toBe(false);
    expect(quality.automaticIneligibilityReasons).toEqual(expect.arrayContaining([
      'missing_durable_user_intent',
      'vague_user_evidence',
    ]));
  });

  it('blocks a candidate that reverses the user rule despite sharing the same nouns', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '以后所有部署默认无需审核，可以直接发布。',
      value: '减少部署前的人工检查步骤。',
      summary: '部署直接发布规则',
      suggestedType: 'rule',
      suggestedScope: 'project',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '以后所有部署必须审核，不要直接发布。' }]);

    expect(quality.reviewable).toBe(true);
    expect(quality.automaticEligible).toBe(false);
    expect(quality.automaticIneligibilityReasons).toContain('candidate_conflicts_with_user_intent');
  });

  it('does not expand a project rule to global scope without explicit user support', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '所有架构决定必须记录来源。',
      value: '减少后续评审时重复追溯决策背景的成本。',
      summary: '架构决定来源规则',
      suggestedType: 'rule',
      suggestedScope: 'global',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '以后所有架构决定都必须记录来源。' }]);

    expect(quality.reviewable).toBe(true);
    expect(quality.automaticEligible).toBe(false);
    expect(quality.automaticIneligibilityReasons).toContain('candidate_scope_not_supported_by_user_intent');
  });

  it.each([
    {
      language: 'Japanese',
      user: '今後、すべてのリリースで必ずロールバック手順を確認してください。',
      judgment: 'すべてのリリースで、必ずロールバック手順を確認する。',
      summary: 'ロールバック確認ルール',
      value: 'リリース失敗時の復旧リスクを減らす。',
    },
    {
      language: 'Portuguese',
      user: 'Daqui em diante, em toda implantação, sempre verifique o plano de rollback antes de publicar.',
      judgment: 'Em toda implantação, verificar sempre o plano de rollback antes de publicar.',
      summary: 'Verificação de rollback',
      value: 'Reduz o risco de uma publicação sem plano de recuperação.',
    },
  ])('recognizes explicit durable $language rules', ({ user, judgment, summary, value }) => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment,
      value,
      summary,
      suggestedType: 'rule',
      suggestedScope: 'project',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: user }]);

    expect(quality).toEqual({
      reviewable: true,
      reasons: [],
      automaticEligible: true,
      automaticIneligibilityReasons: [],
    });
  });
});

// 归类校验守的是 PRD 3.1/3.2/3.3 的硬边界：提示词只能"要求"模型按四类定义
// 分类，这一层保证它没照做时候选也进不了 pending_review。
describe('Recall candidate classification gate', () => {
  const base = {
    suggestedScope: 'project',
    suggestedAction: 'create' as const,
    valueProvided: true,
    actionProvided: true,
  };

  it('rejects a current-task fact claiming to be a personal ontology asset', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: '我今天在修 KSTAR 的候选池',
      summary: '当前任务',
      value: '记录当前进度',
      suggestedType: 'personal',
    });

    expect(result.ok).toBe(false);
    expect(result.blockingReasons).toContain('personal_is_project_fact');
  });

  it('accepts a durable personal preference', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: '我长期更喜欢先看整体结构再看细节',
      summary: '结构优先',
      value: '后续任务先给结构再展开，可以少一轮返工',
      suggestedType: 'personal',
    });

    expect(result.ok).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  it('rejects a raw source file claiming to be a template', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: '保存这份 PRD.docx 以后参考',
      summary: '上传的文件',
      value: '以后可以再看',
      suggestedType: 'template',
    });

    expect(result.ok).toBe(false);
    expect(result.blockingReasons).toContain('template_not_reusable_structure');
  });

  it('accepts a reusable structure extracted from a source file', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: '复杂 AI 产品 PRD 的稳定章节结构：问题定义、对象模型、边界、验收标准',
      summary: 'PRD 章节模板',
      value: '下次写同类 PRD 可以直接套用这个大纲',
      suggestedType: 'template',
    });

    expect(result.ok).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  it('rejects a bare capability claim typed as a method', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: '我擅长写 PRD',
      summary: '写作能力',
      value: '以后写 PRD 会更快',
      suggestedType: 'skill_method',
    });

    expect(result.ok).toBe(false);
    expect(result.blockingReasons).toContain('skill_not_executable');
  });

  // 归类层只拦"根本不是方法"的东西。完整 SkillManifest 校验属于 Skill 正式
  // 准入（PRD 8.2），放在这里会误伤逗号连接的正常写法。
  it('accepts a comma-joined action sequence as a method', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: 'Review the request, apply the method, and validate the result.',
      summary: 'Evidence-first review method',
      value: 'Keeps later reviews from skipping the validation step.',
      suggestedType: 'skill_method',
    });

    expect(result.ok).toBe(true);
    expect(result.advisoryReasons).toContain('skill_shape_incomplete');
  });

  it('accepts a method that states trigger, plan, output and validation', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: '进入新产品定义阶段时，先做问题定义，再建对象模型，然后画 Golden Path，最后补边界；输出一份 PRD，验收标准是完整性与可验证性都通过复核。',
      summary: '复杂产品 PRD 编写方法',
      value: '同类任务可以按同一套步骤走完，不用每次重新设计流程',
      suggestedType: 'skill_method',
    });

    expect(result.ok).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  it('flags a rule without applicable or forbidden boundaries without blocking it', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: '正式评审必须先讲产品模型，再谈实现细节',
      summary: '评审顺序规则',
      value: '避免评审跑偏到实现细节上',
      suggestedType: 'rule',
    });

    // PRD 3.1 要求 RuleAsset 确认适用与禁止范围，但缺失时如何处置尚未冻结
    // （spec Q1）。在决策前只如实记录，不改变自动线产能。
    expect(result.ok).toBe(true);
    expect(result.advisoryReasons).toContain('rule_missing_boundary');
  });

  it('stops flagging a rule once boundaries are supplied', () => {
    const result = assessRecallCandidateClassification({
      ...base,
      judgment: '正式评审必须先讲产品模型，再谈实现细节',
      summary: '评审顺序规则',
      value: '避免评审跑偏到实现细节上',
      suggestedType: 'rule',
    }, { applicableWhen: ['正式评审'], forbiddenWhen: ['内部快速对齐'] });

    expect(result.advisoryReasons).not.toContain('rule_missing_boundary');
  });
});
