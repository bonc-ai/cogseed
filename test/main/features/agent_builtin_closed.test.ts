/**
 * `builtin:` 总开关默认关闭（产品 2026-10-13：先不开放）时的行为。
 * 全局测试环境默认打开它，这里在每个用例里临时取消，验证"失败即关闭"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_CAPABILITIES_ENABLE_ENV, builtinCapabilitiesOpen, builtinCapabilityManifest, getBuiltinCapability,
  isKnownBuiltinRef, openBuiltinNamesOf, parseBuiltinRef,
} from '../../../src/main/features/agent_builtin_capabilities';
import { planAgentDependencies } from '../../../src/main/features/marketplace_agent_deps';
import { validateAgentJson } from '../../../src/main/features/contribution/agent-package-rules';

let saved: string | undefined;
beforeEach(() => { saved = process.env[BUILTIN_CAPABILITIES_ENABLE_ENV]; delete process.env[BUILTIN_CAPABILITIES_ENABLE_ENV]; });
afterEach(() => { if (saved === undefined) delete process.env[BUILTIN_CAPABILITIES_ENABLE_ENV]; else process.env[BUILTIN_CAPABILITIES_ENABLE_ENV] = saved; });

const AGENT = { name: 'A', workflow: '1. x', category: 'office', description_zh: 'd' };

describe('总开关关闭（正式安装的默认）', () => {
  it('开关本身默认是关的，只有显式设为 1 才打开', () => {
    expect(builtinCapabilitiesOpen()).toBe(false);
    process.env[BUILTIN_CAPABILITIES_ENABLE_ENV] = 'true';
    expect(builtinCapabilitiesOpen()).toBe(false); // 只认 '1'，不接受含糊的真值
    process.env[BUILTIN_CAPABILITIES_ENABLE_ENV] = '1';
    expect(builtinCapabilitiesOpen()).toBe(true);
  });

  it('开放清单为空：任何 builtin: 引用都"不认识"，Hub 清单也为空', () => {
    expect(isKnownBuiltinRef('builtin:coding')).toBe(false);
    expect(getBuiltinCapability('coding')).toBeNull();
    expect(builtinCapabilityManifest()).toEqual([]);
    expect(openBuiltinNamesOf(['builtin:coding', 'builtin:kb-mindmap'])).toEqual([]);
    expect(parseBuiltinRef('builtin:coding')).toBe('coding'); // 形态判断与开关无关
  });

  it('贡献：本机检查拒绝带 builtin: 的 Agent，原因是"清单外"', () => {
    const r = validateAgentJson({ ...AGENT, skill_list: ['builtin:coding'] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('skill_ref.builtin_unknown');
  });

  it('安装：依赖规划把 builtin: 判为不支持，阻断整个 Agent、不下载任何东西', () => {
    const plan = planAgentDependencies(['builtin:coding'], new Set(), () => ({ present: false, disabled: false }), () => false);
    expect(plan.blocked.map((b) => b.action)).toEqual(['blocked_builtin_unsupported']);
    expect(plan.toInstall).toEqual([]);
  });

  it('打开之后恢复原行为（总开关是唯一的差别）', () => {
    process.env[BUILTIN_CAPABILITIES_ENABLE_ENV] = '1';
    expect(isKnownBuiltinRef('builtin:coding')).toBe(true);
    expect(builtinCapabilityManifest().map((c) => c.id).sort())
      .toEqual(['builtin:coding', 'builtin:grounded-material-qa', 'builtin:kb-mindmap']);
    expect(validateAgentJson({ ...AGENT, skill_list: ['builtin:coding'] }).ok).toBe(true);
  });
});
