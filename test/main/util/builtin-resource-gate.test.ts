import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const gate = require('../../../bin/builtin-resource-gate.cjs') as {
  createBuiltinManifest(root: string, options?: { allowIgnoredJunk?: boolean }): {
    files: unknown[];
    inventory: {
      system_skills: unknown[];
      marketplace_agents: Array<{
        id: string;
        icon: string;
        color: string;
        updated_at: string;
        skill_list: string[];
        embedded_skills: string[];
      }>;
      marketplace_skills: Array<{ id: string }>;
    };
  };
  verifyBuiltinExtraResourcesConfig(extraResources: unknown): boolean;
  verifyBuiltinRoot(root: string, options?: { allowIgnoredJunk?: boolean }): string;
  REQUIRED_BUILTIN_INVENTORY: {
    system_skills: readonly string[];
    marketplace_agents: readonly string[];
    marketplace_skills: readonly string[];
  };
};
const contentManifest = require('../../../src/main/util/builtin-content-manifest.js') as {
  collectBuiltinFiles(root: string, options?: { allowIgnoredJunk?: boolean }): Array<{
    path: string;
    bytes: number;
    sha256: string;
  }>;
  contentTreeSha256(files: unknown): string;
  verifyBuiltinContentManifest(root: string, options?: { allowIgnoredJunk?: boolean }): {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-builtin-gate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function copyBuiltin(): string {
  const root = path.join(tmpDir, 'builtin');
  fs.cpSync(path.join(process.cwd(), 'resources', 'builtin'), root, { recursive: true });
  return root;
}

describe('builtin-resource-gate', () => {
  it('verifies every tracked file and the complete semantic inventory', () => {
    const root = path.join(process.cwd(), 'resources', 'builtin');
    const manifest = gate.createBuiltinManifest(root, { allowIgnoredJunk: true });

    expect(gate.verifyBuiltinRoot(root, { allowIgnoredJunk: true }))
      .toBe('resource:builtin:manifest-v1');

    // Inventory sizes are asserted against the gate's own required lists rather
    // than literals. `exactNames` already fails on any name that is missing or
    // extra, so a literal here restated a stronger check in a weaker form and
    // only added a number to hand-edit on every content change.
    expect(manifest.inventory.system_skills)
      .toHaveLength(gate.REQUIRED_BUILTIN_INVENTORY.system_skills.length);
    expect(manifest.inventory.marketplace_agents)
      .toHaveLength(gate.REQUIRED_BUILTIN_INVENTORY.marketplace_agents.length);
    expect(manifest.inventory.marketplace_skills)
      .toHaveLength(gate.REQUIRED_BUILTIN_INVENTORY.marketplace_skills.length);
    expect(manifest.inventory.marketplace_skills)
      .toContainEqual(expect.objectContaining({ id: '8d2f4b7c9a10', name: 'paper-repro' }));
    expect(manifest.inventory.marketplace_skills)
      .toContainEqual(expect.objectContaining({ id: 'e7f5c0e6f1be' }));
    expect(manifest.inventory.marketplace_agents)
      .toContainEqual(expect.objectContaining({
        id: '78900d8758bc',
        icon: 'search',
        color: 'sky',
        updated_at: '2026-07-14T15:17:44',
        skill_list: expect.arrayContaining(['e7f5c0e6f1be']),
      }));
    expect(manifest.inventory.marketplace_agents)
      .toContainEqual(expect.objectContaining({
        id: '79df9cc89f5f',
        skill_list: [
          'composition-design-review',
          'design-system-importer',
          'frontend-design',
          'gate-control',
          'stage-assemble',
          'stage-compose',
          'stage-consistency',
          'stage-decide',
          'stage-edit',
          'stage-generate',
          'stage-plan',
          'video-craft',
          'video-router',
        ],
        embedded_skills: expect.arrayContaining([
          'video-router',
          'gate-control',
          'frontend-design',
          'design-system-importer',
          'composition-design-review',
          'video-craft',
          'stage-compose',
          'stage-edit',
          'stage-decide',
          'stage-generate',
          'stage-consistency',
          'stage-plan',
          'stage-assemble',
        ]),
      }));
  });

  /**
   * Guards the one failure mode no other layer catches: files disappear AND the
   * manifest is regenerated, so every hash is internally consistent and nothing
   * looks wrong.
   *
   * Measured on a copy of `resources/builtin` with the manifest regenerated after
   * the deletion:
   *   - delete a required system SKILL.md  → caught (`missing system skill`)
   *   - delete a whole agent directory     → caught (`inventory does not match`)
   *   - delete one references/*.md         → NOT caught by any layer
   *   - delete 20 skills' schemas.json     → NOT caught by any layer
   *
   * The old form of this test asserted a literal count, which did catch the last
   * two — but had to be hand-edited on every content change, and was silently
   * left stale twice (129 → 138 → … → 1275 while the tree held 1421), during
   * which it was failing rather than guarding.
   *
   * So the count is compared against the committed `_manifest.json` instead. That
   * file is a real second source: it is written by `npm run builtin:manifest` and
   * reviewed in a diff, so dropping files without noticing means committing a
   * manifest whose row count moved — visible in review — rather than editing a
   * number in a test to make it pass.
   */
  it('tracks exactly the files the committed manifest declares', () => {
    const root = path.join(process.cwd(), 'resources', 'builtin');
    const manifest = gate.createBuiltinManifest(root, { allowIgnoredJunk: true });
    const committed = JSON.parse(
      fs.readFileSync(path.join(root, '_manifest.json'), 'utf8'),
    ) as { files: unknown[] };

    expect(manifest.files).toHaveLength(committed.files.length);
    // A floor as well, so a mass deletion accompanied by a regenerated manifest
    // cannot shrink both sides in lockstep and still pass. Deliberately far below
    // the real count: this is a "the tree was gutted" tripwire, not a running
    // total to maintain.
    expect(manifest.files.length).toBeGreaterThan(900);
  });

  it('rejects missing primary files before a release can be signed', () => {
    const root = copyBuiltin();
    fs.rmSync(path.join(root, 'system', 'skills', 'coding', 'SKILL.md'));

    expect(() => gate.verifyBuiltinRoot(root)).toThrow(/missing system skill coding SKILL\.md/);
  });

  it('rejects deletion of a whole required builtin even if a manifest is regenerated', () => {
    const root = copyBuiltin();
    fs.rmSync(path.join(root, 'marketplace', 'agents', 'bcfcb4921dce'), { recursive: true });

    expect(() => gate.createBuiltinManifest(root))
      .toThrow(/required builtin marketplace agent inventory.*missing: bcfcb4921dce/);
  });

  it('rejects a changed reference or script when the manifest was not regenerated', () => {
    const root = copyBuiltin();
    fs.appendFileSync(
      path.join(root, 'marketplace', 'skills', '6743aa0797a2', 'references', 'brand-dna-template.md'),
      '\ntampered\n',
    );

    expect(() => gate.verifyBuiltinRoot(root)).toThrow(/builtin content tree mismatch/);
  });

  it('rejects unresolved skills in an agent semantic inventory', () => {
    const root = copyBuiltin();
    const file = path.join(root, 'marketplace', 'agents', 'e064dca9e1bd', 'agent.json');
    const agent = JSON.parse(fs.readFileSync(file, 'utf8'));
    agent.skill_list.push('missing-skill');
    fs.writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`);

    expect(() => gate.createBuiltinManifest(root)).toThrow(/references missing skill missing-skill/);
  });

  it('rejects an agent whose avatar or freshness metadata cannot drive an upgrade', () => {
    const root = copyBuiltin();
    const file = path.join(root, 'marketplace', 'agents', '78900d8758bc', 'agent.json');
    const agent = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete agent.icon;
    agent.updated_at = 'not-a-date';
    fs.writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`);

    expect(() => gate.createBuiltinManifest(root))
      .toThrow(/invalid id\/name\/version\/icon\/color\/update metadata/);
  });

  it('allows ignored source caches but rejects them from a copied application', () => {
    const root = copyBuiltin();
    const cache = path.join(root, 'marketplace', 'skills', '6743aa0797a2', '__pycache__', 'junk.pyc');
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, 'cache');

    expect(gate.verifyBuiltinRoot(root, { allowIgnoredJunk: true }))
      .toBe('resource:builtin:manifest-v1');
    expect(() => gate.verifyBuiltinRoot(root)).toThrow(/builtin content tree mismatch/);
  });

  it('requires explicit cache exclusions on the builtin extraResources entry', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const builtin = packageJson.build.extraResources.find((entry: { to?: string }) => entry.to === 'builtin');
    builtin.filter = builtin.filter.filter((entry: string) => entry !== '!**/*.pyc');

    expect(() => gate.verifyBuiltinExtraResourcesConfig(packageJson.build.extraResources))
      .toThrow(/missing filter !\*\*\/\*\.pyc/);
  });

  it('rejects forged manifest rows even when their declared tree hash is regenerated', () => {
    const root = copyBuiltin();
    const manifestFile = path.join(root, '_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const canonical = manifest.files.find((row: { path?: string }) => (
      row.path === 'marketplace/agents/c045605cb916/agent.json'
    ));
    canonical.bytes += 1;
    manifest.content_tree_sha256 = contentManifest.contentTreeSha256(manifest.files);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => contentManifest.verifyBuiltinContentManifest(root, { allowIgnoredJunk: true }))
      .toThrow(/builtin content tree mismatch/);
  });

  it('rejects duplicate or unsorted paths before hashing manifest data', () => {
    const files = contentManifest.collectBuiltinFiles(
      path.join(process.cwd(), 'resources', 'builtin'),
      { allowIgnoredJunk: true },
    );
    const duplicate = [{ ...files[0] }, { ...files[0] }];
    const unsorted = [{ ...files[1] }, { ...files[0] }];

    expect(() => contentManifest.contentTreeSha256(duplicate))
      .toThrow(/paths must be unique and sorted/);
    expect(() => contentManifest.contentTreeSha256(unsorted))
      .toThrow(/paths must be unique and sorted/);
  });
});
