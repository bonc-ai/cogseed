/** 判定引擎测试：确定性短路、多候选与解析失败、相关性排序、降级路径
 * 及注册表驱动。模型输出由合成夹具提供。 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-001';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ck-judge-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function judgeMod() {
  return import('../../../../src/main/features/cognition_kernel/judge');
}

function neverCalledRunner() {
  return (async () => {
    throw new Error('模型不应被调用（确定性短路路径）');
  }) as never;
}

describe('cognition_kernel/judge v3 — 可核验门控 + 多候选', () => {
  it('确定性短路：显式声明/字段落点 → 不调模型直接 deterministic', async () => {
    const { judgeContentHome } = await judgeMod();
    const r1 = await judgeContentHome(UID, { statement: '我的部门是开源项目组', explicitHome: 'personal_fact' }, {
      buildRunnerFn: neverCalledRunner(),
    });
    expect(r1).toMatchObject({ outcome: 'deterministic', home: 'personal_fact', model: 'rules' });

    const r2 = await judgeContentHome(UID, { statement: '6222…1234', fieldName: '银行卡号' }, {
      buildRunnerFn: neverCalledRunner(),
    });
    expect(r2).toMatchObject({ outcome: 'deterministic', home: 'personal_fact', model: 'rules' });
  });

  it('多候选解析：candidates 收口（去重/合法家/置信度降序/≤3），次候选保留', async () => {
    const { parseJudgeReply } = await judgeMod();
    const known = new Set(['personal_fact', 'rule', 'template', 'method', 'task_local', 'experience']);
    const parsed = parseJudgeReply(
      '前置噪声 {"candidates":[{"home":"rule","confidence":0.6},{"home":"personal_fact","confidence":0.8},{"home":"rule","confidence":0.9},{"home":"not_a_home","confidence":1},{"home":"unclassified","confidence":0.5}],"reason":"两可","matchedRuleIds":["r1"]}',
      known,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.candidates).toEqual([
      { home: 'personal_fact', confidence: 0.8 },
      { home: 'rule', confidence: 0.6 },
    ]);
    expect(parsed?.matchedRuleIds).toEqual(['r1']);
  });

  it('解析容错：思考块带干扰花括号/多对象/代码围栏（Mem0 评估采纳项）', async () => {
    const { parseJudgeReply } = await judgeMod();
    const known = new Set(['personal_fact', 'rule']);
    // ① <think> 内含花括号 + 正文 JSON——旧贪心匹配会从 think 的 '{' 起整段失败
    const think = parseJudgeReply('<think>先看 {home: rule?} 不对，再看 candidates</think>\n{"candidates":[{"home":"rule","confidence":0.9}],"reason":"带思考块"}', known);
    expect(think?.candidates).toEqual([{ home: 'rule', confidence: 0.9 }]);
    // ② 前面出现无关合法对象（无判词键），后面才是判词——须取含 candidates 的那个
    const multi = parseJudgeReply('{"usage":{"tokens":120}} {"candidates":[{"home":"personal_fact","confidence":0.7}],"reason":"第二个才是判词"}', known);
    expect(multi?.candidates).toEqual([{ home: 'personal_fact', confidence: 0.7 }]);
    // ③ 代码围栏包裹
    const fenced = parseJudgeReply('```json\n{"candidates":[{"home":"rule","confidence":0.6}],"reason":"围栏"}\n```', known);
    expect(fenced?.candidates).toEqual([{ home: 'rule', confidence: 0.6 }]);
    // ④ 字符串里带 '}' 转义与花括号——深度扫描须字符串感知
    const braces = parseJudgeReply('{"candidates":[{"home":"rule","confidence":0.5}],"reason":"含 } 与 { 的字符串"}', known);
    expect(braces?.reason).toBe('含 } 与 { 的字符串');
  });

  it('解析容错：截断/坏 JSON 仍如实返回 null（拒绝似是而非）', async () => {
    const { parseJudgeReply } = await judgeMod();
    const known = new Set(['personal_fact', 'rule']);
    expect(parseJudgeReply('{"candidates":[{"home":"rule"', known)).toBeNull();
    expect(parseJudgeReply('完全没有对象 { 也没有闭合', known)).toBeNull();
    expect(parseJudgeReply('', known)).toBeNull();
  });

  it('空候选=不属于任何家（不再逼模型硬选）', async () => {
    const { parseJudgeReply } = await judgeMod();
    const known = new Set(['personal_fact', 'rule']);
    const parsed = parseJudgeReply('{"candidates":[],"reason":"闲聊"}', known);
    expect(parsed?.candidates).toEqual([]);
    const r = await (await judgeMod()).judgeContentHome(UID, { statement: '你好呀' }, {
      buildRunnerFn: (async () => ({ runner: { runReflection: async () => '{"candidates":[],"reason":"问候"}' } })) as never,
      ontologyContextFn: async () => '（空）',
    });
    expect(r).toMatchObject({ outcome: 'unclassified', model: 'llm' });
  });

  it('模型路径：主候选 proposed、次候选保留在 candidates', async () => {
    const { judgeContentHome } = await judgeMod();
    const r = await judgeContentHome(UID, { statement: '我不吃辣' }, {
      buildRunnerFn: (async () => ({
        runner: { runReflection: async () => '{"candidates":[{"home":"personal_fact","confidence":0.7},{"home":"rule","confidence":0.65}],"reason":"两可"}' },
      })) as never,
      ontologyContextFn: async () => '（空）',
    });
    expect(r.outcome).toBe('proposed');
    expect(r.home).toBe('personal_fact');
    expect(r.candidates).toHaveLength(2);
  });

  it('降级：模型抛错/不可解析 → unclassified(degraded)，永不抛出', async () => {
    const { judgeContentHome } = await judgeMod();
    const r = await judgeContentHome(UID, { statement: '任何内容' }, {
      buildRunnerFn: (async () => {
        throw new Error('model down');
      }) as never,
      ontologyContextFn: async () => '（空）',
    });
    expect(r).toMatchObject({ outcome: 'unclassified', model: 'degraded' });
    const r2 = await judgeContentHome(UID, { statement: '任何内容' }, {
      buildRunnerFn: (async () => ({ runner: { runReflection: async () => '不是JSON' } })) as never,
      ontologyContextFn: async () => '（空）',
    });
    expect(r2).toMatchObject({ outcome: 'unclassified', model: 'degraded' });
  });

  it('纠正样例相关性检索：重合的旧样例排在前面（不再被最近N条挤出）', async () => {
    const { rankCorrectionsByRelevance } = await judgeMod();
    const corrections = [
      { id: 'c1', statement: '报销住宿按城市封顶', fromHome: 'personal_fact', toHome: 'rule', at: '2026-09-01T00:00:00Z' },
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `c-${i}`,
        statement: `无关样例${i}号`,
        fromHome: 'template',
        toHome: 'method',
        at: '2026-09-02T00:00:00Z',
      })),
    ];
    const ranked = rankCorrectionsByRelevance('住宿报销的封顶规则是多少', corrections, 5);
    expect(ranked[0].id).toBe('c1');
    expect(ranked).toHaveLength(5);
  });

  it('prompt 由注册表驱动（含自定义家）', async () => {
    const { buildJudgePrompt } = await judgeMod();
    const prompt = buildJudgePrompt({
      statement: 'x',
      ontology: '（空）',
      homes: [
        { home: 'personal_fact', label: '关于我', definition: 'd1', examples: ['e1'], pool: 'ontology' },
        { home: 'contact', label: '联系人', definition: '与我协作的人', examples: [], pool: 'ontology' },
      ],
      rules: [],
      corrections: [],
    });
    expect(prompt).toContain('contact');
    expect(prompt).toContain('personal_fact');
    expect(prompt).toContain('空数组');
  });
});
