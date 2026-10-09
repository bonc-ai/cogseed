import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_NODE = process.env.COGSEED_TEST_NODE || process.execPath;

// run-skill.cjs resolution across the external-packages root (registry-
// driven) + package-local dependency preference. Companion to
// test/main/util/run-skill.test.ts (custom/marketplace roots).

const TEST_UID = 'u1';
let tmpDir: string;
const tmpDirs: string[] = [];

function pkgsDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'packages');
}

function packageVenvKey(name: string, repoUrl: string, commit: string): string {
  const hash = createHash('sha256').update([name, repoUrl, commit].join('\n')).digest('hex').slice(0, 12);
  return `${name}-${hash}`;
}

function writeRegistry(registry: unknown): void {
  fs.mkdirSync(pkgsDir(), { recursive: true });
  fs.writeFileSync(path.join(pkgsDir(), '_registry.json'), JSON.stringify(registry));
}

/** Package fixture: skills/<id>/{SKILL.md, scripts/<base>.js} + its own
 *  node_modules carrying a marker module the script imports. */
function writePackageSkill(pkgName: string, skillId: string, displayName: string): void {
  const pkgDir = path.join(pkgsDir(), pkgName);
  const skillDir = path.join(pkgDir, 'skills', skillId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${displayName}\ndescription: pkg skill\n---\nbody\n`,
  );
  // Marker dep vendored INSIDE the package — resolving it proves the
  // package-local node_modules is on the resolution path.
  const markerDir = path.join(pkgDir, 'node_modules', 'pkg-marker');
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, 'package.json'), JSON.stringify({ name: 'pkg-marker', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(markerDir, 'index.js'), 'module.exports = "from-package-deps";');
  fs.writeFileSync(
    path.join(scriptsDir, 'hello.js'),
    'const marker = require("pkg-marker");\nmodule.exports = async ({ args }) => ({ marker, args });\n',
  );
}

function writePackagePythonSkill(pkgName: string, skillId: string): void {
  const skillDir = path.join(pkgsDir(), pkgName, 'skills', skillId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: pkg py skill\n---\nbody\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, 'run.py'),
    process.platform === 'win32'
      ? 'process.stdout.write(JSON.stringify({ python: "shared", script: process.argv[1], arg: process.argv[2] }));\n'
      : 'print("package-local python should not run")\n',
  );
}

function runSkill(skillRef: string, scriptBase: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const pcRoot = process.cwd();
  return spawnSync(TEST_NODE, [
    path.join(pcRoot, 'bin', 'run-skill.cjs'),
    skillRef,
    scriptBase,
    '--',
    ...args,
  ], {
    cwd: pcRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      COGSEED_WORKSPACE_ROOT: tmpDir,
      COGSEED_PC_DIR: pcRoot,
      COGSEED_UID: TEST_UID,
      // Pin HOME into the sandbox tmp so the global-root scan
      // (~/.claude, ~/.codex) can't pick up skills from the developer machine.
      HOME: path.join(tmpDir, 'home'),
      USERPROFILE: path.join(tmpDir, 'home'),
      ...extraEnv,
    },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-run-skill-pkg-'));
  tmpDirs.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true });
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

describe('run-skill.cjs › external packages root', () => {
  it('resolves a package skill by id and uses the package-local node_modules', () => {
    writePackageSkill('mypack', 'pkg-hello', 'pkg-hello');
    writeRegistry({
      version: 1,
      packages: [{ name: 'mypack', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true }],
    });

    const r = runSkill('pkg-hello', 'hello', ['x']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ marker: 'from-package-deps', args: ['x'] });
  });

  it('resolves by SKILL.md display name when the dir id differs', () => {
    writePackageSkill('mypack', 'internal-dir-id', 'friendly-name');
    writeRegistry({
      version: 1,
      packages: [{ name: 'mypack', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true }],
    });

    const r = runSkill('friendly-name', 'hello');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).marker).toBe('from-package-deps');
  });

  it('does not resolve skills from disabled packages', () => {
    writePackageSkill('mypack', 'pkg-hello', 'pkg-hello');
    writeRegistry({
      version: 1,
      packages: [{ name: 'mypack', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: false }],
    });

    const r = runSkill('pkg-hello', 'hello');
    expect(r.status).toBe(66);
    expect(r.stderr).toContain('skill script not found');
  });

  it('does not resolve package skills when the registry is absent (no blind scan)', () => {
    writePackageSkill('mypack', 'pkg-hello', 'pkg-hello');
    // No _registry.json on purpose.
    const r = runSkill('pkg-hello', 'hello');
    expect(r.status).toBe(66);
  });

  it('uses shared data/venv Python for package skill scripts', () => {
    const repoUrl = 'https://example.test/mypack.git';
    const commit = 'abc123';
    writePackagePythonSkill('mypack', 'pkg-py');
    writeRegistry({
      version: 1,
      packages: [{
        name: 'mypack',
        repo_url: repoUrl,
        commit,
        kind: 'skill',
        skill_roots: ['skills'],
        bin_entries: [],
        enabled: true,
      }],
    });
    const python = path.join(
      tmpDir,
      'venv',
      'python',
      'packages',
      packageVenvKey('mypack', repoUrl, commit),
      '.venv',
      ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']),
    );
    fs.mkdirSync(path.dirname(python), { recursive: true });
    if (process.platform === 'win32') {
      // Do not hard-link the currently running test Node executable: Windows
      // locks the shared file record until the outer test process exits, which
      // makes deterministic temp cleanup impossible.
      fs.copyFileSync(TEST_NODE, python);
    } else {
      fs.writeFileSync(python, [
        '#!/bin/sh',
        'printf \'{"python":"shared","script":"%s","arg":"%s"}\\n\' "$1" "$2"',
        '',
      ].join('\n'));
      fs.chmodSync(python, 0o755);
    }

    const r = runSkill('pkg-py', 'run', ['x']);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({
      python: 'shared',
      script: path.join(pkgsDir(), 'mypack', 'skills', 'pkg-py', 'scripts', 'run.py'),
      arg: 'x',
    });
  });

  it('honors COGSEED_RUN_SKILL_DIR without falling back to other roots', () => {
    const allowed = path.join(tmpDir, TEST_UID, 'cloud', 'skills', 'allowed');
    const allowedScripts = path.join(allowed, 'scripts');
    fs.mkdirSync(allowedScripts, { recursive: true });
    fs.writeFileSync(path.join(allowed, 'SKILL.md'), '---\nname: allowed\ndescription: d\n---\n');
    fs.writeFileSync(path.join(allowedScripts, 'ok.js'), 'module.exports = async () => ({ ok: true, where: "allowed" });\n');

    const blockedScripts = path.join(tmpDir, 'home', '.codex', 'skills', 'blocked', 'scripts');
    fs.mkdirSync(blockedScripts, { recursive: true });
    fs.writeFileSync(path.join(path.dirname(blockedScripts), 'SKILL.md'), '---\nname: blocked\ndescription: g\n---\n');
    fs.writeFileSync(path.join(blockedScripts, 'steal.sh'), 'printf \'{"ok":false,"where":"blocked"}\\n\'\n');

    const ok = runSkill('allowed', 'ok', [], { COGSEED_RUN_SKILL_DIR: allowed });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout.trim())).toEqual({ ok: true, where: 'allowed' });

    const denied = runSkill('blocked', 'steal', [], { COGSEED_RUN_SKILL_DIR: allowed });
    expect(denied.status).toBe(66);
    expect(denied.stderr).toContain('skill script not found');
    expect(denied.stderr).not.toContain(path.join('.codex', 'skills', 'blocked'));
  });

  it('resolves global-root skills from ~/.claude/skills', () => {
    const skillDir = path.join(tmpDir, 'home', '.claude', 'skills', 'global-hello', 'scripts');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(skillDir), 'SKILL.md'),
      '---\nname: global-hello\ndescription: g\n---\nbody\n',
    );
    fs.writeFileSync(path.join(skillDir, 'hello.js'), 'module.exports = async () => ({ ok: true, where: "global" });\n');

    const r = runSkill('global-hello', 'hello');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, where: 'global' });
  });

  it('resolves global-root skills from ~/.codex/skills (must stay in sync with paths.ts::globalSkillRoots)', () => {
    const skillDir = path.join(tmpDir, 'home', '.codex', 'skills', 'codex-hello', 'scripts');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(skillDir), 'SKILL.md'),
      '---\nname: codex-hello\ndescription: g\n---\nbody\n',
    );
    fs.writeFileSync(path.join(skillDir, 'hello.js'), 'module.exports = async () => ({ ok: true, where: "codex" });\n');

    const r = runSkill('codex-hello', 'hello');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, where: 'codex' });
  });
});

describe('run-skill.cjs › package runtime secrets injection', () => {
  function writeSecrets(pkgName: string, secrets: Record<string, unknown>): void {
    const dir = path.join(pkgsDir(), '.secrets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pkgName}.json`), JSON.stringify(secrets));
  }

  function writeManifest(pkgName: string, courseId: string): void {
    fs.mkdirSync(path.join(pkgsDir(), pkgName), { recursive: true });
    fs.writeFileSync(
      path.join(pkgsDir(), pkgName, 'manifest.json'),
      JSON.stringify({ name: pkgName, course_id: courseId }),
    );
  }

  /** Skill whose output reports presence (never values) of injected env keys —
   *  keeps the api_key out of test stdout/stderr entirely. */
  function writeEnvProbeSkill(pkgName: string, skillId: string): void {
    const skillDir = path.join(pkgsDir(), pkgName, 'skills', skillId);
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillId}\ndescription: env probe\n---\nbody\n`);
    fs.writeFileSync(
      path.join(scriptsDir, 'probe.js'),
      [
        'module.exports = async () => ({',
        '  hasKey: !!process.env.EDUSEED_API_KEY,',
        '  server: process.env.EDUSEED_SERVER_URL || "",',
        '  student: process.env.EDUSEED_STUDENT_ID || "",',
        '  role: process.env.EDUSEED_ROLE || "",',
        '  autoupdate: Object.prototype.hasOwnProperty.call(process.env, "EDUSEED_PLUGIN_AUTOUPDATE") ? process.env.EDUSEED_PLUGIN_AUTOUPDATE : null',
        '});',
        '',
      ].join('\n'),
    );
  }

  function writeCloudSkill(skillId: string): void {
    const skillDir = path.join(tmpDir, TEST_UID, 'cloud', 'skills', skillId);
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillId}\ndescription: cloud skill\n---\nbody\n`);
    fs.writeFileSync(
      path.join(scriptsDir, 'probe.js'),
      'module.exports = async () => ({ hasKey: !!process.env.EDUSEED_API_KEY });\n',
    );
  }

  function pkgEntry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { name, kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true, ...extra };
  }

  function probeResult(r: { stdout: string; stderr: string; status: number | null }) {
    return { status: r.status, stderr: r.stderr, out: JSON.parse(r.stdout.trim()) };
  }

  it('logs bad_uid (debug mode) and skips injection when COGSEED_UID is absent', () => {
    writeEnvProbeSkill('mypack', 'pkg-probe');
    writeRegistry({ version: 1, packages: [pkgEntry('mypack')] });
    writeSecrets('mypack', { server_url: 'http://s.example', api_key: 'k1', student_id: 's1' });
    const scriptDir = path.join(pkgsDir(), 'mypack', 'skills', 'pkg-probe');

    const r = runSkill('pkg-probe', 'probe', [], {
      COGSEED_UID: '',
      COGSEED_RUN_SKILL_DEBUG: '1',
      COGSEED_RUN_SKILL_DIR: scriptDir,
    });
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out).toEqual({ hasKey: false, server: '', student: '', role: '', autoupdate: null });
    expect(p.stderr).toContain('[run-skill:secrets]');
    expect(p.stderr).toContain('"reason":"bad_uid"');
  });

  it('logs registry_malformed (debug mode) when the registry has no packages array', () => {
    writeCloudSkill('cloud-probe');
    writeRegistry({ version: 1 });

    const r = runSkill('cloud-probe', 'probe', [], { COGSEED_RUN_SKILL_DEBUG: '1' });
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out.hasKey).toBe(false);
    expect(p.stderr).toContain('"reason":"registry_malformed"');
  });

  it('logs no_owner_package (debug mode) when the skill dir is not inside any package root', () => {
    writeCloudSkill('cloud-probe');
    writeRegistry({ version: 1, packages: [] });

    const r = runSkill('cloud-probe', 'probe', [], { COGSEED_RUN_SKILL_DEBUG: '1' });
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out.hasKey).toBe(false);
    expect(p.stderr).toContain('"reason":"no_owner_package"');
  });

  it('keeps stderr clean for non-package skills by default', () => {
    writeCloudSkill('cloud-probe');
    writeRegistry({ version: 1, packages: [] });

    const r = runSkill('cloud-probe', 'probe');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('[run-skill:secrets]');
    expect(JSON.parse(r.stdout.trim())).toEqual({ hasKey: false });
  });

  it('logs missing_secrets with the package name and defaults autoupdate off for plain-local installs', () => {
    writeEnvProbeSkill('mypack', 'pkg-probe');
    writeRegistry({ version: 1, packages: [pkgEntry('mypack')] });

    const r = runSkill('pkg-probe', 'probe');
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out).toEqual({ hasKey: false, server: '', student: '', role: '', autoupdate: '0' });
    expect(p.stderr).toContain('"reason":"missing_secrets"');
    expect(p.stderr).toContain('"package":"mypack"');
  });

  it('injects the owning package credentials and logs the package name', () => {
    writeEnvProbeSkill('mypack', 'pkg-probe');
    writeRegistry({ version: 1, packages: [pkgEntry('mypack')] });
    writeSecrets('mypack', { server_url: 'http://s.example', api_key: 'k1', student_id: 's1', role: 'student' });

    const r = runSkill('pkg-probe', 'probe');
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out).toEqual({
      hasKey: true,
      server: 'http://s.example',
      student: 's1',
      role: 'student',
      autoupdate: '0',
    });
    expect(p.stderr).toContain('"reason":"injected"');
    expect(p.stderr).toContain('"package":"mypack"');
    expect(p.stderr).not.toContain('k1');
  });

  it('borrows credentials from a same-course configured package', () => {
    writeEnvProbeSkill('pilot', 'pkg-probe');
    writeEnvProbeSkill('builtin', 'other-probe');
    writeManifest('pilot', 'aix-course-elite20');
    writeManifest('builtin', 'aix-course-elite20');
    writeRegistry({
      version: 1,
      packages: [pkgEntry('pilot'), pkgEntry('builtin')],
    });
    writeSecrets('builtin', { server_url: 'http://builtin.example', api_key: 'k2', student_id: 's2', role: 'teacher' });

    const r = runSkill('pkg-probe', 'probe');
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out).toEqual({
      hasKey: true,
      server: 'http://builtin.example',
      student: 's2',
      role: 'teacher',
      autoupdate: '0',
    });
    expect(p.stderr).toContain('"reason":"borrowed"');
    expect(p.stderr).toContain('"package":"pilot"');
    expect(p.stderr).toContain('"from_package":"builtin"');
    expect(p.stderr).not.toContain('k2');
  });

  it('does not borrow from a different-course package', () => {
    writeEnvProbeSkill('pilot', 'pkg-probe');
    writeEnvProbeSkill('other', 'other-probe');
    writeManifest('pilot', 'aix-course-elite20');
    writeManifest('other', 'some-other-course');
    writeRegistry({
      version: 1,
      packages: [pkgEntry('pilot'), pkgEntry('other')],
    });
    writeSecrets('other', { server_url: 'http://other.example', api_key: 'k3', student_id: 's3' });

    const r = runSkill('pkg-probe', 'probe');
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out.hasKey).toBe(false);
    expect(p.stderr).toContain('"reason":"missing_secrets"');
    expect(p.stderr).not.toContain('borrowed');
  });

  it('does not borrow from a disabled or key-less sibling', () => {
    writeEnvProbeSkill('pilot', 'pkg-probe');
    writeManifest('pilot', 'aix-course-elite20');
    writeManifest('disabled-sib', 'aix-course-elite20');
    writeManifest('keyless-sib', 'aix-course-elite20');
    writeRegistry({
      version: 1,
      packages: [pkgEntry('pilot'), pkgEntry('disabled-sib', { enabled: false }), pkgEntry('keyless-sib')],
    });
    writeSecrets('disabled-sib', { server_url: 'http://d.example', api_key: 'k4', student_id: 's4' });
    writeSecrets('keyless-sib', { server_url: 'http://k.example', api_key: '', student_id: 's5' });

    const r = runSkill('pkg-probe', 'probe');
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out.hasKey).toBe(false);
    expect(p.stderr).toContain('"reason":"missing_secrets"');
    expect(p.stderr).not.toContain('borrowed');
  });

  it('keeps explicit caller env over injected secrets', () => {
    writeEnvProbeSkill('mypack', 'pkg-probe');
    writeRegistry({ version: 1, packages: [pkgEntry('mypack')] });
    writeSecrets('mypack', { server_url: 'http://stored.example', api_key: 'k5', student_id: 's6' });

    const r = runSkill('pkg-probe', 'probe', [], { EDUSEED_SERVER_URL: 'http://caller.example' });
    const p = probeResult(r);
    expect(p.status).toBe(0);
    expect(p.out).toEqual({
      hasKey: true,
      server: 'http://caller.example',
      student: 's6',
      role: '',
      autoupdate: '0',
    });
    expect(p.stderr).toContain('"reason":"injected"');
  });
});
