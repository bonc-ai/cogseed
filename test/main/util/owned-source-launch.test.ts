import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolveRuntimeIdentity } from '../../../src/main/brand';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const temps: string[] = [];
afterEach(() => temps.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function fixture(variant: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned source '));
  temps.push(dir);
  for (const file of ['run.sh', 'bootstrap.cjs', 'scripts/prepare-source-runtime.cjs',
    'scripts/lib/source-launch.cjs', 'scripts/lib/source-launch.sh', 'scripts/lib/runtime-pids.sh',
    'scripts/restart-cogseed.sh', 'src/main/install-data-root.cjs', 'src/main/identity-contract.cjs',
    'src/resources/identity.json', 'src/resources/brand.json']) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'bootstrap.cjs', cogseedSourceRuntimeVariant: variant }));
  for (const file of ['ensure-deps.cjs', 'ensure-dev-dependencies.cjs']) fs.writeFileSync(path.join(dir, 'scripts', file), '');
  fs.writeFileSync(path.join(dir, 'scripts/prepare-source-runtime.cjs'), `
    exports.sourceRuntimeIdentity = v => ({appName: v === 'messaging' ? 'CogSeed [Messaging]' : 'CogSeed'});
  `);
  fs.mkdirSync(path.join(dir, 'node_modules/electron/dist', variant === 'messaging' ? 'CogSeed [Messaging].app' : 'CogSeed.app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fake-bin'));
  fs.writeFileSync(path.join(dir, 'fake-bin/uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'fake-bin/open'), `#!/usr/bin/env node
    console.log(JSON.stringify({args:process.argv.slice(2), variant:process.env.COGSEED_RUNTIME_VARIANT, source:process.env.COGSEED_SOURCE_RUNTIME_VARIANT}));
  `, { mode: 0o755 });
  return dir;
}

function launch(dir: string, extra: Record<string, string> = {}) {
  return spawnSync('bash', [path.join(dir, 'run.sh')], { encoding: 'utf8', env: {
    ...process.env, NODE_OPTIONS: '', COGSEED_WORKSPACE_ROOT: '', COGSEED_RUNTIME_VARIANT: '',
    COGSEED_SOURCE_RUNTIME_VARIANT: '', COGSEED_BUILD_CHANNEL: 'dev',
    COGSEED_DEV_CDP_PORT: '', COGSEED_DEV_INSPECT_PORT: '', COGSEED_DEV_DEBUG_ADDRESS: '',
    PATH: `${dir}/fake-bin:${process.env.PATH}`, ...extra,
  } });
}

function bootstrapBeforeApp(options: { packaged?: boolean; lock?: string; env?: Record<string, string>; args?: string[] } = {}) {
  const code = fs.readFileSync(path.join(root, 'bootstrap.cjs'), 'utf8');
  const contract = require('../../../src/main/install-data-root.cjs');
  const identity = require('../../../src/main/identity-contract.cjs');
  let selected: string | undefined;
  const env = { ...options.env };
  // bootstrap.cjs 用 detectPackagedRuntime() 判定「打包 / 源码」：
  // `!resourcesPath.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`)`。
  // 硬编码 `${root}/node_modules/...` 在 win32 上拼出的是 `…\…/node_modules/…`
  // （混合分隔），永远不含 `\node_modules\electron\` → 源码运行被判成打包运行，
  // 于是走到 packaged 的 variant 闸门（invalid runtime variant / only the main …）。
  // 必须用 path.join 拼同一形状，判定才跨平台成立。
  const sourceResources = path.join(root, 'node_modules', 'electron', 'dist', 'CogSeed [Messaging].app', 'Contents', 'Resources');
  const proc = { env, versions: { electron: '41' }, resourcesPath: options.packaged ? '/Applications/CogSeed.app/Contents/Resources' : sourceResources, argv: ['electron', root, ...(options.args || [])], stderr: { write() {} } };
  let error = '';
  try {
    vm.runInNewContext(code, { process: proc, __dirname: root, require(id: string) {
      if (id === './package.json') return { cogseedSourceRuntimeVariant: options.lock || 'messaging' };
      if (id === './src/main/identity-contract.cjs') return identity;
      if (id === './src/main/install-data-root.cjs') return { ...contract, initializeInstallDataRoot(v: string) { selected = v; throw new Error('STOP_BEFORE_APP'); } };
      if (id.startsWith('node:')) return require(id);
      throw new Error(`unexpected app load ${id}`);
    } });
  } catch (e) { error = String(e); }
  return { selected, error, env };
}

function restartFixture(variant: string, mainRunning: boolean) {
  const dir = fixture(variant);
  const appName = variant === 'messaging' ? 'CogSeed [Messaging]' : 'CogSeed';
  const exe = `${dir}/node_modules/electron/dist/${appName}.app/Contents/MacOS/Electron`;
  const ownMain = `700001 ${exe} --inspect=127.0.0.1:9233 ${dir} --cogseed-runtime-variant=${variant}`;
  const snapshot = [
    ...(mainRunning ? [ownMain] : []),
    `700002 node ${dir}/p3394-gateway/gateway.cjs --port 0`,
    `700003 ${exe.replace(dir, `${dir}/nested`)} ${dir}/nested --cogseed-runtime-variant=${variant}`,
    `700004 ${exe} ${dir} --cogseed-runtime-variant=${variant === 'messaging' ? 'cogseed' : 'messaging'}`,
    `700005 ${exe} ${dir}/node_modules/vitest/vitest.mjs`,
    '700006 node /tmp/unrelated-server.js --port 9223',
    `700007 ${exe} ${dir} --cogseed-runtime-variant=${variant} --type=renderer`,
  ];
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(dir, 'fake-bin/ps'), `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.T7_RESTART_FIXTURE;
const killed = fs.existsSync(dir + '/killed') ? fs.readFileSync(dir + '/killed', 'utf8').trim().split('\\n') : [];
const rows = JSON.parse(fs.readFileSync(dir + '/snapshot.json', 'utf8'));
if (fs.existsSync(dir + '/started')) rows.push(${JSON.stringify(ownMain)});
process.stdout.write(rows.filter(row => !killed.includes(row.split(' ')[0])).join('\\n') + '\\n');
`, { mode: 0o755 });
  // Replace only the fixture launcher. A real Electron binary is never invoked.
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/bash\ntouch "$T7_RESTART_FIXTURE/started"\necho fixture-launch-only\n', { mode: 0o755 });
  const runLog = require('../../../scripts/lib/source-launch.cjs').sourceLaunchConfig(dir, {}).runLog;
  temps.push(runLog);
  const run = (action: string) => spawnSync('bash', ['-c', `
kill() { printf '%s\\n' "$*" >> "$T7_RESTART_FIXTURE/killed"; }
export -f kill
bash "$1" "$2"
`, 'test', path.join(dir, 'scripts/restart-cogseed.sh'), action], { encoding: 'utf8', env: {
    ...process.env, NODE_OPTIONS: '', COGSEED_WORKSPACE_ROOT: '', COGSEED_RUNTIME_VARIANT: '', COGSEED_SOURCE_RUNTIME_VARIANT: '',
    COGSEED_BUILD_CHANNEL: 'dev', COGSEED_DEV_CDP_PORT: '9223', COGSEED_DEV_INSPECT_PORT: '9233', COGSEED_DEV_DEBUG_ADDRESS: '127.0.0.1',
    PATH: `${dir}/fake-bin:${process.env.PATH}`, T7_RESTART_FIXTURE: dir,
  } });
  return { dir, runLog, run };
}

/**
 * 只有 POSIX 宿主能表达的执行环境（不是产品行为差异）。
 *
 * 这一组用例驱动的是 POSIX 启动器本身：用 fake `uname` 把宿主伪装成 Darwin/Linux，
 * 再用 fake `open` / `npm` / `ps` shim 拦住真实的 Electron 启动。win32 上跑脚本的
 * bash 是 Git Bash(MSYS)：
 *   - argv 交给 native 程序前会被路径改写（`/tmp/x` → `C:/x`），所以启动器传出的
 *     APP_DIR 与 Node 看到的 `C:\...` 永远不是同一个字符串；
 *   - 没有 `open`，也没有 `ps -ax -o pid= -o command=`（MSYS 的 ps 直接报
 *     `unknown option -- x`）；
 *   - `node_modules/.bin/electron`、`*.app/Contents/MacOS/Electron` 这些目录形状
 *     只是被 fixture 造出来的，Windows 的等价物是 `.cmd` shim。
 * 继续在 win32 上跑只会变成「被测路径根本没被执行到」的假红。Windows 启动器是
 * run.cmd，由 test/main/util/runtime-launcher.test.ts 的 runIf(win32) 用例覆盖。
 *
 * 本文件其余用例不受影响：runtime-pids.sh 的纯字符串判定、bootstrap 身份闸门、
 * source-launch.cjs 配置都在所有平台继续跑。
 */
const POSIX_LAUNCHER_ONLY = process.platform === 'win32';

describe('owned source launch boundary', () => {
  it.each(['cogseed', 'messaging'])('gateway PID matching requires the first node executable and immediate owned entrypoint for %s', variant => {
    const dir = '/tmp/owned checkout';
    const gateway = `${dir}/p3394-gateway/gateway.cjs`;
    const rows = [
      `100 node ${gateway}`,
      `101 /usr/bin/node ${gateway} --port 0`,
      `102 /opt/node/bin/node ${gateway}`,
      `200 node /tmp/harness.cjs /usr/bin/node ${gateway}`,
      `201 /usr/bin/printf /usr/bin/node ${gateway}`,
      `202 /usr/bin/node /tmp/harness.cjs /usr/bin/node ${gateway}`,
      `203 node ${dir}/nested/p3394-gateway/gateway.cjs`,
      `204 /usr/bin/node /tmp/foreign/p3394-gateway/gateway.cjs`,
      `205 /usr/bin/node ${gateway}-other`,
      `206 relative/bin/node ${gateway}`,
    ];
    for (const scope of ['all', 'main']) {
      const result = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; worktree_runtime_pids "$2" "$3" "$4" "$5"', 'test', path.join(root, 'scripts/lib/runtime-pids.sh'), dir, variant, variant === 'messaging' ? 'CogSeed [Messaging]' : 'CogSeed', scope], { input: rows.join('\n'), encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split('\n').filter(Boolean)).toEqual(scope === 'all' ? ['100', '101', '102'] : []);
    }
  });

  it.skipIf(POSIX_LAUNCHER_ONLY).each([['Darwin', 'cogseed'], ['Darwin', 'messaging'], ['Linux', 'cogseed'], ['Linux', 'messaging']])('fallback uses an absolute application entry on %s for %s with debugging off or on', (platform, variant) => {
    const dir = fixture(variant);
    fs.writeFileSync(path.join(dir, 'fake-bin/uname'), `#!/bin/sh\necho ${platform}\n`, { mode: 0o755 });
    const appName = variant === 'messaging' ? 'CogSeed [Messaging]' : 'CogSeed';
    fs.rmSync(path.join(dir, `node_modules/electron/dist/${appName}.app`), { recursive: true });
    const wrapper = path.join(dir, 'node_modules/.bin/electron');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    const binary = platform === 'Linux' ? path.join(dir, 'node_modules/electron/dist/electron') : wrapper;
    fs.writeFileSync(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),executable:process.argv[1]}));\n', { mode: 0o755 });
    if (platform === 'Linux') fs.writeFileSync(wrapper, '#!/bin/bash\nexec "$T7_FALLBACK_BINARY" "$@"\n', { mode: 0o755 });
    // Reproduce npm's existing electron . expansion without running npm/Electron.
    fs.writeFileSync(path.join(dir, 'fake-bin/npm'), '#!/bin/bash\nexec "$T7_FALLBACK_ELECTRON" . "${@:4}"\n', { mode: 0o755 });
    for (const debug of [false, true]) {
      const result = launch(dir, { T7_FALLBACK_ELECTRON: wrapper, T7_FALLBACK_BINARY: binary, ...(debug ? { COGSEED_DEV_CDP_PORT: '9223', COGSEED_DEV_INSPECT_PORT: '9233' } : {}) });
      expect(result.status, result.stderr).toBe(0);
      const record = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      const args = record.args;
      expect(args).toEqual([
        ...(debug ? ['--inspect=127.0.0.1:9233', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223'] : []),
        dir, `--cogseed-runtime-variant=${variant}`,
      ]);
      if (platform === 'Linux') {
        expect(record.executable).toBe(binary);
        const main = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; worktree_runtime_pids "$2" "$3" "$4" main', 'test', path.join(root, 'scripts/lib/runtime-pids.sh'), dir, variant, appName], { input: `100 ${binary} ${args.join(' ')}\n`, encoding: 'utf8' });
        expect(main.status, main.stderr).toBe(0);
        expect(main.stdout.trim()).toBe('100');
      }
    }
  });

  it.each([['Darwin', 'cogseed'], ['Darwin', 'messaging'], ['Linux', 'cogseed'], ['Linux', 'messaging']])('fallback readiness on %s tracks the actual %s main across independent wrapper and orphan lifetimes', (platform, variant) => {
    const dir = '/tmp/owned checkout';
    const name = variant === 'messaging' ? 'CogSeed [Messaging]' : 'CogSeed';
    const exe = platform === 'Linux' ? `${dir}/node_modules/electron/dist/electron` : `${dir}/node_modules/electron/dist/${name}.app/Contents/MacOS/Electron`;
    const wrapper = `${dir}/node_modules/.bin/electron`;
    const flag = `--cogseed-runtime-variant=${variant}`;
    const rows: Record<string, string> = {
      '100': `${exe} ${dir} ${flag}`,
      '110': `node ${wrapper} ${dir} ${flag}`,
      '111': `/opt/node/bin/node ${wrapper} ${dir} ${flag}`,
      '112': `${wrapper} ${dir} ${flag}`,
      '113': `node ${wrapper} . ${flag}`,
      '120': `node ${dir}/p3394-gateway/gateway.cjs --port 0`,
      '121': `${exe} ${dir} ${flag} --type=renderer`,
    };
    const protectedRows = [
      `200 ${exe.replace(dir, `${dir}/nested`)} ${dir}/nested ${flag}`,
      `201 node ${wrapper} ${dir} --cogseed-runtime-variant=wrong`,
      `202 node ${wrapper.replace(dir, `${dir}/nested`)} . ${flag}`,
      `203 /usr/bin/printf ${wrapper} ${dir} ${flag}`,
      `204 node ${wrapper}-other ${dir} ${flag}`,
      `205 ${exe} ${dir}/node_modules/vitest/vitest.mjs`,
      `206 node ${wrapper} /tmp/foreign-app ${flag}`,
      `207 node ${wrapper} ${dir}-sibling ${flag}`,
      `208 /usr/bin/printf /opt/node/bin/node ${wrapper} ${dir} ${flag}`,
    ];
    for (const ids of [['100', '110', '111', '112', '113'], ['100'], ['110', '111', '112', '113'], ['120', '121'], []]) {
      const snapshot = [...ids.map(id => `${id} ${rows[id]}`), ...protectedRows].join('\n');
      const pids = (scope: string) => {
        const result = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; worktree_runtime_pids "$2" "$3" "$4" "$5"', 'test', path.join(root, 'scripts/lib/runtime-pids.sh'), dir, variant, name, scope], { input: snapshot, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim().split('\n').filter(Boolean);
      };
      expect(pids('main'), `ready: ${ids}`).toEqual(ids.filter(id => id === '100'));
      expect(pids('all'), `stop: ${ids}`).toEqual(ids);
    }
  });

  it.each(['cogseed', 'messaging'])('Linux other-worktree PID matching requires the executable owner, appdir and %s variant', variant => {
    const dir = '/tmp/owned checkout';
    const other = '/tmp/other checkout';
    const exe = `${other}/node_modules/electron/dist/electron`;
    const flag = `--cogseed-runtime-variant=${variant}`;
    const rows = [
      `100 ${dir}/node_modules/electron/dist/electron ${dir} ${flag}`,
      `200 ${exe} --inspect=127.0.0.1:9233 ${other} ${flag}`,
      `201 ${exe} ${other} --cogseed-runtime-variant=wrong`,
      `202 ${exe} /tmp/foreign-app ${flag}`,
      `203 ${exe} ${other}/node_modules/vitest/vitest.mjs ${flag}`,
      `204 /usr/bin/printf ${exe} ${other} ${flag}`,
      `205 ${exe}-other ${other} ${flag}`,
      `206 ${other}/node_modules/.bin/electron ${other} ${flag}`,
      `207 ${exe} ${other}-sibling ${flag}`,
    ];
    const result = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; other_worktree_runtime_pids "$2" "$3"', 'test', path.join(root, 'scripts/lib/runtime-pids.sh'), dir, variant], { input: rows.join('\n'), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['200']);
  });

  it.skipIf(POSIX_LAUNCHER_ONLY).each(['cogseed', 'messaging'])('launches the package-locked %s bundle with explicit loopback debugging', variant => {
    const dir = fixture(variant);
    const result = launch(dir, { COGSEED_DEV_CDP_PORT: '9223', COGSEED_DEV_INSPECT_PORT: '9233', COGSEED_HUB_API_BASE: 'http://127.0.0.1:4312', COGSEED_API_BASE_URL: 'https://api.example.test' });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(record.args).toContain(`${dir}/node_modules/electron/dist/${variant === 'messaging' ? 'CogSeed [Messaging]' : 'CogSeed'}.app`);
    expect(record.args).toContain(`--cogseed-runtime-variant=${variant}`);
    expect(record.args).toContain('--remote-debugging-address=127.0.0.1');
    expect(record.args).toContain('--remote-debugging-port=9223');
    expect(record.args).toContain('--inspect=127.0.0.1:9233');
    expect(record.args.indexOf('--inspect=127.0.0.1:9233')).toBeLessThan(record.args.indexOf(dir));
    expect(record.args).toContain('COGSEED_HUB_API_BASE=http://127.0.0.1:4312');
    expect(record.args).toContain('COGSEED_API_BASE_URL=https://api.example.test');
    expect(record.variant).toBeUndefined();
    expect(record.source).toBeUndefined();
    expect(record.args).toContain('COGSEED_RUNTIME_VARIANT=');
    expect(record.args).toContain('COGSEED_SOURCE_RUNTIME_VARIANT=');
  });

  it.skipIf(POSIX_LAUNCHER_ONLY)('defaults debugging off and rejects unsafe debug configuration before launch', () => {
    const dir = fixture('cogseed');
    const normal = launch(dir);
    expect(normal.status, normal.stderr).toBe(0);
    expect(normal.stdout).not.toContain('--inspect=');
    expect(normal.stdout).not.toContain('--remote-debugging-');
    for (const extra of [
      { COGSEED_DEV_CDP_PORT: '0' }, { COGSEED_DEV_CDP_PORT: '65536' },
      { COGSEED_DEV_CDP_PORT: '9223 --inspect=0.0.0.0:99' },
      { COGSEED_DEV_INSPECT_PORT: 'localhost:9233' },
      { COGSEED_DEV_CDP_PORT: '9223', COGSEED_DEV_DEBUG_ADDRESS: '0.0.0.0' },
      { COGSEED_DEV_CDP_PORT: '9223', COGSEED_BUILD_CHANNEL: 'release' },
      { COGSEED_DEV_CDP_PORT: '9223', COGSEED_DEV_INSPECT_PORT: '9223' },
      { NODE_OPTIONS: '--trace-warnings' },
    ]) expect(launch(dir, extra).status, JSON.stringify(extra)).toBe(2);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'bootstrap.cjs', cogseedSourceRuntimeVariant: 'cogseed', cogseedBuildChannel: 'release' }));
    expect(launch(dir, { COGSEED_DEV_CDP_PORT: '9223' }).status).toBe(2);
  });

  it('rejects environment identity/root overrides and invalid package locks', () => {
    const dir = fixture('messaging');
    for (const extra of [{ COGSEED_RUNTIME_VARIANT: 'cogseed' }, { COGSEED_SOURCE_RUNTIME_VARIANT: 'expense' }, { COGSEED_WORKSPACE_ROOT: '/tmp/shared' }]) {
      expect(launch(dir, extra).status).toBe(2);
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'bootstrap.cjs', cogseedSourceRuntimeVariant: 'arbitrary' }));
    expect(launch(dir).status).toBe(2);
  });

  it('bootstrap accepts only the configured source identity while keeping packaged normalization strict', () => {
    const identity = require('../../../src/main/identity-contract.cjs');
    const boot = (packaged: boolean, requested: string, lock = 'messaging') => bootstrapBeforeApp({ packaged, lock, env: { COGSEED_RUNTIME_VARIANT: requested }, args: [`--cogseed-runtime-variant=${requested}`] });
    expect(boot(false, 'messaging')).toMatchObject({ selected: 'messaging', error: 'Error: STOP_BEFORE_APP' });
    expect(boot(false, 'expense').error).toContain('locked to messaging');
    expect(boot(false, 'messaging', 'arbitrary').error).toContain('invalid or missing source runtime lock');
    expect(boot(true, 'messaging').error).toContain('invalid runtime variant');
    expect(() => identity.normalizeEnv({ COGSEED_RUNTIME_VARIANT: 'messaging' })).toThrow();
  });

  it.each(['cogseed', 'messaging', 'cognition', 'expense', 'optimization'])('direct source environment accepts only its package-locked %s identity without argv', lock => {
    for (const key of ['COGSEED_RUNTIME_VARIANT', 'COGSEED_SOURCE_RUNTIME_VARIANT']) {
      const matched = bootstrapBeforeApp({ lock, env: { [key]: lock } });
      expect(matched).toMatchObject({ selected: lock, error: 'Error: STOP_BEFORE_APP', env: { COGSEED_RUNTIME_VARIANT: lock, COGSEED_SOURCE_RUNTIME_VARIANT: lock } });
      // This is the same identity resolver used by index.ts after bootstrap.
      const resolved = resolveRuntimeIdentity(false, matched.env.COGSEED_RUNTIME_VARIANT);
      expect(resolved.variant).toBe(lock);
      expect(resolved.protocolOwner).toBe(lock === 'cogseed');
      const mismatch = lock === 'messaging' ? 'cogseed' : 'messaging';
      expect(bootstrapBeforeApp({ lock, env: { [key]: mismatch } })).toMatchObject({ selected: undefined, error: expect.stringContaining(`locked to ${lock}`) });
      expect(bootstrapBeforeApp({ lock, env: { [key]: 'arbitrary' } }).error).toContain('invalid COGSEED_RUNTIME_VARIANT');
    }
    expect(bootstrapBeforeApp({ lock })).toMatchObject({ selected: lock, error: 'Error: STOP_BEFORE_APP' });
  });

  it('rejects a conflicting source environment identity even when runtime environment matches the package', () => {
    expect(bootstrapBeforeApp({ lock: 'messaging', env: { COGSEED_RUNTIME_VARIANT: 'messaging', COGSEED_SOURCE_RUNTIME_VARIANT: 'expense' } })).toMatchObject({ selected: undefined, error: expect.stringContaining('locked to messaging') });
    expect(bootstrapBeforeApp({ lock: 'messaging', env: { COGSEED_RUNTIME_VARIANT: 'messaging' }, args: ['--cogseed-runtime-variant=expense'] }).error).toContain('runtime variant conflict');
  });

  it('retains packaged environment normalization and packaged variant gates for both environment keys', () => {
    for (const variant of ['messaging', 'cognition', 'expense', 'optimization', 'arbitrary', 'main']) {
      expect(bootstrapBeforeApp({ packaged: true, env: { COGSEED_RUNTIME_VARIANT: variant } })).toMatchObject({ selected: undefined, error: expect.stringContaining('invalid runtime variant') });
    }
    for (const variant of ['messaging', 'cogseed']) {
      expect(bootstrapBeforeApp({ packaged: true, env: { COGSEED_SOURCE_RUNTIME_VARIANT: variant } })).toMatchObject({ selected: undefined, error: expect.stringContaining('packaged CogSeed only supports the main') });
    }
    expect(bootstrapBeforeApp({ packaged: true })).toMatchObject({ selected: 'main', error: 'Error: STOP_BEFORE_APP' });
    expect(bootstrapBeforeApp({ packaged: true, env: { COGSEED_RUNTIME_VARIANT: 'cogseed' } })).toMatchObject({ selected: undefined, error: expect.stringContaining('packaged CogSeed only supports the main') });
  });

  it('bundle preparation follows its owning package lock and leaves messaging protocols empty', () => {
    const source = require('../../../scripts/prepare-source-runtime.cjs');
    expect(source.parseCogSeedWorktreeVariant(['--variant=messaging'], { cogseedSourceRuntimeVariant: 'messaging' })).toBe('messaging');
    expect(() => source.parseCogSeedWorktreeVariant(['--variant=cogseed'], { cogseedSourceRuntimeVariant: 'messaging' })).toThrow('locked to messaging');
    expect(source.sourceRuntimeBundleSpec('messaging').protocolSchemes).toEqual([]);
  });

  it('matches only this checkout and variant including inspector prefixes and spaced bundle names', () => {
    const dir = '/tmp/owned checkout';
    const exe = `${dir}/node_modules/electron/dist/CogSeed [Messaging].app/Contents/MacOS/Electron`;
    const peer = '/tmp/other checkout';
    const snapshot = [
      `10 ${exe} --inspect=127.0.0.1:9234 --remote-debugging-address=127.0.0.1 --remote-debugging-port=9224 ${dir} --cogseed-runtime-variant=messaging`,
      `11 ${exe} ${dir} --cogseed-runtime-variant=cogseed`,
      `12 ${exe} ${dir}/nested --cogseed-runtime-variant=messaging`,
      `13 ${exe} ${dir}/node_modules/vitest/vitest.mjs`,
      `14 node ${dir}/p3394-gateway/gateway.cjs-other`,
      `15 node ${dir}/p3394-gateway/gateway.cjs --port 0`,
      `16 ${exe.replace(dir, peer)} --inspect=127.0.0.1:9234 ${peer} --cogseed-runtime-variant=messaging`,
      `17 ${exe} ${dir} sibling --cogseed-runtime-variant=messaging`,
    ].join('\n');
    function pids(fn: string) {
      return spawnSync('bash', ['-c', 'source "$1"; "$2" "$3" messaging "CogSeed [Messaging]"', 'test', path.join(root, 'scripts/lib/runtime-pids.sh'), fn, dir], { input: snapshot, encoding: 'utf8' }).stdout.trim().split('\n');
    }
    expect(pids('worktree_runtime_pids')).toEqual(['10', '15']);
    expect(pids('other_worktree_runtime_pids')).toEqual(['16']);
  });

  it('keeps launcher logs separate for checkouts sharing a variant', () => {
    const a = fixture('messaging');
    const b = fixture('messaging');
    const config = (dir: string) => spawnSync('node', [path.join(dir, 'scripts/lib/source-launch.cjs'), dir], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', COGSEED_RUNTIME_VARIANT: '', COGSEED_SOURCE_RUNTIME_VARIANT: '', COGSEED_WORKSPACE_ROOT: '', COGSEED_BUILD_CHANNEL: 'dev', COGSEED_DEV_CDP_PORT: '', COGSEED_DEV_INSPECT_PORT: '', COGSEED_DEV_DEBUG_ADDRESS: '' } });
    const first = config(a);
    const second = config(b);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stdout.trim().split('\n')[2]).not.toBe(second.stdout.trim().split('\n')[2]);
  });

  it.skipIf(POSIX_LAUNCHER_ONLY).each(['cogseed', 'messaging'])('restart stop protects other checkouts, variants, tests and port owners for %s', variant => {
    const { dir, run } = restartFixture(variant, true);
    const result = run('stop');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${variant} runtime stopped`);
    expect(fs.readFileSync(path.join(dir, 'killed'), 'utf8').trim().split('\n')).toEqual(['700001', '700002', '700007']);
    expect(fs.existsSync(path.join(dir, 'started'))).toBe(false);
  });

  it.skipIf(POSIX_LAUNCHER_ONLY).each(['cogseed', 'messaging'])('restart start requires an owned main process rather than an orphan gateway for %s', variant => {
    const { dir, runLog, run } = restartFixture(variant, false);
    const result = run('start');
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, 'started'))).toBe(true);
    expect(result.stdout).toContain(`${variant} runtime is up for this worktree`);
    expect(result.stdout).toContain(runLog);
    expect(fs.readFileSync(runLog, 'utf8')).toContain('fixture-launch-only');
    expect(fs.existsSync(path.join(dir, 'killed'))).toBe(false);
  });

  it.skipIf(require('../../../package.json').cogseedSourceRuntimeVariant !== 'cogseed')('dev pair delegates to both owning launchers with Hub only, without account/port side effects', () => {
    const here = fixture('cogseed');
    const peer = fixture('messaging');
    fs.mkdirSync(path.join(here, 'scripts/dev'));
    fs.copyFileSync(path.join(root, 'scripts/dev/a2a-dev-start.sh'), path.join(here, 'scripts/dev/a2a-dev-start.sh'));
    for (const dir of [here, peer]) {
      fs.writeFileSync(path.join(dir, 'scripts/restart-cogseed.sh'), `#!/bin/bash
node -e 'console.log(JSON.stringify({action:process.argv[1],hub:process.env.COGSEED_HUB_API_BASE,api:process.env.COGSEED_API_BASE_URL,cdp:process.env.COGSEED_DEV_CDP_PORT,inspect:process.env.COGSEED_DEV_INSPECT_PORT}))' "$1"
`);
    }
    const runPair = () => spawnSync('bash', [path.join(here, 'scripts/dev/a2a-dev-start.sh'), 'restart'], { encoding: 'utf8', env: {
      ...process.env, NODE_OPTIONS: '', A2A_PEER_DIR: peer,
      COGSEED_WORKSPACE_ROOT: '', COGSEED_HUB_API_BASE: '', COGSEED_API_BASE_URL: '',
    } });
    const result = runPair();
    expect(result.status, result.stderr).toBe(0);
    const records = result.stdout.trim().split('\n').slice(0, 2).map(line => JSON.parse(line));
    expect(records).toEqual([
      { action: 'restart', hub: 'http://127.0.0.1:4312', api: '', cdp: '9223', inspect: '9233' },
      { action: 'restart', hub: 'http://127.0.0.1:4312', api: '', cdp: '9224', inspect: '9234' },
    ]);
    const script = fs.readFileSync(path.join(here, 'scripts/dev/a2a-dev-start.sh'), 'utf8');
    expect(script).not.toMatch(/fixture|TOKEN|relogin|lsof|kill|npm run|rsync/);
    fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ main: 'bootstrap.cjs', cogseedSourceRuntimeVariant: 'cogseed' }));
    const mismatch = runPair();
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toContain('expected messaging');
    expect(mismatch.stdout).toBe('');
  });
});
