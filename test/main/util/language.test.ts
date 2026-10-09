import { describe, expect, it } from 'vitest';
import { dominantScript, lessonLanguageMismatches } from '../../../src/main/util/language';

describe('dominantScript', () => {
  it('detects Chinese-dominant text', () => {
    expect(dominantScript('帮我写一份广州城市的资料，500 字')).toBe('cjk');
    expect(dominantScript('你写一下郑州的资粮')).toBe('cjk');
  });

  it('detects Latin-dominant text', () => {
    expect(dominantScript('For well-known factual city profiles, skip gathering steps.')).toBe('latin');
    expect(dominantScript('Fix the login bug and make the tests pass.')).toBe('latin');
  });

  it('returns none for empty or symbol-only text', () => {
    expect(dominantScript('')).toBe('none');
    expect(dominantScript('12345 !!!')).toBe('none');
  });

  it('treats equal CJK/Latin counts as none (ambiguous)', () => {
    expect(dominantScript('a一')).toBe('none');
  });
});

describe('lessonLanguageMismatches', () => {
  it('flags an English lesson from a Chinese task', () => {
    expect(lessonLanguageMismatches('帮我写一份广州城市的资料，500 字', 'For well-known factual city profiles, skip explicit information-gathering plan steps.')).toBe(true);
    expect(lessonLanguageMismatches('你写一下郑州的资粮', 'When user request is ambiguous, clarify the intent before producing output.')).toBe(true);
  });

  it('flags a Chinese lesson from an English task', () => {
    expect(lessonLanguageMismatches('Fix the login bug and make the tests pass.', '登录 bug 是类型断言导致，应先核对类型再断言。')).toBe(true);
  });

  it('accepts matching languages', () => {
    expect(lessonLanguageMismatches('帮我写一份广州城市的资料，500 字', '写城市资料时应先收集数据再成文，避免编造。')).toBe(false);
    expect(lessonLanguageMismatches('Fix the login bug and make the tests pass.', 'Type assertions hide runtime errors; prefer explicit checks.')).toBe(false);
  });

  it('accepts mixed-language lessons whose dominant script matches the task', () => {
    expect(lessonLanguageMismatches('帮我写一份广州城市的资料，500 字', '写城市资料时 skip 信息收集会更快，但需核对数据来源。')).toBe(false);
  });

  it('never blocks when either side is unclassifiable', () => {
    expect(lessonLanguageMismatches('!!!', 'whatever')).toBe(false);
    expect(lessonLanguageMismatches('中文任务', '12345')).toBe(false);
  });
});
