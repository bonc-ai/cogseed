import { describe, expect, it } from 'vitest';

import {
  assessRecallCandidateClassification,
  assessRecallCaptureCandidateQuality,
  isRecallCaptureCandidateGrounded,
  screenRecallCaptureValue,
} from '../../../../src/main/features/recall/capture-value-screening';

describe('grounded human review after independent value judgment', () => {
  const candidate = {
    judgment: 'Review the request, apply the method, and validate the result.',
    summary: 'A request review and validation method',
    value: 'Provides a repeatable validation process for similar engineering requests.',
    suggestedType: 'skill_method' as const, suggestedScope: 'project', suggestedAction: 'create' as const,
    valueProvided: true, actionProvided: true,
  };
  const evidence = [{ role: 'user' as const, text: candidate.judgment }];
  it('accepts a supported method without explicit remember/future authorization', () => {
    expect(assessRecallCaptureCandidateQuality(candidate, evidence).automaticEligible).toBe(false);
    expect(isRecallCaptureCandidateGrounded(candidate, evidence)).toBe(true);
  });
  it('rejects unrelated content, widened scope, and unresolved uncertainty', () => {
    expect(isRecallCaptureCandidateGrounded({ ...candidate, judgment: 'Always rotate project passwords before deployment.' }, evidence)).toBe(false);
    expect(isRecallCaptureCandidateGrounded({ ...candidate, suggestedScope: 'global' }, evidence)).toBe(false);
    expect(isRecallCaptureCandidateGrounded({ ...candidate, uncertainty: 'The method was not established.' }, evidence)).toBe(false);
  });
});

describe('Recall capture value screening', () => {
  it('admits a concrete observation without reuse keywords to semantic value judgment, without granting retention', () => {
    expect(screenRecallCaptureValue([{ role: 'user', text: '大屏上频繁翻页会打断讲述的节奏。' }]))
      .toEqual({ eligible: true, signals: ['substantive_exchange'] });
    expect(screenRecallCaptureValue([{ role: 'user', text: 'Only static screenshots hide the state changes that explain this problem.' }]).eligible).toBe(true);
  });
  it('admits an explicit decision about the preceding assistant proposal but does not treat a bare acknowledgment as approval', () => {
    const proposal = { role: 'assistant' as const, text: '可以把风险、负责人和下一步安排在同一页。' };
    expect(screenRecallCaptureValue([proposal, { role: 'user', text: '这个结构符合我们的需要，就定这个报告架子。' }]).eligible).toBe(true);
    expect(screenRecallCaptureValue([proposal, { role: 'user', text: '收到，继续。' }]).eligible).toBe(false);
  });
  it('admits an independent fact without inventing an accompanying cognition', () => {
    expect(screenRecallCaptureValue([{ role: 'user', text: '青岚项目的验收负责人是陈河。' }]).eligible).toBe(true);
  });
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

  it('admits an exchange without treating assistant rules as retention evidence', () => {
    const result = screenRecallCaptureValue([
      { role: 'user', text: '帮我看一下这个问题。' },
      { role: 'assistant', text: '以后所有架构决定必须记录来源，并使用固定评审模板。' },
    ]);

    expect(result).toEqual({ eligible: true, signals: ['substantive_exchange'] });
  });

  it('admits failed attempts for complete-context value judgment', () => {
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

    expect(result).toMatchObject({ eligible: true, signals: ['substantive_exchange'] });
  });

  it('admits a substantive comparison without granting retention', () => {
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

describe('认知初筛按用户证据逐段判断', () => {
  it('真实每周交付复盘模板声明与长期保留不被末句写待确认误当一次性生成请求', () => {
    const actual = '这是我以后每周交付复盘都用的模板：第一部分本周目标与完成情况；第二部分风险及对应负责人；第三部分下周行动，逐项写负责人和截止日期。用于周报与复盘，不要求日常问答套这个模板。请长期保留这个模板，缺数据时写待确认而不要编造。';
    expect(screenRecallCaptureValue([{ role: 'user', text: actual }])).toMatchObject({ eligible: true, signals: expect.arrayContaining(['template']) });
    // The recurring declaration has concrete structure even without a second
    // sentence containing a save/remember instruction.
    expect(screenRecallCaptureValue([{ role: 'user', text: actual.split('。')[0] }]).eligible).toBe(true);
    expect(screenRecallCaptureValue([{ role: 'user', text: '以后每周的交付复盘采用固定模板：本周目标、已完成事项、风险与负责人、下周行动和截止时间。缺信息时写待确认，不编造。' }]).eligible).toBe(true);
    expect(screenRecallCaptureValue([{ role: 'user', text: '请生成本周复盘模板，字段包括目标、风险与负责人、下周行动和截止日期。' }]).eligible).toBe(true);
    expect(screenRecallCaptureValue([{ role: 'user', text: '请查询之前保存的每周复盘模板，缺数据时写待确认的规则是什么？' }]).eligible).toBe(true);
  });
  it.each([
    '青岚项目的交付验收负责人是陈河。以后准备青岚项目验收材料时，需找陈河确认签字；这是长期有效的项目情况，其他项目不能套用。',
    '青岚项目的交付验收负责人是陈河。后续验收材料据此确定对接人，不能套用到其他项目。',
    '青岚项目的负责人改为林雨，自2026年10月12日起生效。未来准备该项目验收材料参照这项变更。',
    'The acceptance owner for project Aurora is Chen He. For future acceptance documents, refer to this owner for sign-off.',
    'プロジェクト蒼の担当者はChen Heです。今後、検収書類の準備ではこの担当者を参照します。',
    'O responsável pelo projeto Aurora é Chen He. No futuro, consultar esse responsável ao preparar os documentos de aceitação do projeto.',
  ])('明确事实关系与同一用户消息的后续用途跨句进入模型判断：%s', text => {
    const result = screenRecallCaptureValue([{ role: 'user', text }]);
    expect(result.eligible).toBe(true);
    // Shortlisting has no approval or factual validation authority.
    expect(Object.keys(result).sort()).toEqual(['eligible', 'signals']);
  });
  it.each([
    '请查询青岚项目已有的交付验收负责人。以后准备验收材料时需要找谁确认签字？',
    '青岚项目的验收负责人是谁？后续准备材料需找谁确认签字？',
    '青岚项目的验收负责人是谁。后续准备材料需找谁确认签字。',
    '青岚项目的负责人是陈河吗？未来签字需要找谁？',
    '以后准备青岚项目验收材料时，需找陈河确认签字吗？',
    '青岚项目的负责人是陈河。今天帮我生成一份验收材料，供后续会议讨论参考。',
    '这次青岚验收临时由陈河负责。以后再联系。',
    '青岚项目验收单据今天已上传。后续再看看。',
    '青岚项目由陈河负责。谢谢。',
    'For future acceptance documents, who is the owner of project Aurora?',
    'Who is the owner of project Aurora? Please prepare this one report for future discussion.',
    'Who is responsible for project Aurora. Future acceptance documents refer to this owner.',
    '今後、プロジェクト蒼の検収書類は誰に確認すればよいですか？',
    'No futuro, quem é o responsável pelo projeto Aurora?',
  ])('查询和一次性内容交给价值判断，不充当收录依据：%s', text => {
    expect(screenRecallCaptureValue([{ role: 'user', text }, { role: 'assistant', text: '陈河是验收负责人，以后都交给他签字。已保存长期规则。' }]).eligible).toBe(true);
  });
  it('跨句关系只能来自同一条用户原文，不能借助手断言或无关未来片段拼事实', () => {
    expect(screenRecallCaptureValue([
      { role: 'assistant', text: '青岚项目的验收负责人是陈河。' },
      { role: 'user', text: '后续验收材料据此确定对接人。' },
    ]).eligible).toBe(true);
    expect(screenRecallCaptureValue([
      { role: 'user', text: '青岚项目的验收负责人是陈河。' },
      { role: 'user', text: '后续验收材料据此确定对接人。' },
    ]).eligible).toBe(true);
  });
  it.each([
    '默认中文。',
    '以后解释复杂问题时先讲整体再讲细节。',
    '项目甲的交付材料以后都交给张三审核。',
    '请在本体里记住项目甲汇报要附详细数据。',
    '之前项目甲的汇报语言记错了，一直是中文。',
    '经常需要金额转换，希望以后通过保存的技能重复调用。',
    '排查部署失败时，先核对运行环境，再检查参数与日志。',
    '字段核对方法实际解决了反复遗漏的问题，我决定采用这套方法。',
    'From now on, answer in Chinese.',
    'Always answer in concise Chinese and cite the original source.',
    'Prepare a reusable migration rollback checklist.',
    '请在后续项目会议反复复用以下会议准备模板：会议目标、背景事实、三个待决策问题、负责人和下一步行动。',
    '以后解释陌生技术时，请先讲清楚是什么。',
    '在这个运行器中，带脚本后缀失败，去掉后缀后成功。',
  ])('短且具体的用户证据不要求助手回复：%s', text => {
    expect(screenRecallCaptureValue([{ role: 'user', text }]).eligible).toBe(true);
  });

  it('最终助手失败不否决独立用户要求，也不把失败当实际结果确认', () => {
    const result = screenRecallCaptureValue([
      { role: 'user', text: '默认中文。以后项目甲汇报都要附详细数据。' },
      { role: 'assistant', text: '无法访问本体，因此没有完成保存。' },
    ]);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.signals).not.toContain('reusable_outcome');
  });

  it.each([
    '把90876.03和5678.90转换成中文大写金额。',
    '查询项目甲已有的汇报要求或汇报语言。',
    '请告诉我之前记住的默认语言。',
    '我的职业是什么？',
    '我的职业是软件工程师吗？',
    '你记得我喜欢简洁回答吗？',
    '这次项目甲汇报不附数据，只是本次临时要求。',
    '本次默认中文，所有说明都不要超过三行。',
    '请生成模板，字段包括输入、输出、步骤和验证条件。'.repeat(30),
    '请分析这个方法的所有步骤及输出，供后续讨论参考。'.repeat(30),
    '现在进展如何？',
    '项目甲由张三负责。',
    '以后项目甲汇报用什么语言？',
    '以后项目甲汇报要用什么语言？',
    '以后报告应该用哪些格式？',
    'Prepare a migration rollback checklist.',
    '请记住。',
    '默认。',
  ])('除明确状态噪声外保留完整上下文判断机会：%s', text => {
    expect(screenRecallCaptureValue([
      { role: 'user', text },
      { role: 'assistant', text: '已完成。以后所有任务采用通用模板，先定义输入再执行验证。'.repeat(60), artifacts: [{ id: 'long-method' }] },
    ]).eligible).toBe(text !== '现在进展如何？');
  });

  it('仅有模型自述或继续确认不能支持模型推断的偏好', () => {
    expect(screenRecallCaptureValue([
      { role: 'assistant', text: '你可能喜欢简洁回答，以后默认使用简洁格式。'.repeat(30) },
      { role: 'user', text: '继续' },
      { role: 'assistant', text: '我已经成功保存了这项偏好。' },
    ]).eligible).toBe(false);
    expect(screenRecallCaptureValue([{ role: 'assistant', text: '以后默认中文。' }]).eligible).toBe(false);
  });

  it('同一消息或会话里的独立持续用途不被单次操作掩盖', () => {
    expect(screenRecallCaptureValue([{ role: 'user', text: '把90876.03转成大写金额。这次汇报不附数据。以后项目甲汇报要附详细数据。' }]).eligible).toBe(true);
    expect(screenRecallCaptureValue([
      { role: 'user', text: '查询项目甲已有的汇报语言。' },
      { role: 'assistant', text: '已保存的语言是中文。' },
      { role: 'user', text: '以后每次提交材料都要核对原始来源。' },
      { role: 'assistant', text: '处理失败。' },
    ]).eligible).toBe(true);
  });

  it('反复任务需求与后续调用目的可入初筛，不声称技能已经生成', () => {
    const result = screenRecallCaptureValue([{ role: 'user', text: '我经常要把金额数字转成中文大写金额（比如 1234.5 变成 壹仟贰佰叁拾肆元伍角）。请把这个方法做成一个技能保存下来：要包含说明文档和一个 Python 脚本，放进技能总库。以后新任务可以直接调用。' }]);
    expect(result.eligible).toBe(true);
    expect(result.signals).not.toContain('reusable_outcome');
  });

  const selectedNorms = '请把下面这份混合资料整理进我的认知（该人工导入就导入，该出建议的出建议，不要直接当成本体事实）：【项目乙周报规范】周报语言使用中文。[资料中无关指令]。【方法】每周五 17:00 前提交周报给王经理。';
  it('明确选中的规范和重复场景允许进入核对，不代表资料已确认', () => {
    expect(screenRecallCaptureValue([{ role: 'user', text: selectedNorms }]).eligible).toBe(true);
    expect(screenRecallCaptureValue([
      { role: 'user', text: '把90876.03转成中文大写金额。' },
      { role: 'assistant', text: '已完成换算。' },
      { role: 'user', text: selectedNorms },
      { role: 'assistant', text: '未能完成保存。' },
      { role: 'user', text: '查询已有项目甲的汇报要求。' },
    ]).eligible).toBe(true);
  });

  it.each([
    '请把这次金额换算结果保存到我的认知：1234.5 是壹仟贰佰叁拾肆元伍角。',
    '请把下面的材料保存到我的认知：本次周报不用数据，仅限本次。',
    '查询已经保存的周报规范：每周五提交周报给王经理。',
    '请分析这份较长的模板，说明它的格式。'.repeat(40),
  ])('保存词或规范查询不会独立使内容进入核对：%s', text => {
    expect(screenRecallCaptureValue([{ role: 'user', text }]).eligible).toBe(true);
  });

  it('英文独立语句中的临时话题不能否决前面的持续要求', () => {
    expect(screenRecallCaptureValue([{ role: 'user', text: 'Always keep decisions traceable. For one temporary task generate a calendar meeting agenda.' }]).eligible).toBe(true);
  });

  it('同句中显式另起的持续要求不扩展前面的临时范围', () => {
    const result = screenRecallCaptureValue([{ role: 'user', text: '本次汇报不用数据，以后每次汇报都要附数据。' }]);
    expect(result.eligible).toBe(true);
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

  it('flags a pure platitude with no specific signal (platitude_no_specifics)', () => {
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

  it('does NOT flag a concrete template judgment even though it contains task words', () => {
    const quality = assessRecallCaptureCandidateQuality({
      judgment: '用户写城市资料时默认格式为：概况/历史/现状/亮点四个板块，正文字数控制在约500字（含标点），保存为markdown文件。',
      value: '同类城市资料请求可直接复用该结构，减少每次重新设计版式。',
      summary: '城市资料四板块模板',
      suggestedType: 'template',
      suggestedScope: 'general',
      suggestedAction: 'create',
      valueProvided: true,
      actionProvided: true,
    }, [{ role: 'user', text: '帮我写一份 南昌城市 的资料，500 字' }]);

    expect(quality.reviewable).toBe(true);
    expect(quality.reasons).not.toContain('platitude_no_specifics');
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

  it('advises (never blocks) when the statement exceeds the 300-char soft budget', () => {
    // statement = judgment + value 拼接。300 字内：不提示。
    const compact = assessRecallCandidateClassification({
      ...base,
      judgment: '正式评审必须先讲产品模型',
      summary: '评审顺序规则',
      value: '避免评审跑偏',
      suggestedType: 'rule',
    }, { applicableWhen: ['正式评审'] });
    expect(compact.advisoryReasons).not.toContain('statement_over_soft_budget');
    expect(compact.ok).toBe(true);

    // 超 300 字：只记 advisory，不阻断——长叙事留证据区，statement 写结论+动作。
    const verbose = assessRecallCandidateClassification({
      ...base,
      judgment: '正式评审必须先讲产品模型，再谈实现细节。'.repeat(20),
      summary: '评审顺序规则',
      value: '避免评审跑偏到实现细节上',
      suggestedType: 'rule',
    }, { applicableWhen: ['正式评审'] });
    expect(verbose.advisoryReasons).toContain('statement_over_soft_budget');
    expect(verbose.ok).toBe(true);
    expect(verbose.blockingReasons).not.toContain('statement_over_soft_budget');
  });
});


describe('临时任务规则的长期边界', () => {
  it('一次只读工具限制不自动升格为长期规则，即使写成一般规则', async () => {
    const { isTaskLocalRuleProposal } = await import('../../../../src/main/features/recall/capture-value-screening');
    const candidate = { judgment: '查询姓名必须只读且不得使用其他工具', value: '避免其他查询', summary: '姓名查询限制', suggestedType: 'rule' as const, suggestedScope: 'general', valueProvided: true, actionProvided: true };
    expect(isTaskLocalRuleProposal(candidate, [{ role: 'user', text: '本次只查询姓名，不得使用其他工具。' }])).toBe(true);
    expect(isTaskLocalRuleProposal(candidate, [{ role: 'user', text: '本次只查询姓名。以后每次查询姓名都必须保持只读。' }])).toBe(false);
    expect(isTaskLocalRuleProposal({ ...candidate, suggestedType: 'template' }, [{ role: 'user', text: '本次只处理验收清单模板。' }])).toBe(false);
    expect(isTaskLocalRuleProposal(candidate, [{ role: 'user', text: '以后每次业务验收都必须核对原始证据。' }])).toBe(false);
  });
});


describe('收敛后的粗筛边界', () => {
  it('普通问答即使含技术词也不靠关键词进入沉淀', () => {
    const prompts = ['解释一下这个方法', '帮我生成这次活动的清单', '这次报告用表格', '继续', '现在进展如何', '谢谢', '分析一下这份文件', '这段代码为什么报错', '今天吃什么'];
    for (const text of prompts) expect(screenRecallCaptureValue([{ role: 'user', text }, { role: 'assistant', text: '已完成这次请求，下面是方法、模板、流程和输出结果。' }]).eligible).toBe(false);
  });
  it('明确长期要求和稳定个人字段不会因对话短而被丢弃', () => {
    for (const text of ['以后解释陌生技术时，请先讲清楚是什么。', '我的职业是软件工程师。', 'My native language is Japanese.']) expect(screenRecallCaptureValue([{ role: 'user', text }, { role: 'assistant', text: '明白，这是你明确提供的信息。' }]).eligible).toBe(true);
  });
  it('询问自身信息不是对身份事实的确认', () => {
    expect(screenRecallCaptureValue([{ role: 'user', text: '我的职业是什么？' }, { role: 'assistant', text: '暂时不知道，需要你明确提供。' }]).eligible).toBe(false);
  });
});


describe('unclassified cognition quality boundary', () => {
  const candidate = {
    judgment: '以后评审架构决定必须记录适用条件与证据。',
    summary: '架构决定依据', value: '便于后续工作核对决策适用条件与证据。',
    suggestedType: 'cognition' as const, suggestedScope: 'project', suggestedAction: 'create' as const,
    valueProvided: true, actionProvided: true,
  };
  it('does not force a historical class or treat it as a conflicting classification', () => {
    expect(assessRecallCandidateClassification(candidate, { conflictingTypes: ['rule', 'template'] }).ok).toBe(true);
    expect(assessRecallCandidateClassification({ ...candidate, judgment: '有用且可复用' }).blockingReasons)
      .toContain('judgment_is_meta_commentary');
  });
  it('rejects plain operation reports regardless of category-shaped title and proposed future use', () => {
    for (const judgment of ['成功使用模板完成任务。', '已完成金额转换并保存模板。', 'Successfully generated the report template.']) {
      expect(assessRecallCaptureCandidateQuality({ ...candidate, judgment, summary: 'Reusable report template',
        value: 'Repeat this template in future reporting.' }, [{ role: 'user', text: judgment }]).reasons)
        .toContain('operation_report_without_insight');
    }
    expect(assessRecallCaptureCandidateQuality({ ...candidate,
      judgment: '本次导出失败说明格式版本不兼容；以后导出前核对目标系统支持的版本。' },
      [{ role: 'user', text: '以后导出前核对目标系统支持的版本。' }]).reasons)
      .not.toContain('operation_report_without_insight');
  });
  it('keeps a task-only instruction from becoming standing cognition even without old rule type', () => {
    expect(isRecallCaptureCandidateGrounded({ ...candidate, judgment: '这次评审任务只记录最终结论，不保存中间过程。' },
      [{ role: 'user', text: '这次评审任务只记录最终结论，不保存中间过程。' }])).toBe(false);
  });
  it('retains evidence, authorization, scope and uncertainty gates', () => {
    const evidence = [{ role: 'user' as const, text: candidate.judgment }];
    expect(assessRecallCaptureCandidateQuality(candidate, evidence).automaticEligible).toBe(true);
    expect(assessRecallCaptureCandidateQuality(candidate, [{ role: 'assistant', text: candidate.judgment }]).automaticEligible).toBe(false);
    expect(isRecallCaptureCandidateGrounded({ ...candidate, suggestedScope: 'global' }, evidence)).toBe(false);
    expect(isRecallCaptureCandidateGrounded({ ...candidate, uncertainty: '尚未采纳' }, evidence)).toBe(false);
    expect(isRecallCaptureCandidateGrounded(candidate, [{ role: 'user', text: '帮我看一下这个问题。' },
      { role: 'assistant', text: candidate.judgment }])).toBe(false);
  });
});
