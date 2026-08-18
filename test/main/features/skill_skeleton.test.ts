import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureSkillSkeleton,
  listMissingSkillArtifacts,
} from '../../../src/main/features/skill_skeleton';

const REQUIRED = [
  'references/input-contract.md',
  'references/output-contract.md',
  'references/skill-spec.yaml',
  'references/ontology-mapping.md',
  'references/validation-contract.md',
  'references/governance-boundaries.md',
  'references/kstar-evolution.md',
  'references/eval-cases.yaml',
  'evals/evals.json',
];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-skeleton-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('features › skill_skeleton › ensureSkillSkeleton', () => {
  it('creates all missing skill artifacts from scratch', () => {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\n---\n');
    const r = ensureSkillSkeleton(dir, 'demo');
    expect(r.created.sort()).toEqual([...REQUIRED].sort());
    expect(r.alreadyPresent).toEqual([]);
    for (const rel of REQUIRED) {
      expect(fs.existsSync(path.join(dir, rel))).toBe(true);
    }
  });

  it('does not overwrite existing artifacts (source preservation)', () => {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\n---\n');
    const existing = 'my hand-written contract\n';
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'references/input-contract.md'), existing);
    const r = ensureSkillSkeleton(dir, 'demo');
    expect(r.alreadyPresent).toContain('references/input-contract.md');
    expect(r.created).not.toContain('references/input-contract.md');
    expect(fs.readFileSync(path.join(dir, 'references/input-contract.md'), 'utf8'))
      .toBe(existing);
  });

  it('generated templates carry the skill name and the hard caps', () => {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: invoice-x\n---\n');
    ensureSkillSkeleton(dir, 'invoice-x');
    const input = fs.readFileSync(path.join(dir, 'references/input-contract.md'), 'utf8');
    expect(input).toContain('invoice-x');
    const spec = fs.readFileSync(path.join(dir, 'references/skill-spec.yaml'), 'utf8');
    expect(spec).toContain('promotion_ceiling: staged');
    expect(spec).toContain('production_release_allowed: false');
    const gov = fs.readFileSync(path.join(dir, 'references/governance-boundaries.md'), 'utf8');
    expect(gov).toContain('binding_resolved_by: agent_layer');
  });

  it('evals.json is valid JSON with an author note', () => {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\n---\n');
    ensureSkillSkeleton(dir, 'demo');
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'evals/evals.json'), 'utf8'));
    expect(parsed.schema_version).toBe(1);
    expect(Array.isArray(parsed.cases)).toBe(true);
  });
});

describe('features › skill_skeleton › listMissingSkillArtifacts', () => {
  it('lists all when empty, none when complete', () => {
    expect(listMissingSkillArtifacts(dir).sort()).toEqual([...REQUIRED].sort());
    ensureSkillSkeleton(dir, 'demo');
    expect(listMissingSkillArtifacts(dir)).toEqual([]);
  });
});
