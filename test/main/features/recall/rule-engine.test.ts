import { describe, expect, it } from 'vitest';
import { evaluateRules } from '../../../../src/main/features/recall/rule-engine';

describe('KStar rule engine (minimal closed loop)', () => {
  it('matches ontology R-Box rules whose concept appears in the task text', () => {
    const result = evaluateRules({
      taskText: '审查 OAuth 登录回调的消息路由',
      ontologyRules: [
        {
          id: 'ontr-abc',
          groupId: 'g-1',
          groupTitle: '技术栈',
          field: '工具',
          subject: 'React',
          relation: 'relates_to',
          object: '前端框架',
        },
        {
          id: 'ontr-def',
          groupId: 'g-2',
          groupTitle: '认证',
          field: '协议',
          subject: 'OAuth',
          relation: 'relates_to',
          object: '回调安全',
        },
      ],
      assetRules: [],
    });

    // OAuth appears in the task → the authentication rule fires; React does
    // not appear → the tech-stack rule stays quiet.
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0]).toMatchObject({
      source: 'ontology',
      ruleId: 'ontr-def',
      subject: 'OAuth',
      object: '回调安全',
    });
  });

  it('matches asset ΔR lessons by cause/effect/mitigation text', () => {
    const result = evaluateRules({
      taskText: 'OAuth callback state validation missing',
      ontologyRules: [],
      assetRules: [
        {
          assetId: 'aa-x',
          rule: {
            cause: 'OAuth state is not checked',
            effect: 'The callback can accept an invalid session',
            mitigation: 'Validate state before exchanging the code',
            severity: 'high',
            deltaR: -0.8,
          },
        },
      ],
    });

    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0]).toMatchObject({
      source: 'asset',
      assetId: 'aa-x',
      severity: 'high',
      deltaR: -0.8,
    });
  });

  it('returns nothing when no rule trigger fires', () => {
    const result = evaluateRules({
      taskText: '随便聊聊',
      ontologyRules: [
        {
          id: 'ontr-x',
          groupId: 'g-1',
          groupTitle: '技术栈',
          field: '工具',
          subject: 'React',
          relation: 'relates_to',
          object: '前端框架',
        },
      ],
      assetRules: [],
    });
    expect(result.matchedRules).toEqual([]);
  });

  it('is bounded to a sane maximum', () => {
    const rules = Array.from({ length: 30 }, (_, index) => ({
      id: `ontr-${index}`,
      groupId: 'g-1',
      groupTitle: '技术栈',
      field: '工具',
      subject: 'React',
      relation: 'relates_to',
      object: `框架${index}`,
    }));
    const result = evaluateRules({ taskText: 'React 技术栈', ontologyRules: rules, assetRules: [] });
    expect(result.matchedRules.length).toBeLessThanOrEqual(12);
  });
});
