/**
 * 候选决定失败时，用户看到的必须是中文，不是后端契约语言。
 *
 * 实机故障：「待我处理 → 查看候选 → 确认并限域」失败时，`uiAlert` 弹的是
 * `candidate does not meet the formal asset bar: ...`——`formal-assets/
 * promotion.ts::describePromotionBlock` 自己就注明那串是日志用、不是 UI 文案。
 *
 * 这里钉三件事：
 *   1. 已知 code → 中文（用真实 zh 词条驱动，顺带证明键真的存在）；
 *   2. 后端**每一个**稳定码 / 每一条晋升拦截原因都有对应文案（机械门禁：
 *      后端加码而前端不加文案，用例红，而不是等实机弹英文）；
 *   3. 认不出的 code 退回原始 error，不吞掉失败。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const bindings = fs.readFileSync(path.join(root, 'src/renderer/modules/skills-bindings.js'), 'utf8');
const capabilities = fs.readFileSync(path.join(root, 'src/main/features/recall/candidate-capabilities.ts'), 'utf8');
const promotion = fs.readFileSync(path.join(root, 'src/main/features/recall/formal-assets/promotion.ts'), 'utf8');
const locales = Object.fromEntries(['zh', 'en', 'ja', 'pt'].map((name) => [
  name,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${name}.json`), 'utf8')) as Record<string, string>,
]));

/** 从 `{` 起按深度取一段，跳过字符串里的括号。 */
function sliceBlock(source: string, start: number): string {
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
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated block');
}

function declaration(name: string): string {
  const start = bindings.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`missing const: ${name}`);
  return `${sliceBlock(bindings, start)};`;
}

function fn(name: string): string {
  const start = bindings.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function: ${name}`);
  return sliceBlock(bindings, start);
}

type ErrorResult = { ok?: false; code?: string; error?: string; promotionReasons?: string[] };

function loadFormatter(locale: 'zh' | 'en' | 'ja' | 'pt' = 'zh') {
  const sandbox: any = { t: (key: string) => locales[locale][key] ?? key };
  vm.runInNewContext([
    declaration('RECALL_CANDIDATE_ERROR_TEXTS'),
    declaration('RECALL_PROMOTION_BLOCK_TEXTS'),
    fn('_recallCandidateErrorText'),
    'this.format = _recallCandidateErrorText;',
    'this.codeTexts = RECALL_CANDIDATE_ERROR_TEXTS;',
    'this.blockTexts = RECALL_PROMOTION_BLOCK_TEXTS;',
  ].join('\n'), sandbox);
  return {
    format: sandbox.format as (result: ErrorResult) => string,
    codeTexts: sandbox.codeTexts as Record<string, [string, string]>,
    blockTexts: sandbox.blockTexts as Record<string, [string, string]>,
  };
}

/** 后端稳定码的真实清单：联合类型 + 两个已有常量。 */
function backendCodes(): string[] {
  const union = capabilities.slice(
    capabilities.indexOf('export type RecallCandidateErrorCode ='),
    capabilities.indexOf(';', capabilities.indexOf('export type RecallCandidateErrorCode =')),
  );
  const fromUnion = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  const fromConsts = [...capabilities.matchAll(/export const RECALL_CANDIDATE_\w+_ERROR_CODE = '([a-z_]+)'/g)]
    .map((match) => match[1]);
  return [...new Set([...fromUnion, ...fromConsts])];
}

/** 晋升闸门真正会拦下的原因 = describePromotionBlock 显式列举的那些。 */
function blockReasons(): string[] {
  const start = promotion.indexOf('export function describePromotionBlock');
  return [...sliceBlock(promotion, start).matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]);
}

describe('候选失败文案', () => {
  it('把终态错误翻成中文，不外泄契约语言', () => {
    const { format } = loadFormatter();
    const message = format({ code: 'recall_candidate_terminal', error: 'recall candidate is terminal' });
    expect(message).toBe(locales.zh['cognition.candidate_error_terminal']);
    expect(message).not.toContain('terminal');
  });

  it('晋升被拦时逐条展开原因，而不是只说"不够格"', () => {
    const { format } = loadFormatter();
    const message = format({
      code: 'promotion_blocked',
      error: 'candidate does not meet the formal asset bar: the same wording already exists under another asset type; the classification is unreliable',
      promotionReasons: ['type_conflicts_with_existing', 'rule_boundary_required'],
    });
    expect(message).toContain(locales.zh['cognition.candidate_error_promotion_blocked']);
    expect(message).toContain(locales.zh['cognition.candidate_block_type_conflicts_with_existing']);
    expect(message).toContain(locales.zh['cognition.candidate_block_rule_boundary_required']);
    expect(message).not.toContain('formal asset bar');
  });

  it('拿不到原因码时仍给一句可执行的话，不留半截冒号', () => {
    const { format } = loadFormatter();
    const message = format({ code: 'promotion_blocked', error: 'candidate does not meet the formal asset bar: ...' });
    expect(message).toContain(locales.zh['cognition.candidate_error_promotion_blocked_unknown']);
    expect(message).not.toContain('formal asset bar');
  });

  it('认不出的 code 退回原始 error，不吞掉失败', () => {
    const { format } = loadFormatter();
    expect(format({ code: 'E_SOMETHING_NEW', error: 'brand new failure' })).toBe('brand new failure');
    expect(format({})).toBe(locales.zh['cognition.candidate_error_generic']);
  });

  it('后端每一个稳定码都有文案', () => {
    const { codeTexts } = loadFormatter();
    const codes = backendCodes();
    // 解析失败会让这条门禁变成空断言——先证明确实读到了码表。
    expect(codes).toContain('recall_candidate_terminal');
    expect(codes.length).toBeGreaterThanOrEqual(10);
    expect(codes.filter((code) => !codeTexts[code])).toEqual([]);
  });

  it('晋升闸门每一条拦截原因都有文案', () => {
    const { blockTexts } = loadFormatter();
    const reasons = blockReasons();
    expect(reasons).toContain('rule_boundary_required');
    expect(reasons.length).toBeGreaterThanOrEqual(6);
    expect(reasons.filter((reason) => !blockTexts[reason])).toEqual([]);
  });

  it('四语都有这批词条——缺一门语言就会退回中文兜底', () => {
    const { codeTexts, blockTexts } = loadFormatter();
    const keys = [
      ...Object.values(codeTexts).map(([key]) => key),
      ...Object.values(blockTexts).map(([key]) => key),
      'cognition.candidate_error_promotion_blocked',
      'cognition.candidate_error_promotion_blocked_unknown',
      'cognition.candidate_error_generic',
    ];
    const gaps = Object.entries(locales).flatMap(([name, table]) => keys
      .filter((key) => !(key in table))
      .map((key) => `${name}:${key}`));
    expect(gaps).toEqual([]);
  });

  it('英文界面拿到的是英文，不是中文兜底', () => {
    const { format } = loadFormatter('en');
    const message = format({ code: 'recall_candidate_evidence_insufficient', error: 'candidate evidence is insufficient for review' });
    expect(message).toBe(locales.en['cognition.candidate_error_evidence_insufficient']);
    expect(message).not.toMatch(/[一-龥]/);
  });
});
