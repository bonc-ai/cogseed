import { describe, it, expect } from 'vitest';

import { resolveTemplateRefsWith, type LocalContentProbe, type TemplateRefProbe } from '../../../src/main/features/template_refs';
import type { TemplateRef } from '../../../src/main/features/template_types';

/**
 * S5 模板引用解析（spec FR-010~015）。纯判定，探测接口用表数据代替读盘。
 */

const ABSENT: LocalContentProbe = { present: false, hubDisabled: false, userDisabled: false };
const READY: LocalContentProbe = { present: true, hubDisabled: false, userDisabled: false, version: '1.2.0' };

function probe(over: Partial<{
  roles: Record<string, { agent_ids: string[]; skill_ids: string[] }>;
  bundledAgents: string[];
  bundledSkills: string[];
  caps: string[];
  agents: Record<string, LocalContentProbe>;
  skills: Record<string, LocalContentProbe>;
  deps: Record<string, TemplateRef[]>;
}> = {}): TemplateRefProbe {
  return {
    roleTemplateBundle: (id) => over.roles?.[id] ?? null,
    bundledAgent: (id) => (over.bundledAgents ?? []).includes(id),
    bundledSkill: (id) => (over.bundledSkills ?? []).includes(id),
    builtinCapability: (name) => (over.caps ?? []).includes(name),
    agent: (id) => over.agents?.[id] ?? ABSENT,
    skill: (id) => over.skills?.[id] ?? ABSENT,
    agentDependencies: (id) => over.deps?.[id] ?? [],
  };
}

const hubSkill = (id: string, extra: Partial<TemplateRef> = {}): TemplateRef => ({ source: 'hub', kind: 'skill', id, ...extra });
const states = (rs: ReturnType<typeof resolveTemplateRefsWith>) => rs.map((r) => [r.ref.kind, r.ref.id, r.state]);

describe('template refs › states', () => {
  it('covers every state', () => {
    const p = probe({
      roles: { student: { agent_ids: [], skill_ids: [] } },
      skills: {
        aaaaaaaaaaa1: READY,
        aaaaaaaaaaa3: { ...READY, version: '1.0.0' },
        aaaaaaaaaaa4: { ...READY, hubDisabled: true },
        aaaaaaaaaaa5: { ...READY, userDisabled: true },
      },
    });
    const rs = resolveTemplateRefsWith([
      { source: 'builtin', kind: 'role_template', id: 'student' },
      hubSkill('aaaaaaaaaaa1'),
      hubSkill('aaaaaaaaaaa2'),
      { source: 'builtin', kind: 'role_template', id: 'no-such-role' },
      hubSkill('aaaaaaaaaaa3', { compat: { min_version: '1.1.0' } }),
      hubSkill('aaaaaaaaaaa4'),
      hubSkill('aaaaaaaaaaa5'),
      { source: 'hub', kind: 'workflow' as never, id: 'x' },
    ], p);
    expect(states(rs)).toEqual([
      ['role_template', 'student', 'ready'],
      ['skill', 'aaaaaaaaaaa1', 'ready'],
      ['skill', 'aaaaaaaaaaa2', 'needs_fetch'],
      ['role_template', 'no-such-role', 'missing'],
      ['skill', 'aaaaaaaaaaa3', 'incompatible'],
      ['skill', 'aaaaaaaaaaa4', 'disabled'],
      ['skill', 'aaaaaaaaaaa5', 'user_disabled'],
      ['workflow', 'x', 'unknown'],
    ]);
  });

  it('unknown Hub availability is unknown, not available', () => {
    expect(states(resolveTemplateRefsWith([hubSkill('bbbbbbbbbbb2', { hub_availability: 'unknown' })], probe())))
      .toEqual([['skill', 'bbbbbbbbbbb2', 'unknown']]);
  });

  it('Hub says disabled and nothing is installed → disabled, not needs_fetch', () => {
    expect(states(resolveTemplateRefsWith([hubSkill('ccccccccccc1', { hub_availability: 'disabled' })], probe())))
      .toEqual([['skill', 'ccccccccccc1', 'disabled']]);
  });

  it.each([
    ['missing', 'missing'],
    ['disabled', 'disabled'],
    ['incompatible', 'incompatible'],
  ] as const)('Hub %s wins over an older ready local copy', (availability, expected) => {
    const p = probe({ skills: { ccccccccccc2: READY } });
    expect(states(resolveTemplateRefsWith([
      hubSkill('ccccccccccc2', { hub_availability: availability }),
    ], p))).toEqual([['skill', 'ccccccccccc2', expected]]);
  });
});

describe('template refs › source comes only from the declaration', () => {
  it('a 12-hex id marked hub is never treated as builtin, even when the package ships it', () => {
    const p = probe({ bundledSkills: ['ddddddddddd1'] });
    expect(states(resolveTemplateRefsWith([hubSkill('ddddddddddd1')], p))).toEqual([['skill', 'ddddddddddd1', 'needs_fetch']]);
  });

  it('a builtin ref the package does not ship is missing, not fetched from Hub', () => {
    expect(states(resolveTemplateRefsWith([{ source: 'builtin', kind: 'skill', id: 'eeeeeeeeeee1' }], probe())))
      .toEqual([['skill', 'eeeeeeeeeee1', 'missing']]);
  });

  it('role templates and builtin capabilities cannot come from Hub', () => {
    const rs = resolveTemplateRefsWith([
      { source: 'hub', kind: 'role_template', id: 'student' },
      { source: 'hub', kind: 'builtin_capability', id: 'builtin:docx' },
    ], probe({ roles: { student: { agent_ids: [], skill_ids: [] } }, caps: ['docx'] }));
    expect(rs.map((r) => r.state)).toEqual(['unknown', 'unknown']);
  });

  it('builtin capabilities accept the builtin: prefix and fail closed', () => {
    const rs = resolveTemplateRefsWith([
      { source: 'builtin', kind: 'builtin_capability', id: 'builtin:docx' },
      { source: 'builtin', kind: 'builtin_capability', id: 'pdf' },
    ], probe({ caps: ['docx'] }));
    expect(rs.map((r) => r.state)).toEqual(['ready', 'missing']);
  });
});

describe('template refs › expansion and dedupe', () => {
  it('expands a role template into its bundled agents, their deps and skills, deduped', () => {
    const p = probe({
      roles: { student: { agent_ids: ['a00000000001'], skill_ids: ['s00000000001', 's00000000002'] } },
      bundledAgents: ['a00000000001'],
      bundledSkills: ['s00000000001', 's00000000002'],
      agents: { a00000000001: READY },
      skills: { s00000000001: READY, s00000000002: READY },
      deps: { a00000000001: [hubSkill('s00000000001'), hubSkill('h00000000001')] },
    });
    const rs = resolveTemplateRefsWith([
      { source: 'builtin', kind: 'role_template', id: 'student' },
      hubSkill('h00000000001'),
    ], p);
    expect(states(rs)).toEqual([
      ['role_template', 'student', 'ready'],
      ['agent', 'a00000000001', 'ready'],
      ['skill', 's00000000001', 'ready'],
      ['skill', 'h00000000001', 'needs_fetch'],
      ['skill', 's00000000002', 'ready'],
    ]);
    expect(rs[1].via).toEqual({ source: 'builtin', kind: 'role_template', id: 'student' });
    expect(rs[3].via?.id).toBe('a00000000001');
  });

  it('expands an installed Hub agent into its dependencies', () => {
    const p = probe({
      agents: { f00000000001: READY },
      deps: { f00000000001: [hubSkill('f00000000002'), { source: 'builtin', kind: 'builtin_capability', id: 'builtin:docx' }] },
    });
    expect(states(resolveTemplateRefsWith([{ source: 'hub', kind: 'agent', id: 'f00000000001' }], p))).toEqual([
      ['agent', 'f00000000001', 'ready'],
      ['skill', 'f00000000002', 'needs_fetch'],
      ['builtin_capability', 'builtin:docx', 'missing'],
    ]);
  });

  it('does not expand an agent that still needs fetching (S4 install brings its deps)', () => {
    const p = probe({ deps: { f00000000003: [hubSkill('f00000000004')] } });
    expect(states(resolveTemplateRefsWith([{ source: 'hub', kind: 'agent', id: 'f00000000003' }], p)))
      .toEqual([['agent', 'f00000000003', 'needs_fetch']]);
  });

  it('a user-disabled skill stays user_disabled; nothing re-enables it', () => {
    const p = probe({ skills: { g00000000001: { ...READY, userDisabled: true } } });
    const rs = resolveTemplateRefsWith([hubSkill('g00000000001')], p);
    expect(rs[0].state).toBe('user_disabled');
    expect(p.skill('g00000000001').userDisabled).toBe(true);
  });

  it('skips connector refs (judged elsewhere)', () => {
    expect(resolveTemplateRefsWith([{ source: 'builtin', kind: 'connector_type', id: 'tencent-meeting' }], probe())).toEqual([]);
  });

  it('only installed or builtin content satisfies a ref (project-dir skills are not probed)', () => {
    // 探测只看本机安装与随包；项目目录里同名 Skill 不进入探测，所以仍是 needs_fetch。
    expect(resolveTemplateRefsWith([hubSkill('p00000000001')], probe())[0].state).toBe('needs_fetch');
  });
});
