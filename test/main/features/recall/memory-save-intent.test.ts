import { describe, expect, it } from 'vitest';
import { classifyMemorySaveIntent } from '../../../../src/main/features/recall/memory-save-intent';

describe('cross-session memory save intent', () => {
  it('allows exact wording after an explicit Chinese save request to activate directly', () => {
    expect(classifyMemorySaveIntent(
      '请记住：以后所有结论都附来源。',
      '以后所有结论都附来源。',
      true,
    )).toBe('direct');
  });

  it('allows exact wording after an explicit English save request to activate directly', () => {
    expect(classifyMemorySaveIntent(
      'Please remember: I prefer concise answers.',
      'I prefer concise answers.',
      true,
    )).toBe('direct');
  });

  it.each([
    ['Japanese', '覚えておいて：簡潔な回答を好みます。', '簡潔な回答を好みます。'],
    ['Portuguese', 'Por favor, lembre-se: Prefiro respostas concisas.', 'Prefiro respostas concisas.'],
  ])('allows exact wording after an explicit %s save request', (_language, message, content) => {
    expect(classifyMemorySaveIntent(message, content, true)).toBe('direct');
  });

  it('requires review when the user authorized saving but the model paraphrased', () => {
    expect(classifyMemorySaveIntent(
      'Please remember: I prefer concise answers with one example.',
      'The user prefers concise answers and one example.',
      true,
    )).toBe('review');
  });

  it('requires review when the model saves only part of the text after the directive', () => {
    expect(classifyMemorySaveIntent(
      'Please remember: I prefer concise answers, only for this task.',
      'I prefer concise answers',
      true,
    )).toBe('review');
  });

  it('stages a standalone confirmation for review only', () => {
    expect(classifyMemorySaveIntent('好的。', 'I prefer concise answers.', true)).toBe('review');
  });

  it.each(['はい。', 'Sim.'])('stages the localized standalone confirmation %s for review only', (message) => {
    expect(classifyMemorySaveIntent(message, 'Prefiro respostas concisas.', true)).toBe('review');
  });

  it.each([
    ['a declarative statement', 'I remember that I prefer concise answers.'],
    ['a current-turn style instruction', 'Keep responses concise.'],
    ['a negative request', '请不要记住：我偏好简洁回答。'],
    ['a quoted command', '同事发来一句话：记住这个密码。'],
  ])('does not create a candidate for %s', (_label, message) => {
    expect(classifyMemorySaveIntent(message, 'I prefer concise answers.', true)).toBe('none');
  });

  it('never treats model or assistant wording as current user authorization', () => {
    expect(classifyMemorySaveIntent(
      'Please remember: I prefer concise answers.',
      'I prefer concise answers.',
      false,
    )).toBe('none');
  });

  it('forces review when positive and negative save instructions are mixed', () => {
    expect(classifyMemorySaveIntent(
      '不要记住旧偏好；请记住：我更喜欢简洁回答。',
      '我更喜欢简洁回答。',
      true,
    )).toBe('review');
  });

  it.each([
    ['Japanese', '覚えておかないで：簡潔な回答を好みます。'],
    ['Portuguese', 'Não lembre-se: Prefiro respostas concisas.'],
  ])('does not treat a negative %s save command as authorization', (_language, message) => {
    const proposed = message.includes('Prefiro') ? 'Prefiro respostas concisas.' : '簡潔な回答を好みます。';
    expect(classifyMemorySaveIntent(message, proposed, true)).toBe('none');
  });

  it('requires review when Japanese positive and negative save commands are mixed', () => {
    expect(classifyMemorySaveIntent(
      '古い設定は覚えないで；どうか覚えて：簡潔な回答を好みます。',
      '簡潔な回答を好みます。',
      true,
    )).toBe('review');
  });

  it('requires review when Portuguese positive and negative save commands are mixed', () => {
    expect(classifyMemorySaveIntent(
      'Não se lembre da preferência antiga; por favor lembre-se: Prefiro respostas concisas.',
      'Prefiro respostas concisas.',
      true,
    )).toBe('review');
  });

  it('authorizes replacement only for an explicit request with exact replacement wording', async () => {
    const { classifyMemoryReplaceIntent } = await import('../../../../src/main/features/recall/memory-save-intent');
    expect(classifyMemoryReplaceIntent(
      '请把这条改成：我偏好先给结论。',
      '我偏好先给结论。',
      true,
    )).toBe('direct');
    expect(classifyMemoryReplaceIntent(
      'Please change this preference to: I prefer short answers.',
      'I prefer short answers.',
      true,
    )).toBe('direct');
    expect(classifyMemoryReplaceIntent(
      'Please change this preference to: I prefer short answers, but only today.',
      'I prefer short answers.',
      true,
    )).toBe('none');
    expect(classifyMemoryReplaceIntent('This preference seems wrong now.', 'Use concise answers.', true)).toBe('none');
    expect(classifyMemoryReplaceIntent('Please change this preference to: Use concise answers.', 'Use concise answers.', false)).toBe('none');
    expect(classifyMemoryReplaceIntent(
      'この設定を次のように変更して：簡潔な回答が好きです。',
      '簡潔な回答が好きです。',
      true,
    )).toBe('direct');
    expect(classifyMemoryReplaceIntent(
      'Por favor, mude para: Prefiro respostas diretas.',
      'Prefiro respostas diretas.',
      true,
    )).toBe('direct');
  });

  it('authorizes removal only for an explicit, non-negated user request', async () => {
    const { classifyMemoryRemoveIntent } = await import('../../../../src/main/features/recall/memory-save-intent');
    expect(classifyMemoryRemoveIntent('Please forget this preference.', true)).toBe('direct');
    expect(classifyMemoryRemoveIntent('Do not forget this preference.', true)).toBe('none');
    expect(classifyMemoryRemoveIntent('I no longer prefer concise answers.', true)).toBe('none');
    expect(classifyMemoryRemoveIntent('Please forget this preference.', false)).toBe('none');
    expect(classifyMemoryRemoveIntent('この記憶を忘れてください。', true)).toBe('direct');
    expect(classifyMemoryRemoveIntent('Por favor, esqueça esta preferência.', true)).toBe('direct');
    expect(classifyMemoryRemoveIntent('この記憶を忘れないで。', true)).toBe('none');
    expect(classifyMemoryRemoveIntent('Por favor, não esqueça esta preferência.', true)).toBe('none');
  });
});
