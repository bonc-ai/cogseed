import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Builtin-packages seeder tests: manifest sanitisation, seed-state
// roundtrip, the install/upgrade/skip decision matrix, and the end-to-end
// seeding loop against mocked package CLI actions (the real CLI spawns are
// exercised by the manual smoke path, not unit tests).

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-builtin-pkgs-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Mocked {
  builtin: typeof import('../../../src/main/features/builtin_packages');
  runPackageInstall: ReturnType<typeof vi.fn>;
  runPackageCommand: ReturnType<typeof vi.fn>;
  readPackagesRegistry: ReturnType<typeof vi.fn>;
}

async function loadModules(opts: { manifest?: unknown; registry?: unknown } = {}): Promise<Mocked> {
  const bundled = path.join(tmpDir, 'bundled');
  const manifest = opts.manifest ?? {
    version: 1,
    packages: [{ name: 'eduseed-course-client', source_version: '0.4.0', rel_dir: 'eduseed-course-client' }],
  };
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, '_builtin.json'), JSON.stringify(manifest));
  // Materialise every declared source dir so the seeder's presence check passes,
  // including a valid manifest.json (the seeder now refuses invalid manifests).
  const rows = (manifest as { packages?: Array<{ name?: string; rel_dir?: string }> }).packages ?? [];
  for (const row of rows) {
    const rel = (typeof row?.rel_dir === 'string' && row.rel_dir) || row?.name || '';
    if (rel) {
      const dir = path.join(bundled, rel);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: '1.0', version: '1.0.0' }));
    }
  }

  const runPackageInstall = vi.fn(async () => ({ ok: true, stdout: '' }));
  const runPackageCommand = vi.fn(async () => ({ ok: true, stdout: '' }));
  const readPackagesRegistry = vi.fn(() => {
    const file = path.join(tmpDir, TEST_UID, 'local', 'packages', '_registry.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { version: 1, packages: [] };
    }
  });

  vi.doMock('../../../src/main/paths', () => ({
    packagedBuiltinPackagesDir: () => bundled,
    userPackagesDir: (uid: string) => path.join(tmpDir, uid, 'local', 'packages'),
  }));
  vi.doMock('../../../src/main/features/packages', () => ({
    readPackagesRegistry,
    runPackageInstall,
    runPackageCommand,
  }));

  const builtin = await import('../../../src/main/features/builtin_packages');
  return { builtin, runPackageInstall, runPackageCommand, readPackagesRegistry };
}

function writeRegistry(entries: unknown[]): void {
  const dir = path.join(tmpDir, TEST_UID, 'local', 'packages');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_registry.json'), JSON.stringify({ version: 1, packages: entries }));
}

describe('builtin_packages › sanitiseBuiltinManifest', () => {
  it('accepts valid rows and drops unsafe ones', async () => {
    const { builtin } = await loadModules({ manifest: {} });
    const parsed = builtin.sanitiseBuiltinManifest({
      version: 1,
      packages: [
        { name: 'eduseed-course-client', source_version: '0.4.0', rel_dir: 'eduseed-course-client' },
        { name: '../evil', source_version: '1.0.0', rel_dir: 'x' },
        { name: 'ok-name', source_version: '1.0.0', rel_dir: '/abs/evil' },
        { name: 'no-version', rel_dir: 'no-version' },
        { name: 'ok-2', source_version: '1.0.0', rel_dir: 'a/../b' },
        'junk',
      ],
    });
    expect(parsed.packages).toHaveLength(1);
    expect(parsed.packages[0]).toEqual({
      name: 'eduseed-course-client',
      source_version: '0.4.0',
      rel_dir: 'eduseed-course-client',
    });
  });

  it('returns an empty list for non-object manifests', async () => {
    const { builtin } = await loadModules({ manifest: {} });
    expect(builtin.sanitiseBuiltinManifest(null).packages).toEqual([]);
    expect(builtin.sanitiseBuiltinManifest('x').packages).toEqual([]);
    expect(builtin.sanitiseBuiltinManifest({ packages: 'x' }).packages).toEqual([]);
  });
});

describe('builtin_packages › decideSeedAction', () => {
  it('follows the install/upgrade/skip matrix', async () => {
    const { builtin } = await loadModules({ manifest: {} });
    expect(builtin.decideSeedAction(false, undefined, '0.4.0')).toBe('install');
    expect(builtin.decideSeedAction(true, undefined, '0.4.0')).toBe('upgrade');
    expect(builtin.decideSeedAction(true, '0.3.0', '0.4.0')).toBe('upgrade');
    expect(builtin.decideSeedAction(true, '0.4.0', '0.4.0')).toBe('skip');
  });
});

describe('builtin_packages › seedBuiltinPackagesForUser', () => {
  it('installs missing packages and records the seed state', async () => {
    const { builtin, runPackageInstall, runPackageCommand } = await loadModules();
    const result = await builtin.seedBuiltinPackagesForUser(TEST_UID);
    expect(result.installed).toEqual(['eduseed-course-client']);
    expect(result.upgraded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(runPackageInstall).toHaveBeenCalledWith(TEST_UID, {
      source: path.join(tmpDir, 'bundled', 'eduseed-course-client'),
      name: 'eduseed-course-client',
    });
    expect(runPackageCommand).not.toHaveBeenCalled();
    const state = builtin.readBuiltinSeedState(TEST_UID);
    expect(state['eduseed-course-client']).toBe('0.4.0');
  });

  it('skips when the installed version matches the recorded one', async () => {
    const { builtin, runPackageInstall } = await loadModules();
    await builtin.seedBuiltinPackagesForUser(TEST_UID);
    writeRegistry([{ name: 'eduseed-course-client', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true }]);
    const result = await builtin.seedBuiltinPackagesForUser(TEST_UID);
    expect(result.skipped).toEqual(['eduseed-course-client']);
    expect(runPackageInstall).toHaveBeenCalledTimes(1);
  });

  it('upgrades (remove + install) on a source_version bump', async () => {
    const { builtin, runPackageInstall, runPackageCommand } = await loadModules({
      manifest: {
        version: 1,
        packages: [{ name: 'eduseed-course-client', source_version: '0.5.0', rel_dir: 'eduseed-course-client' }],
      },
    });
    // Simulate an install seeded by an older app release (state on 0.4.0).
    writeRegistry([{ name: 'eduseed-course-client', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true }]);
    const stateFile = builtin.builtinSeedStateFile(TEST_UID);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, seeded: { 'eduseed-course-client': '0.4.0' } }));
    const result = await builtin.seedBuiltinPackagesForUser(TEST_UID);
    expect(result.upgraded).toEqual(['eduseed-course-client']);
    expect(runPackageCommand).toHaveBeenCalledWith(TEST_UID, 'remove', 'eduseed-course-client');
    expect(runPackageInstall).toHaveBeenCalledTimes(1);
    expect(builtin.readBuiltinSeedState(TEST_UID)['eduseed-course-client']).toBe('0.5.0');
  });

  it('records failures without writing state', async () => {
    const { builtin, runPackageInstall } = await loadModules();
    runPackageInstall.mockResolvedValueOnce({ ok: false, stdout: '', error: 'scan refused' });
    const result = await builtin.seedBuiltinPackagesForUser(TEST_UID);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({ name: 'eduseed-course-client', error: 'scan refused' });
    expect(builtin.readBuiltinSeedState(TEST_UID)).toEqual({});
  });

  it('refuses to seed a package whose bundled manifest.json is invalid', async () => {
    const { builtin, runPackageInstall } = await loadModules();
    fs.writeFileSync(path.join(tmpDir, 'bundled', 'eduseed-course-client', 'manifest.json'), '{ not json');
    const result = await builtin.seedBuiltinPackagesForUser(TEST_UID);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('eduseed-course-client');
    expect(result.failed[0].error).toContain('manifest.json invalid');
    expect(runPackageInstall).not.toHaveBeenCalled();
  });

  it('is a no-op when the manifest is missing', async () => {
    const bundled = path.join(tmpDir, 'bundled');
    fs.mkdirSync(bundled, { recursive: true });
    const { builtin } = await loadModules();
    fs.rmSync(path.join(bundled, '_builtin.json'));
    const result = await builtin.seedBuiltinPackagesForUser(TEST_UID);
    expect(result).toEqual({ installed: [], upgraded: [], skipped: [], failed: [] });
  });

  it('stops between packages when shouldContinue turns false', async () => {
    const { builtin, runPackageInstall } = await loadModules({
      manifest: {
        version: 1,
        packages: [
          { name: 'pkg-a', source_version: '1.0.0', rel_dir: 'pkg-a' },
          { name: 'pkg-b', source_version: '1.0.0', rel_dir: 'pkg-b' },
        ],
      },
    });
    let calls = 0;
    const result = await builtin.seedBuiltinPackagesForUser(TEST_UID, {
      shouldContinue: () => (calls += 1) <= 1,
    });
    expect(result.installed).toEqual(['pkg-a']);
    expect(runPackageInstall).toHaveBeenCalledTimes(1);
  });
});

// The shipped package content itself, not the seeder logic: these read the real
// resources/builtin-packages tree that a release bundles, and run its runtime
// bundles directly so a Windows regression is caught by the Windows CI job.
describe('builtin_packages › bundled EduSeed package', () => {
  const pkgDir = path.join(__dirname, '../../../resources/builtin-packages/eduseed-course-client');
  const skills = ['eduseed-student-aar', 'eduseed-student-review', 'eduseed-student-submit', 'eduseed-teacher-publish'];
  const runtimeSources = () => skills.map((skill) => fs.readFileSync(
    path.join(pkgDir, 'skills', skill, 'scripts', 'runtime.js'), 'utf8',
  ));
  const runtimePath = path.join(pkgDir, 'skills', 'eduseed-student-submit', 'scripts', 'runtime.js');

  const runRuntime = (command: string, payload: unknown, env: Record<string, string | undefined> = {}): Record<string, unknown> => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      EDUSEED_MOCK: '1',
      EDUSEED_STUDENT_ID: 'S-PKG',
      EDUSEED_ROLE: 'student',
      ...env,
    };
    // `undefined` means "unset in the child". HOME matters: the test runner
    // redirects it to a temp dir, while Windows never sets it at all.
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
    const res = spawnSync(process.execPath, [runtimePath, command, JSON.stringify(payload)], {
      encoding: 'utf8',
      env: childEnv,
    });
    const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('{"ok"'));
    expect(line, `runtime produced no JSON result (stderr: ${res.stderr})`).toBeTruthy();
    return JSON.parse(line as string) as Record<string, unknown>;
  };

  it('ships one byte-identical runtime across the four skills', () => {
    // All four skills run the same esbuild bundle; a partial rebuild would ship
    // divergent runtimes for the same plugin version.
    expect(new Set(runtimeSources()).size).toBe(1);
  });

  it('keeps the KSTAR record directory on the platform home', () => {
    // Windows defines USERPROFILE, not HOME. Building the record directory from
    // `process.env.HOME ?? ""` collapsed it to a CWD-relative `.eduseed` path, so
    // records landed wherever the skill ran and vanished when that directory
    // changed. On Windows this test is the regression guard; elsewhere HOME is
    // what both the old and new code read, so it only pins the contract.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eduseed-home-'));
    const env: Record<string, string | undefined> = process.platform === 'win32'
      ? { HOME: undefined, USERPROFILE: fakeHome }
      : { HOME: fakeHome };
    try {
      const result = runRuntime('submit-and-track', {
        challengeId: 'ch-mock-c03',
        projectTitle: 'T',
        githubRepoUrl: 'https://github.com/x/y',
        aarText: 'a',
        selfEvaluationText: 'self',
      }, env);
      expect(result.ok).toBe(true);
      const episodes = path.join(fakeHome, '.eduseed', 'kstar', 'S-PKG');
      const written = fs.existsSync(episodes) ? fs.readdirSync(episodes) : [];
      expect(written.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('matches required-deliverable path patterns with the platform separator', () => {
    // path.relative() yields "src\index.js" on Windows while challenge
    // required_deliverables are authored "src/**", so nothing containing a
    // separator matched and submissions were blocked with "缺少交付物".
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eduseed-deliverables-'));
    fs.mkdirSync(path.join(workdir, 'src', 'deep'), { recursive: true });
    for (const file of ['README.md', 'reflection.md', path.join('src', 'index.js'), path.join('src', 'deep', 'helper.js')]) {
      fs.writeFileSync(path.join(workdir, file), 'x\n');
    }
    try {
      const report = runRuntime('check-deliverables', {
        workdir,
        requiredDeliverables: 'README.md, src/**, reflection.md',
      }, {});
      expect(report.missing).toEqual([]);
      expect(report.found).toEqual(['README.md', 'src/**', 'reflection.md']);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('runs the documented-offline commands with no credentials at all', () => {
    // SKILL.md marks check-deliverables and prepare-submission as 离线, but
    // loadConfig ran before the license-exempt check, so a fresh install with no
    // platform configuration could not use them: they died with ConfigError
    // instead of returning the local report.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eduseed-offline-'));
    fs.mkdirSync(path.join(workdir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workdir, 'README.md'), 'x\n');
    fs.writeFileSync(path.join(workdir, 'src', 'index.js'), 'x\n');
    const bare = { EDUSEED_MOCK: undefined, EDUSEED_STUDENT_ID: undefined, EDUSEED_ROLE: undefined };
    try {
      const checked = runRuntime('check-deliverables', {
        workdir,
        requiredDeliverables: 'README.md, src/**',
      }, bare);
      expect(checked.ok).toBe(true);
      expect(checked.found).toEqual(['README.md', 'src/**']);

      const prepared = runRuntime('prepare-submission', {
        workdir,
        requiredDeliverables: 'README.md',
        challengeId: 'ch-mock-c03',
        projectTitle: 'T',
        githubRepoUrl: 'https://github.com/x/y',
      }, bare);
      expect(prepared.ok).toBe(true);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('keeps manifest, package.json and the seed manifest on one version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.json'), 'utf8')) as { version: string };
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version: string };
    const builtin = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../../resources/builtin-packages/_builtin.json'), 'utf8',
    )) as { packages: Array<{ name: string; source_version: string }> };
    const entry = builtin.packages.find((p) => p.name === 'eduseed-course-client');
    // source_version drives re-seeding on upgrade, so a stale value silently
    // leaves existing installs on the old bundle.
    expect(entry?.source_version).toBe(manifest.version);
    expect(pkg.version).toBe(manifest.version);
    // The bundle reports its own version for the update check; a constant that
    // lags the manifest makes it re-offer an update that is already installed.
    const version = runRuntime('plugin-version', {}, {});
    expect(version.current_version).toBe(manifest.version);
  });
});
