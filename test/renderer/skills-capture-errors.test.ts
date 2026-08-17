import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const bindings = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/skills-bindings.js'),
  'utf8',
);
const skillsModule = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/skills.js'),
  'utf8',
);

function extractFunction(name: string, source = bindings): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function: ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function: ${name}`);
}

function loadMessageFormatter() {
  const sandbox: any = {
    _cognitionText(key: string, fallback: string) {
      const table: Record<string, string> = {
        'cognition.capture_error_no_completed_exchange': '当前会话还没有完成一轮问答，暂时无法沉淀。',
        'cognition.capture_error_waiting_response': '当前会话仍在等待回复，完成后才能沉淀。',
        'cognition.capture_error_disabled': '沉淀功能已关闭，请先在沉淀设置中开启。',
        'cognition.capture_error_conversation_not_found': '找不到这个会话，暂时无法沉淀。',
        'cognition.capture_error_unknown': '沉淀任务发生未知错误',
      };
      return table[key] || fallback;
    },
  };
  vm.runInNewContext(`${extractFunction('_recallCaptureErrorMessage')}\nthis.format = _recallCaptureErrorMessage;`, sandbox);
  return sandbox.format as (error: unknown) => string;
}

function loadCaptureErrorLabel() {
  const sandbox: any = {
    _cognitionText(_key: string, fallback: string) { return fallback; },
  };
  vm.runInNewContext(`${extractFunction('_captureErrorLabel', skillsModule)}\nthis.format = _captureErrorLabel;`, sandbox);
  return sandbox.format as (code: string, capture?: unknown) => string;
}

describe('Recall capture error feedback', () => {
  it('localizes known manual-capture errors before showing the alert dialog', () => {
    const format = loadMessageFormatter();
    expect(format(new Error('conversation has no completed exchange'))).toBe('当前会话还没有完成一轮问答，暂时无法沉淀。');
    expect(format(new Error('conversation is still waiting for a response'))).toBe('当前会话仍在等待回复，完成后才能沉淀。');
    expect(format(new Error('recall capture is disabled'))).toBe('沉淀功能已关闭，请先在沉淀设置中开启。');
    expect(format(new Error('conversation not found'))).toBe('找不到这个会话，暂时无法沉淀。');
  });

  it('keeps unexpected backend details available to the user', () => {
    const format = loadMessageFormatter();
    expect(format(new Error('provider timed out'))).toBe('provider timed out');
    expect(format(null)).toBe('沉淀任务发生未知错误');
  });

  it('explains paused and removed source failures instead of showing an unknown error', () => {
    const format = loadCaptureErrorLabel();
    expect(format('source_paused')).toContain('暂停');
    expect(format('source_removed')).toContain('移除');
  });

  it('ships the feedback strings for every supported locale', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const table = JSON.parse(fs.readFileSync(
        path.join(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      ));
      for (const key of [
        'cognition.capture_error_no_completed_exchange',
        'cognition.capture_error_waiting_response',
        'cognition.capture_error_disabled',
        'cognition.capture_error_conversation_not_found',
        'cognition.capture_error_source_paused',
        'cognition.capture_error_source_removed',
      ]) expect(table[key]).toBeTruthy();
    }
  });
});
