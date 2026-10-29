/**
 * 客户端内置能力（`builtin:<name>`）：开放清单与解析规则。
 * 这份清单要和 Hub 的清单成员一致，所以也钉住"哪些不在清单里"。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_BUILTIN_CAPABILITIES, builtinCapabilityManifest, builtinNamesOf, getBuiltinCapability, isBuiltinRef,
  isKnownBuiltinRef, openBuiltinNamesOf, parseBuiltinRef,
} from '../../../src/main/features/agent_builtin_capabilities';

describe('解析', () => {
  it('形态合法返回名字，否则 null', () => {
    expect(parseBuiltinRef('builtin:coding')).toBe('coding');
    expect(parseBuiltinRef('builtin:grounded-material-qa')).toBe('grounded-material-qa');
    expect(parseBuiltinRef('builtin:')).toBeNull();
    expect(parseBuiltinRef('builtin:Coding')).toBeNull();
    expect(parseBuiltinRef('builtin:-x')).toBeNull();
    expect(parseBuiltinRef('builtin:a b')).toBeNull();
    expect(parseBuiltinRef('coding')).toBeNull();
    expect(parseBuiltinRef('a3f09c21b7e4')).toBeNull();
    expect(parseBuiltinRef(undefined)).toBeNull();
    expect(parseBuiltinRef(42)).toBeNull();
  });

  it('isBuiltinRef 只看前缀，不判断名字', () => {
    expect(isBuiltinRef('builtin:whatever')).toBe(true);
    expect(isBuiltinRef('builtin')).toBe(false);
    expect(isBuiltinRef(null)).toBe(false);
  });
});

describe('开放清单', () => {
  it('初始成员是能力型 Skill', () => {
    expect(AGENT_BUILTIN_CAPABILITIES.map((c) => c.name).sort()).toEqual(['coding', 'grounded-material-qa', 'kb-mindmap']);
  });

  it('创建器、安装器、个人本体抽取不在清单里（不该被 Agent 直接引用）', () => {
    for (const name of ['agent-creator', 'skill-creator', 'autotask-creator', 'package-installer', 'personal-ontology-candidate-builder']) {
      expect(getBuiltinCapability(name), name).toBeNull();
      expect(isKnownBuiltinRef(`builtin:${name}`), name).toBe(false);
    }
  });

  it('每个成员都有引入版本、能力说明和风险等级', () => {
    for (const c of AGENT_BUILTIN_CAPABILITIES) {
      expect(c.introducedIn).toMatch(/^\d+\.\d+\.\d+/);
      expect(c.capability.length).toBeGreaterThan(10);
      expect(['low', 'medium', 'high']).toContain(c.risk);
    }
  });

  it('名字都是合法的 builtin 名字形态', () => {
    for (const c of AGENT_BUILTIN_CAPABILITIES) expect(parseBuiltinRef(`builtin:${c.name}`)).toBe(c.name);
  });
});

describe('从 skill_list 取内置能力', () => {
  const list = ['a3f09c21b7e4', 'builtin:coding', 'my-skill', 'builtin:coding', 'builtin:package-installer', 'builtin:Bad'];

  it('builtinNamesOf：形态合法的都取，去重，保持顺序', () => {
    expect(builtinNamesOf(list)).toEqual(['coding', 'package-installer']);
    expect(builtinNamesOf(undefined)).toEqual([]);
  });

  it('openBuiltinNamesOf：只留开放清单内的——手写进 agent.json 的清单外名字不会被露出', () => {
    expect(openBuiltinNamesOf(list)).toEqual(['coding']);
  });
});

describe('给 Hub 的清单', () => {
  it('成员 id 带 builtin: 前缀，字段与 Hub 清单项一致', () => {
    const manifest = builtinCapabilityManifest();
    expect(manifest.map((m) => m.id).sort()).toEqual(['builtin:coding', 'builtin:grounded-material-qa', 'builtin:kb-mindmap']);
    for (const m of manifest) {
      expect(Object.keys(m).sort()).toEqual(['capability', 'current_version', 'id', 'introduced_in', 'risk']);
    }
  });
});

const HUB_INITIAL_MANIFEST = path.resolve(
  __dirname,
  '../../../specs/008-hub-agent-distribution/contracts/builtin-capabilities-initial-manifest.json',
);

// `specs/` 是私仓设计文档，不随开源快照导出（`scripts/opensource/policy.json`
// 的 `neverPublic` 里就有 `specs/`）。这条用例是「私仓契约文件 = 单一事实源」的
// 比对：文件不在时整组跳过，而不是让公仓导出树的 CI 变红；私仓里文件存在，
// 照常逐项比对。
describe.skipIf(!fs.existsSync(HUB_INITIAL_MANIFEST))('与给 Hub 的初始清单文件一致', () => {
  it('contracts/builtin-capabilities-initial-manifest.json 就是客户端当前开放的成员', () => {
    const given = JSON.parse(fs.readFileSync(HUB_INITIAL_MANIFEST, 'utf8')) as { list: unknown };
    expect(given.list).toEqual(builtinCapabilityManifest());
  });
});
