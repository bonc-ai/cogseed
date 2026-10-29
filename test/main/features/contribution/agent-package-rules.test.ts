import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGENT_CATEGORIES, AGENT_COLORS, AGENT_ICONS, AGENT_INPUT_TYPES, AGENT_OUTPUT_FORMATS,
  DEFAULT_PACKAGE_LIMITS, checkAgentName, checkPackageLimits, classifySkillRef, displayWidth,
  splitSkillRefs, toDistributableAgent, validateAgentJson,
} from '../../../../src/main/features/contribution/agent-package-rules';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/hub-agent-contributions');
const SCHEMA = path.resolve(__dirname, '../../../../specs/008-hub-agent-distribution/contracts/agent-package.schema.json');

const readFixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const fixtureNames = (prefix: string): string[] =>
  fs.readdirSync(FIXTURES).filter((f) => f.startsWith(prefix) && f.endsWith('.agent.json')).sort();

/**
 * 契约夹具：`pos-*` 必须通过，`neg-*` 必须被拒。
 * 夹具与 `specs/008-hub-agent-distribution/contracts/fixtures/agent-package/` 同源；Hub 侧读同一组。
 */
describe('Agent 包夹具', () => {
  const clientPositive = fixtureNames('pos-');
  it.each(clientPositive)('%s 通过', (name) => {
    const result = validateAgentJson(readFixture(name));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it.each(fixtureNames('neg-'))('%s 被拒', (name) => {
    expect(validateAgentJson(readFixture(name)).ok).toBe(false);
  });

  it('多余字段被拒而不是忽略，规则名为 agent.field.unexpected', () => {
    const r = validateAgentJson(readFixture('neg-extra-field-version.agent.json'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.rule)).toContain('agent.field.unexpected');
      expect(r.issues.find((i) => i.rule === 'agent.field.unexpected')?.path).toBe('version');
    }
  });

  it('builtin:<name> 开放清单内的通过；清单外的、形态不对的被拒，原因不同', () => {
    expect(validateAgentJson(readFixture('pos-builtin-ref.agent.json')).ok).toBe(true);
    const unknown = validateAgentJson(readFixture('neg-builtin-not-open.agent.json'));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.map((i) => i.rule)).toContain('skill_ref.builtin_unknown');
    const badForm = validateAgentJson(readFixture('neg-builtin-uppercase.agent.json'));
    expect(badForm.ok).toBe(false);
    if (!badForm.ok) expect(badForm.issues.map((i) => i.rule)).toContain('skill_ref.format');
  });
});

describe('schema 枚举不漂移', () => {
  // `specs/` 是私仓设计文档，不随开源快照导出（`scripts/opensource/policy.json`
  // 的 `neverPublic` 里就有 `specs/`）。枚举比对以私仓 schema 为单一事实源，
  // 文件不在时只跳过这一条；同组里不依赖 schema 的 crown 断言照常运行。
  const same = (a: readonly string[], b: readonly string[]): void => expect([...a].sort()).toEqual([...b].sort());

  it.skipIf(!fs.existsSync(SCHEMA))('icon / color / category / output_format / input type 与 agent-package.schema.json 一致', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8')) as {
      properties: Record<string, { enum?: string[] }>;
      definitions: { AgentInput: { properties: { type: { enum: string[] } } } };
    };
    same(AGENT_ICONS, schema.properties.icon.enum ?? []);
    same(AGENT_COLORS, schema.properties.color.enum ?? []);
    same(AGENT_CATEGORIES, schema.properties.category.enum ?? []);
    same(AGENT_OUTPUT_FORMATS, schema.properties.output_format.enum ?? []);
    same(AGENT_INPUT_TYPES, schema.definitions.AgentInput.properties.type.enum);
  });

  it('crown 不在可分发图标里', () => {
    expect((AGENT_ICONS as readonly string[]).includes('crown')).toBe(false);
  });
});

/** 共用名称向量：Hub 与客户端各自实现，读同一个文件。 */
describe('名称规则向量', () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'name-rule-vectors.json'), 'utf8')) as {
    vectors: Array<{ case: string; name: string; valid: boolean; reason: string | null }>;
  };

  it.each(vectors.vectors.map((v) => [v.case, v] as const))('%s', (_label, v) => {
    const rule = checkAgentName(v.name);
    expect(rule === null).toBe(v.valid);
    if (!v.valid) expect(rule).toBe(v.reason);
  });

  it('宽度：汉字计 2，其余计 1', () => {
    expect(displayWidth('会议纪要')).toBe(8);
    expect(displayWidth('abc')).toBe(3);
  });
});

describe('skill_list 分类', () => {
  it('12 位小写十六进制 = Hub；其余名字 = 随包；builtin: = 本期不支持', () => {
    expect(classifySkillRef('a3f09c21b7e4')).toBe('hub');
    expect(classifySkillRef('my-ocr-helper')).toBe('bundled');
    expect(classifySkillRef('builtin:grounded-material-qa')).toBe('builtin');
  });

  it('大写十六进制不是 Hub ID，而是合法的随包名字', () => {
    expect(classifySkillRef('A3F09C21B7E4')).toBe('bundled');
  });

  it('形态不合法被判 invalid', () => {
    expect(classifySkillRef('')).toBe('invalid');
    expect(classifySkillRef('-lead')).toBe('invalid');
    expect(classifySkillRef('has space')).toBe('invalid');
    expect(classifySkillRef('a/b')).toBe('invalid');
  });

  it('splitSkillRefs 分出三类', () => {
    expect(splitSkillRefs(['a3f09c21b7e4', 'my-ocr-helper', 'builtin:coding'])).toEqual({
      hub: ['a3f09c21b7e4'], bundled: ['my-ocr-helper'], builtin: ['builtin:coding'],
    });
    expect(splitSkillRefs(undefined)).toEqual({ hub: [], bundled: [], builtin: [] });
  });

  it('重复条目被拒', () => {
    const r = validateAgentJson({
      name: '重复', description_zh: 'x', workflow: '1', category: 'office',
      skill_list: ['a3f09c21b7e4', 'a3f09c21b7e4'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.rule)).toContain('skill_ref.duplicate');
  });
});

describe('本机处理（toDistributableAgent）', () => {
  // 真实官方市场 Agent 的形态：作者原文 + created_at/updated_at
  const real = readFixture('pos-real-merch-researcher.agent.json') as Record<string, unknown>;

  it('剥掉三个生命周期字段后，真实市场 Agent 通过校验', () => {
    const withLifecycle = { ...real, version: '1.0.2', created_at: '2026-08-12T02:57:00Z', updated_at: '2026-08-12T02:58:00Z' };
    const out = toDistributableAgent(withLifecycle);
    expect(out.agent).not.toHaveProperty('version');
    expect(out.agent).not.toHaveProperty('created_at');
    expect(out.agent).not.toHaveProperty('updated_at');
    expect(out.handled.map((h) => h.field).sort()).toEqual(['created_at', 'updated_at', 'version']);
    expect(validateAgentJson(out.agent).ok).toBe(true);
  });

  it('不修改入参', () => {
    const input = { ...real, created_at: 'x', enabled_connectors: ['c1'] };
    const snapshot = JSON.stringify(input);
    toDistributableAgent(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('本机偏好与运行时派生字段被剥离并登记，仅用于本机预览', () => {
    const out = toDistributableAgent({
      ...real,
      enabled_connectors: ['conn-1'], default_model: { provider: 'p', model: 'm' }, default_thinking: 'low', create_uid: '42',
      enabled: true, source: 'custom', status: 'approved', runtime_stats: { runs: 3 }, profile: { x: 1 },
    });
    const kinds = Object.fromEntries(out.handled.map((h) => [h.field, h.kind]));
    expect(kinds.enabled_connectors).toBe('local_pref');
    expect(kinds.default_model).toBe('local_pref');
    expect(kinds.create_uid).toBe('local_pref');
    expect(kinds.enabled).toBe('derived');
    expect(kinds.runtime_stats).toBe('derived');
    expect(validateAgentJson(out.agent).ok).toBe(true);
  });

  it('宿主专有字段、外接运行时、crown 图标都是阻断项，不是静默剥离', () => {
    const host = toDistributableAgent({ ...real, management_surface: 'expense' });
    expect(host.blockers.map((b) => b.rule)).toContain('agent.host_only');
    expect(host.agent).toHaveProperty('management_surface');

    const cli = toDistributableAgent({ ...real, runtime: { kind: 'cli' } });
    expect(cli.blockers.map((b) => b.rule)).toContain('agent.runtime_not_distributable');

    const crown = toDistributableAgent({ ...real, icon: 'crown' });
    expect(crown.blockers.map((b) => b.rule)).toContain('agent.icon_not_distributable');
  });

  it('本机自建 Agent（真实落盘形态：带 _v 与派生的 in_process interface_contract）可贡献，两者被剥离', () => {
    const local = {
      agent_id: '619bf57c0638', name: 'ExpenseHelper', description_zh: '核对报销材料并给出预检意见', description_en: '',
      workflow: '1. 读取材料', created_at: '2026-10-12T20:54:25', updated_at: '2026-10-12T21:26:25', _v: 2,
      status: 'approved', category: 'office', icon: 'bot', color: 'coral',
      interface_contract: { version: 1, role: 'cogseed_core', runtime: { kind: 'in_process' }, io: { input: 'task_message', output: 'final_message' } },
    };
    const out = toDistributableAgent(local);
    expect(out.blockers).toEqual([]);
    expect(out.agent).not.toHaveProperty('_v');
    expect(out.agent).not.toHaveProperty('interface_contract');
    expect(out.handled.map((h) => h.field)).toEqual(expect.arrayContaining(['_v', 'interface_contract']));
    expect(validateAgentJson(out.agent).ok).toBe(true);
  });

  it('interface_contract 声明了非 in_process 运行时（外接 CLI）或形态不对 → 仍然阻断', () => {
    for (const ic of [{ runtime: { kind: 'cli' } }, {}, 'x', null]) {
      const out = toDistributableAgent({ ...real, interface_contract: ic });
      expect(out.blockers.map((b) => b.rule)).toContain('agent.runtime_not_distributable');
    }
  });

  it('可选文本字段为空串 → 提交前移除并登记（Hub 对空串直接拒绝）；有值的不动', () => {
    const out = toDistributableAgent({ ...real, description_en: '', icon: '  ', color: 'violet' });
    expect(out.agent).not.toHaveProperty('description_en');
    expect(out.agent).not.toHaveProperty('icon');
    expect(out.agent.color).toBe('violet');
    expect(out.handled).toEqual(expect.arrayContaining([{ kind: 'empty', field: 'description_en' }, { kind: 'empty', field: 'icon' }]));
    expect(validateAgentJson(out.agent).ok).toBe(true);
  });

  it('中英文描述都为空 → 移除后校验以"至少其一必填"拒绝，而不是放行空描述', () => {
    const out = toDistributableAgent({ ...real, description_zh: '', description_en: '' });
    expect(validateAgentJson(out.agent).ok).toBe(false);
  });

  it('没有 skill_list 的 Agent 提交前补空数组（Hub 把缺省也当"不是数组"拒绝）；已有的不动', () => {
    const { skill_list: _drop, ...noSkills } = real as Record<string, unknown>;
    expect(toDistributableAgent(noSkills).agent.skill_list).toEqual([]);
    expect(toDistributableAgent({ ...noSkills, skill_list: ['a3f09c21b7e4'] }).agent.skill_list).toEqual(['a3f09c21b7e4']);
    expect(validateAgentJson(toDistributableAgent(noSkills).agent).ok).toBe(true);
  });

  it('未知字段不被静默丢弃，由校验拒绝', () => {
    const out = toDistributableAgent({ ...real, brand_new_field: 1 });
    expect(out.agent).toHaveProperty('brand_new_field');
    const r = validateAgentJson(out.agent);
    expect(r.ok).toBe(false);
  });
});

describe('包上限（四段，走配置）', () => {
  it('默认值取自契约四段', () => {
    expect(DEFAULT_PACKAGE_LIMITS).toEqual({
      maxCompressedBytes: 8 * 1024 * 1024, maxFiles: 200, maxUnpackedBytes: 10 * 1024 * 1024, maxEntryCompressionRatio: 100,
    });
  });

  it('恰在上限内不报，超出才报', () => {
    expect(checkPackageLimits({ fileCount: 200, unpackedBytes: 10 * 1024 * 1024 })).toEqual([]);
    expect(checkPackageLimits({ fileCount: 201, unpackedBytes: 1 }).map((v) => v.kind)).toEqual(['too_many_files']);
    expect(checkPackageLimits({ fileCount: 1, unpackedBytes: 10 * 1024 * 1024 + 1 }).map((v) => v.kind)).toEqual(['unpacked_too_large']);
  });

  it('压缩后与压缩比只在已知时判定，未压缩不误报', () => {
    expect(checkPackageLimits({ fileCount: 1, unpackedBytes: 1 })).toEqual([]);
    expect(checkPackageLimits({ fileCount: 1, unpackedBytes: 1, compressedBytes: 8 * 1024 * 1024 + 1 }).map((v) => v.kind)).toEqual(['compressed_too_large']);
    expect(checkPackageLimits({ fileCount: 1, unpackedBytes: 1, maxEntryCompressionRatio: 101 }).map((v) => v.kind)).toEqual(['compression_ratio_too_high']);
  });

  it('上限可由契约覆盖，不依赖写死的常量', () => {
    const limits = { ...DEFAULT_PACKAGE_LIMITS, maxFiles: 300 };
    expect(checkPackageLimits({ fileCount: 250, unpackedBytes: 1 }, limits)).toEqual([]);
  });
});
