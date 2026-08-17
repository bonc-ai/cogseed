/**
 * Dependency / permission hash evidence fields (W4).
 *
 * These are RECORD-ONLY dimensions: the payload tree hash already covers the
 * same bytes, so no new staleness branch or rescan exists — the fields exist
 * to bind the verdict to spec §4.4's dimensions and make receipts exportable
 * against it. The tests pin the hashing semantics themselves: stability under
 * key reorder, sensitivity to the declared dimension, insensitivity to
 * unrelated prose.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let TMP = '';
const UID = 'u-hashes';

vi.mock('../../../src/main/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/paths')>();
  return {
    ...actual,
    userLocalRoot: (uid: string) => path.join(TMP, uid, 'local'),
  };
});

const {
  currentDependencyHash, currentPermissionHash, PERMISSION_HASH_NONE,
  writeReceipt, readReceipt, writeInstallReceipt,
} = await import('../../../src/main/features/skill_trust');

function skillDir(files: Record<string, string>): string {
  const dir = path.join(TMP, 'skills', `s-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

const SKILL_MD = '---\nname: hash-test\n---\n\n# hash-test\n\n'
  + 'use_when: hashing.\ndo_not_use_when: never.\n\n'
  + '## External dependencies\n- requests >= 2.31\n';

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-hashes-'));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  vi.resetModules();
});

describe('dependency / permission hash evidence', () => {
  it('permission hash is stable across key orderings and constant when absent', () => {
    const a = skillDir({
      'SKILL.md': SKILL_MD,
      'schemas.json': JSON.stringify({
        runtime_contracts: {
          resource: { direct_resource_access: false, access_via_gateway_only: true },
          audit: { emitted_by: 'runtime' },
        },
      }),
    });
    const b = skillDir({
      'SKILL.md': SKILL_MD,
      'schemas.json': JSON.stringify({
        runtime_contracts: {
          audit: { emitted_by: 'runtime' },
          resource: { access_via_gateway_only: true, direct_resource_access: false },
        },
      }),
    });
    expect(currentPermissionHash(a)).toBe(currentPermissionHash(b));
    expect(currentPermissionHash(skillDir({ 'SKILL.md': SKILL_MD }))).toBe(PERMISSION_HASH_NONE);
  });

  it('dependency hash tracks manifest files and the declared section, not prose', () => {
    const base = skillDir({ 'SKILL.md': SKILL_MD });
    const h1 = currentDependencyHash(base);

    // Unrelated prose change → same hash.
    const prose = skillDir({
      'SKILL.md': SKILL_MD.replace('use_when: hashing.', 'use_when: hash-related work.'),
    });
    expect(currentDependencyHash(prose)).toBe(h1);

    // Declared dependency change → different hash.
    const dep = skillDir({
      'SKILL.md': SKILL_MD.replace('- requests >= 2.31', '- requests >= 3.0'),
    });
    expect(currentDependencyHash(dep)).not.toBe(h1);

    // Manifest file change → different hash.
    const manifest = skillDir({
      'SKILL.md': SKILL_MD,
      'requirements.txt': 'requests>=2.31\n',
    });
    expect(currentDependencyHash(manifest)).not.toBe(h1);
  });

  it('receipts round-trip the new fields and install receipts compute them', () => {
    const dir = skillDir({
      'SKILL.md': SKILL_MD,
      'schemas.json': JSON.stringify({
        runtime_contracts: {
          resource: { direct_resource_access: false, access_via_gateway_only: true },
          owner_binding: { binding_resolved_by: 'agent_layer' },
          audit: { emitted_by: 'runtime' },
        },
      }),
    });
    const scan = {
      outcome: 'pass' as const,
      score: 100,
      isolated: false,
      scanMode: 'degraded-local',
      hardBlocked: false,
      requiredMitigations: [],
      vulnerabilityCount: 0,
      scannerVersion: '2.1.0',
      rulesetVersion: 'v1.0.0',
    };
    const receipt = writeInstallReceipt(
      UID, 'hash-skill', 'a'.repeat(64), scan,
      { violationCount: 0 }, undefined, dir,
    );
    expect(receipt?.dependencyHash).toBeTruthy();
    expect(receipt?.permissionHash).not.toBe(PERMISSION_HASH_NONE);
    expect(receipt?.permissionHash).toBe(currentPermissionHash(dir));

    const back = readReceipt(UID, 'hash-skill');
    expect(back?.dependencyHash).toBe(receipt?.dependencyHash);
    expect(back?.permissionHash).toBe(receipt?.permissionHash);
  });
});
