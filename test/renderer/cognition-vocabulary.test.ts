/**
 * 语义映射层门禁（cognition-assets/vocabulary.js）。
 *
 * 后端加枚举而前端不加翻译，界面就会裸出一串英文——这类缺口靠实机才能
 * 发现，且一旦合并就是"永远差一条"。本测试从后端源码提取枚举全集、
 * 从 vocabulary.js 提取字典键（文本级对照，不执行代码），后端动枚举而
 * 字典不跟着动，这里直接红。翻译值本身的四语覆盖由
 * cognition-i18n-coverage.test.ts 把关（字典条目形如 'key','中文'，
 * 会被它的字面量扫描自动收编）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const vocabSource = read('src/renderer/modules/cognition-assets/vocabulary.js');

/** 提取 vocabulary.js 里某个字典的全部键（缩进 4 空格的 `name:` 行）。 */
function dictKeys(dictName: string): string[] {
  const start = vocabSource.indexOf(`const ${dictName} = {`);
  expect(start, `vocabulary.js 应含字典 ${dictName}`).toBeGreaterThan(-1);
  const end = vocabSource.indexOf('\n  };', start);
  const body = vocabSource.slice(start, end);
  return [...body.matchAll(/^ {4}([a-z_]+): \[/gm)].map((m) => m[1]);
}

/** 从后端源码提取字面量集合。 */
function literals(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

describe('cognition vocabulary 门禁：后端枚举必须有前端翻译', () => {
  it('来源类型全集（COGNITION_SOURCE_TYPES 五类）逐项入字典', () => {
    const backend = read('src/main/features/recall/source-service.ts');
    const kinds = literals(backend, /'([a-z_]+)'/g)
      .filter((k) => ['conversation', 'artifact_file', 'execution_evaluation', 'user_teaching_signal', 'authorized_external_system'].includes(k));
    expect([...new Set(kinds)]).toHaveLength(5);
    const dict = new Set(dictKeys('SOURCE_KINDS'));
    const missing = kinds.filter((k) => !dict.has(k));
    expect(missing, `SOURCE_KINDS 缺翻译: ${missing.join(', ')}`).toEqual([]);
  });

  it('来源生命周期全集逐项入字典', () => {
    const catalog = read('src/main/features/recall/source-catalog.ts');
    const union = catalog.match(/CognitionSourceLifecycleStatus = ([^\n]+)/)?.[1] ?? '';
    const statuses = literals(union, /'([a-z_]+)'/g);
    expect(statuses.length).toBeGreaterThanOrEqual(5);
    const dict = new Set(dictKeys('SOURCE_STATUS'));
    const missing = statuses.filter((s) => !dict.has(s));
    expect(missing, `SOURCE_STATUS 缺翻译: ${missing.join(', ')}`).toEqual([]);
  });

  it('来源原因全集逐项入字典', () => {
    const sources = [
      read('src/main/features/recall/source-catalog.ts'),
      read('src/main/features/recall/teaching-service.ts'),
    ].join('\n');
    const reasons = literals(sources, /(?:reason|statusReason): '(conversation_processing|connector_[a-z_]+|degraded_execution|execution_[a-z_]+|file_index_[a-z_]+|source_[a-z_]+|teaching_revoked|manual)'/g);
    // 模板串 `execution_${status}` 展开为 ExecutionStatus 的失败态（cancelled 已不算失败）。
    reasons.push('execution_failed', 'execution_timed_out');
    const unique = [...new Set(reasons)];
    // source-catalog 里可静态提取的 reason 字面量 13 个；connector_degraded/
    // connector_error 藏在三元表达式里（无 reason: 前缀），字典侧额外覆盖。
    expect(unique.length).toBeGreaterThanOrEqual(13);
    const dict = new Set(dictKeys('SOURCE_REASON'));
    const missing = unique.filter((r) => !dict.has(r));
    expect(missing, `SOURCE_REASON 缺翻译: ${missing.join(', ')}`).toEqual([]);
  });

  it('整理记录状态全集逐项入字典', () => {
    const service = read('src/main/features/recall/capture-service.ts');
    // 排除触发策略/配置类值（非记录状态）与测试注入噪声。
    const statuses = literals(service, /status: '([a-z_]+)'/g)
      .filter((s) => !['manual', 'nightly', 'scheduled', 'smart', 'run_now', 'configuration_required', 'model_auth_required', 'model_not_configured', 'manual_start_required', 'waiting_input', 'active_trigger'].includes(s));
    const unique = [...new Set(statuses)];
    expect(unique.length).toBeGreaterThanOrEqual(10);
    const dict = new Set(dictKeys('CAPTURE_STATUS'));
    const missing = unique.filter((s) => !dict.has(s));
    expect(missing, `CAPTURE_STATUS 缺翻译: ${missing.join(', ')}`).toEqual([]);
  });

  it('整理记录标题绝不裸出内部 ID', () => {
    // recordTitle 的取值顺序：会话标题 → 兜底文案；不含裸 id 回退。
    expect(vocabSource).toContain('conversationTitle || record.title');
    expect(vocabSource).toContain('capture_untitled_record');
    const fnStart = vocabSource.indexOf('recordTitle(record)');
    const fnBody = vocabSource.slice(fnStart, vocabSource.indexOf('},', fnStart));
    expect(fnBody).not.toMatch(/record\.id/);
  });
});
