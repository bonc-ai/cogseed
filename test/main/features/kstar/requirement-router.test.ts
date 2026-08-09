import { describe, expect, it } from 'vitest';
import {
  routeRequirementIntent,
  type KstarRequirementClassifier,
} from '../../../../src/main/features/kstar/requirement-router';

const classify = (intent: 'new' | 'continue' | 'complete' | 'topic_switch'): KstarRequirementClassifier =>
  async (input) => ({
    intent,
    confidence: 0.91,
    reason: `model classified ${input.text}`,
    requirementText: input.text,
  });

describe('routeRequirementIntent', () => {
  it('uses the model classifier for semantic routing', async () => {
    await expect(routeRequirementIntent('user-a', {
      text: '另外还要检查 refresh token', hasOpenTask: true, hasOpenRequirement: true,
    }, { classify: classify('new') })).resolves.toMatchObject({ intent: 'new', method: 'model' });
  });

  it('routes explicit model completion as complete', async () => {
    await expect(routeRequirementIntent('user-a', {
      text: '这个任务完成了，收尾吧', hasOpenTask: true, hasOpenRequirement: true,
    }, { classify: classify('complete') })).resolves.toMatchObject({ intent: 'complete', method: 'model' });
  });

  it('routes model topic switch as topic_switch', async () => {
    await expect(routeRequirementIntent('user-a', {
      text: '换个话题，帮我设计发票导出', hasOpenTask: true, hasOpenRequirement: true,
    }, { classify: classify('topic_switch') })).resolves.toMatchObject({ intent: 'topic_switch', method: 'model' });
  });

  it('forces only explicit non-semantic UI completion actions', async () => {
    await expect(routeRequirementIntent('user-a', {
      text: '请继续整理上下文', hasOpenTask: true, hasOpenRequirement: true, forcedIntent: 'complete',
    }, { classify: classify('continue') })).resolves.toMatchObject({ intent: 'complete', method: 'forced' });
  });

  it('falls back to continue for ambiguous open-task messages when classification fails', async () => {
    await expect(routeRequirementIntent('user-a', {
      text: '再补一个测试', hasOpenTask: true, hasOpenRequirement: true,
    }, { classify: async () => { throw new Error('model unavailable'); } })).resolves.toMatchObject({ intent: 'continue', method: 'fallback' });
  });

  it('falls back to new when no task is open', async () => {
    await expect(routeRequirementIntent('user-a', {
      text: '审查 OAuth 登录实现', hasOpenTask: false, hasOpenRequirement: false,
    }, { classify: async () => { throw new Error('model unavailable'); } })).resolves.toMatchObject({ intent: 'new', method: 'fallback' });
  });

  it('falls back when the classifier returns an unknown intent or low confidence', async () => {
    await expect(routeRequirementIntent('user-a', {
      text: '继续处理', hasOpenTask: true, hasOpenRequirement: true,
    }, { classify: async () => ({ intent: 'not-an-intent' as never, confidence: 0.99, reason: 'bad' }) })).resolves.toMatchObject({ intent: 'continue', method: 'fallback' });
    await expect(routeRequirementIntent('user-a', {
      text: '继续处理', hasOpenTask: true, hasOpenRequirement: true,
    }, { classify: async () => ({ intent: 'new', confidence: 0.2, reason: 'uncertain' }) })).resolves.toMatchObject({ intent: 'continue', method: 'fallback' });
  });
});
