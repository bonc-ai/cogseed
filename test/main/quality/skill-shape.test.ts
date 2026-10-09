import { describe, it, expect } from 'vitest';
import {
  validateSkillShape,
  validateSkillRuntimeGuards,
} from '../../../src/main/quality/rules/skill-shape';

// ── fixture: a fully contract-conformant skill (Level B shape) ──────────────

const CONFORMANT_SKILL_MD = `---
name: invoice-dunning
description: Decide the dunning action for an overdue invoice.
---

# Invoice Dunning

## Trigger semantics
- **use_when**: an invoice is overdue and a collection decision is needed.
- **do_not_use_when**: the customer asks a billing-detail question.
- **positive_examples**: ["invoice #INV-882 is 45 days overdue"]
- **negative_examples**: ["why was I charged a late fee"]

## Business context
tbox: Invoice{amount_overdue, days_overdue, is_vip}
rbox: R1 amount>1000 & days>30 → human review
abox: {}

## Workflow
start → assess → decide → preview → confirm → execute → close

promotion_ceiling: staged
production_release_allowed: false
`;

const CONFORMANT_FILES = [
  'SKILL.md',
  'references/input-contract.md',
  'references/output-contract.md',
  'references/ontology-mapping.md',
  'references/skill-spec.yaml',
  'references/validation-contract.md',
  'references/governance-boundaries.md',
  'references/eval-cases.yaml',
  'references/kstar-evolution.md',
  'evals/evals.json',
  'schemas.json',
];

const CONFORMANT_SCHEMA = {
  input_schema: {
    type: 'object',
    required: ['task_id', 'owner_context', 'invoice_payload'],
    properties: {
      task_id: { type: 'string' },
      owner_context: {
        type: 'object',
        required: ['owner_id', 'role', 'authorization_scope'],
        properties: {
          owner_id: { type: 'string' },
          role: { type: 'string' },
          authorization_scope: { type: 'array', items: { type: 'string' } },
        },
      },
      invoice_payload: {
        type: 'object',
        required: ['amount_overdue'],
        properties: { amount_overdue: { type: 'number' } },
      },
    },
  },
  output_schema: {
    type: 'object',
    required: ['actions', 'result', 'trace', 'audit_refs'],
    properties: {
      actions: { type: 'array', items: { type: 'string' } },
      result: { type: 'number' },
      trace: { type: 'array', items: { type: 'string' } },
      audit_refs: { type: 'array', items: { type: 'string' } },
    },
  },
  runtime_contracts: {
    resource: {
      resource_requirements: [
        { resource_type: 'invoice', operation: 'read', purpose: 'ontology_grounded_read', min_scope: true },
      ],
      access_via_gateway_only: true,
      direct_resource_access: false,
    },
    permission: {
      permissions: [
        { action: 'assess', permission_level: 'read', hitl_required: false },
        { action: 'execute', permission_level: 'write', hitl_required: true },
      ],
    },
    owner_binding: {
      required_owner_sections: ['role', 'authorization_scope'],
      owner_context_ref: 'input_schema.owner_context',
      binding_resolved_by: 'agent_layer',
    },
    audit: {
      audit_refs_field: 'output_schema.audit_refs',
      emitted_by: 'runtime',
      append_only: true,
    },
  },
};

describe('quality › skill-shape › validateSkillShape', () => {
  it('passes a fully conformant skill at Level B', () => {
    const r = validateSkillShape({
      skillMd: CONFORMANT_SKILL_MD,
      meta: {},
      files: CONFORMANT_FILES,
    });
    expect(r.level).toBe('B');
    const hard = r.violations.filter((v) => v.level !== 'LOW');
    expect(hard).toEqual([]);
  });

  it('flags missing anti-trigger as a hard shape violation', () => {
    const md = CONFORMANT_SKILL_MD
      .replace('- **do_not_use_when**: the customer asks a billing-detail question.\n', '')
      .replace('- **negative_examples**: ["why was I charged a late fee"]\n', '');
    const r = validateSkillShape({
      skillMd: md,
      meta: {},
      files: CONFORMANT_FILES,
    });
    expect(r.violations.map((v) => v.rule)).toContain('shape_antitrigger_missing');
    // Level A still reachable without anti-trigger in body IF meta supplies it — here it does not
    expect(r.level).toBeNull();
  });

  it('accepts anti-trigger supplied via _meta.json routing', () => {
    const md = CONFORMANT_SKILL_MD
      .replace('- **do_not_use_when**: the customer asks a billing-detail question.\n', '')
      .replace('- **negative_examples**: ["why was I charged a late fee"]\n', '');
    const r = validateSkillShape({
      skillMd: md,
      meta: { routing: { negative_examples: ['billing lookup'] } },
      files: CONFORMANT_FILES,
    });
    expect(r.violations.map((v) => v.rule)).not.toContain('shape_antitrigger_missing');
    expect(r.level).toBe('B');
  });

  it('flags missing input/output contracts', () => {
    const files = CONFORMANT_FILES.filter((f) =>
      !/input-contract|output-contract|schemas\.json/.test(f));
    const r = validateSkillShape({
      skillMd: CONFORMANT_SKILL_MD,
      meta: {},
      files,
    });
    expect(r.violations.map((v) => v.rule)).toContain('shape_input_contract_missing');
    expect(r.violations.map((v) => v.rule)).toContain('shape_output_contract_missing');
    expect(r.level).toBe('A'); // A does not require contracts
  });

  it('flags missing ontology slice (Level A gate)', () => {
    const md = CONFORMANT_SKILL_MD.replace(/tbox:[\s\S]*?abox: \{\}\n/, '');
    const files = CONFORMANT_FILES.filter((f) => !/ontology-mapping/.test(f));
    const r = validateSkillShape({ skillMd: md, meta: {}, files });
    expect(r.violations.map((v) => v.rule)).toContain('shape_ontology_slice_missing');
    expect(r.level).toBeNull();
  });

  it('flags missing staged ceiling and production lock', () => {
    const md = CONFORMANT_SKILL_MD
      .replace('promotion_ceiling: staged\n', '')
      .replace('production_release_allowed: false\n', '');
    const r = validateSkillShape({ skillMd: md, meta: {}, files: CONFORMANT_FILES });
    expect(r.violations.map((v) => v.rule)).toContain('shape_staged_ceiling_missing');
    expect(r.violations.map((v) => v.rule)).toContain('shape_production_lock_missing');
  });

  it('flags missing frontmatter fields', () => {
    const md = CONFORMANT_SKILL_MD.replace('description: Decide the dunning action for an overdue invoice.\n', '');
    const r = validateSkillShape({ skillMd: md, meta: {}, files: CONFORMANT_FILES });
    expect(r.violations.map((v) => v.rule)).toContain('shape_frontmatter_incomplete');
  });

  it('all violations are MEDIUM or LOW (never gate writes)', () => {
    const r = validateSkillShape({ skillMd: 'no frontmatter at all', meta: {}, files: [] });
    for (const v of r.violations) {
      expect(['MEDIUM', 'LOW']).toContain(v.level);
    }
  });
});

describe('quality › skill-shape › validateSkillRuntimeGuards', () => {
  it('passes a conformant runtime_contracts block', () => {
    expect(validateSkillRuntimeGuards(CONFORMANT_SCHEMA)).toEqual([]);
  });

  it('flags a broken direct_resource_access guard', () => {
    const bad = JSON.parse(JSON.stringify(CONFORMANT_SCHEMA));
    bad.runtime_contracts.resource.direct_resource_access = true;
    const v = validateSkillRuntimeGuards(bad);
    expect(v.map((x) => x.rule)).toContain('shape_runtime_guard_violation');
    expect(v.some((x) => x.snippet.includes('direct_resource_access'))).toBe(true);
  });

  it('flags a broken binding_resolved_by guard', () => {
    const bad = JSON.parse(JSON.stringify(CONFORMANT_SCHEMA));
    bad.runtime_contracts.owner_binding.binding_resolved_by = 'skill';
    const v = validateSkillRuntimeGuards(bad);
    expect(v.some((x) => x.snippet.includes('binding_resolved_by'))).toBe(true);
  });

  it('flags missing runtime_contracts block', () => {
    const v = validateSkillRuntimeGuards({ input_schema: {}, output_schema: {} });
    expect(v.map((x) => x.rule)).toContain('shape_runtime_contracts_missing');
  });

  it('returns nothing for non-object input (advisory handled by caller)', () => {
    expect(validateSkillRuntimeGuards(null)).toEqual([]);
  });
});
