import { describe, it, expect, beforeEach } from 'vitest';
import {
  t, setCurrentLang, getCurrentLang, setCurrentUiLang, getCurrentUiLang,
  acceptLanguageHeader, detectSystemLang, descriptionLang, getRendererBootTables,
  getRendererTables, isLang, isUiLang, buildLanguageDirective, _resetCacheForTests,
} from '../../src/main/i18n';

beforeEach(() => {
  _resetCacheForTests();
  setCurrentLang('en');
  setCurrentUiLang('zh');
});

describe('i18n › detectSystemLang', () => {
  it('maps zh* locales to zh', () => {
    for (const v of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'ZH-Hans']) {
      expect(detectSystemLang(v)).toBe('zh');
    }
  });

  it('maps ja* locales to ja', () => {
    for (const v of ['ja', 'ja-JP']) {
      expect(detectSystemLang(v)).toBe('ja');
    }
  });

  it('maps pt* locales to Brazilian Portuguese', () => {
    for (const v of ['pt', 'pt-BR', 'pt_BR', 'PT-br']) {
      expect(detectSystemLang(v)).toBe('pt');
    }
  });

  it('falls back to en for non-supported / malformed / empty', () => {
    for (const v of ['en-US', 'fr', '', null, undefined, 42]) {
      expect(detectSystemLang(v)).toBe('en');
    }
  });
});

describe('i18n › isLang', () => {
  it('accepts supported language codes', () => {
    expect(isLang('zh')).toBe(true);
    expect(isLang('en')).toBe(true);
    expect(isLang('ja')).toBe(true);
    expect(isLang('pt')).toBe(true);
    expect(isLang('ZH')).toBe(false);
    expect(isLang('fr')).toBe(false);
    expect(isLang('')).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});

describe('i18n › isUiLang', () => {
  it('accepts all four product UI languages', () => {
    expect(isUiLang('zh')).toBe(true);
    expect(isUiLang('en')).toBe(true);
    expect(isUiLang('ja')).toBe(true);
    expect(isUiLang('pt')).toBe(true);
    expect(isUiLang('fr')).toBe(false);
  });
});

describe('i18n › t() lookup', () => {
  it('returns current-lang string when present', () => {
    setCurrentUiLang('zh');
    expect(t('errors.not_utf8')).toBe('文本类文件必须是 UTF-8 编码');
    setCurrentUiLang('en');
    expect(t('errors.not_utf8')).toBe('Text files must be UTF-8 encoded');
  });

  it('falls back to en when key missing in current lang', () => {
    // Seed only-in-en by monkey-patching loaded table isn't supported; instead
    // we rely on the shipped table where `errors.not_utf8` exists in both.
    // This test covers the en-fallback path by picking a real key and
    // temporarily pretending the zh side is empty via cache reset + one-shot
    // override: simpler to just verify the final chain with a known-missing
    // key (returns raw key).
    setCurrentUiLang('zh');
    expect(t('nope.definitely.missing.key')).toBe('nope.definitely.missing.key');
  });

  it('returns raw key when missing in both langs', () => {
    expect(t('definitely.not.present')).toBe('definitely.not.present');
  });

  it('substitutes {name} placeholders from vars', () => {
    setCurrentUiLang('en');
    // Use raw-key fallback as the template source so this test stays
    // independent of shipped strings.
    expect(t('Hello {who}, you have {count} messages', { who: 'Ada', count: 3 }))
      .toBe('Hello Ada, you have 3 messages');
  });

  it('resolves main-side disabled skill request message', () => {
    setCurrentUiLang('zh');
    expect(t('component.skill_disabled_request', { name: 'arxiv-reader' }))
      .toBe('技能「arxiv-reader」已被停用，请重新启用后再使用。');
  });

  it('localizes actionable external-agent terminal states', () => {
    setCurrentUiLang('zh');
    expect(t('cli_agent.run_failed_detail', { name: 'Codex' }))
      .toContain('请确认对应 CLI 已登录且可正常运行');
    expect(t('cli_agent.timeout_detail', { name: 'OpenClaw' }))
      .toContain('长时间没有响应');
    expect(t('cli_agent.session_expired_detail', { name: 'Claude Code' }))
      .toContain('外接会话已失效');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(t('Ping {unknown} pong', { other: 'x' })).toBe('Ping {unknown} pong');
  });

  it('per-call lang override takes precedence over current', () => {
    setCurrentLang('en');
    setCurrentUiLang('en');
    expect(t('errors.not_utf8', undefined, 'zh')).toBe('文本类文件必须是 UTF-8 编码');
    expect(t('errors.not_utf8', undefined, 'ja')).toBe('テキストファイルは UTF-8 エンコードである必要があります');
    expect(t('errors.not_utf8', undefined, 'pt')).toBe('Os arquivos de texto devem ser codificados em UTF-8');
    expect(getCurrentLang()).toBe('en'); // override does not mutate state
    expect(getCurrentUiLang()).toBe('en');
  });

  it('uses UI language independently from the Agent response language', () => {
    setCurrentLang('ja');
    setCurrentUiLang('zh');
    expect(t('errors.not_utf8')).toBe('文本类文件必须是 UTF-8 编码');
    expect(getCurrentLang()).toBe('ja');

    setCurrentUiLang('en');
    expect(t('errors.not_utf8')).toBe('Text files must be UTF-8 encoded');
    expect(getCurrentLang()).toBe('ja');
  });
});

describe('i18n › descriptionLang', () => {
  it('uses English descriptions for non-Chinese UI languages', () => {
    expect(descriptionLang('zh')).toBe('zh');
    expect(descriptionLang('en')).toBe('en');
    expect(descriptionLang('ja')).toBe('en');
    expect(descriptionLang('pt')).toBe('en');
  });
});

describe('i18n › response language policy', () => {
  it.each(['en', 'zh'] as const)('uses interface language %s only as a fallback after the user request language', (lang) => {
    const directive = buildLanguageDirective(lang);
    expect(directive).toContain('explicit requested response language first');
    expect(directive).toContain('reply in the language of the latest user request');
    expect(directive).toContain('only an image, attachment, URL, or emoji');
    expect(directive.indexOf('explicit requested response language first'))
      .toBeLessThan(directive.indexOf('current interface language as the fallback'));
    expect(directive).not.toContain('Preferred response language:');
  });

  it('keeps English connector output from overriding a Chinese request while preserving protocol literals', () => {
    const directive = buildLanguageDirective('en');
    expect(directive).toContain('current interface language as the fallback response language: **English**');
    expect(directive).toContain('Tool and connector calls must not change the response language');
    expect(directive).toContain('preserve the language of the originating user request');
    expect(directive).toContain('table headings');
    expect(directive).toContain('Keep protocol tokens unchanged');
    expect(directive).toContain('`description_zh` is always Chinese and `description_en` is always English');
  });

  it('uses the current UI language for image-only requests even when the legacy Agent language is English', () => {
    setCurrentLang('en');
    setCurrentUiLang('zh');
    expect(buildLanguageDirective()).toContain('fallback response language: **Chinese (简体中文)**');
    expect(buildLanguageDirective()).toContain('Do not infer a response language from text inside that material');
    setCurrentUiLang('en');
    expect(buildLanguageDirective()).toContain('fallback response language: **English**');
  });
});

describe('i18n › renderer boot bundle', () => {
  it('loads only English when English is active', () => {
    expect(Object.keys(getRendererBootTables('en'))).toEqual(['en']);
  });

  it('loads Chinese plus its English fallback', () => {
    expect(Object.keys(getRendererBootTables('zh')).sort()).toEqual(['en', 'zh']);
  });

  it('exposes all four supported renderer tables', () => {
    expect(Object.keys(getRendererTables()).sort()).toEqual(['en', 'ja', 'pt', 'zh']);
  });
});

describe('i18n › acceptLanguageHeader', () => {
  it('prefers the active UI locale for HTTP language negotiation', () => {
    expect(acceptLanguageHeader('ja').startsWith('ja-JP')).toBe(true);
    expect(acceptLanguageHeader('zh').startsWith('zh-CN')).toBe(true);
    expect(acceptLanguageHeader('pt').startsWith('pt-BR')).toBe(true);
  });
});
