import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create as createTar } from 'tar';
import type { JsonObject } from '../../../../src/main/features/expense_workbench/contracts';

const {
  PLATFORM_KEY,
  TRUSTED_EXPENSE_BRIDGE_PATH,
  TRUSTED_EXPENSE_COMPONENT_FILES,
  TRUSTED_EXPENSE_PLATFORM_ARTIFACTS,
  dependencyFixture,
    pythonArchiveFixture,
  recordFixture,
  sourceFixtures,
  assertCanonicalExpenseWorkbenchAgentMock,
  startManagedStdioProcessMock,
} = vi.hoisted(() => {
  const platformKey = `${process.platform}-${process.arch}`;
  const bridgePath = 'expense_reimbursement/task_agent/stdio_bridge.py';
  const sourceFiles = [
    {
      path: bridgePath,
      content: 'print("bridge")\n',
      bytes: 16,
      sha256: 'be38ae90bf38be2b4d62a652ac271daf25a15214e6663da3d0555ac626e03997',
    },
    {
      path: 'expense_reimbursement/core/session.py',
      content: 'SESSION = "fixture"\n',
      bytes: 20,
      sha256: '62bfdb22e4298b9dc31a555851eebb980f147eea5c7cf6f02e6f0f8ceec5f130',
    },
    {
      path: 'expense_reimbursement/guardrails/deterministic.py',
      content: 'GUARD = "fixture"\n',
      bytes: 18,
      sha256: '2bbe5126a6aa324228c5413876747801773a5635d6055a4ee94e69add6961961',
    },
  ] as const;
  const dependency = {
    path: 'typing_extensions.py',
    content: 'VALUE = "fixture"\n',
  } as const;
  const record = {
    path: 'typing_extensions-4.16.0.dist-info/RECORD',
    content: [
      'typing_extensions.py,sha256=UqPsNBf5I4L80t_4ThTt4MqYYeuVeNejowkw3nVY0FQ,18',
      'typing_extensions-4.16.0.dist-info/RECORD,,',
      '',
    ].join('\n'),
  } as const;
  const pythonArchive = {
    name: `test-python-${platformKey}.tar.gz`,
    bytes: 1,
    sha256: 'a'.repeat(64),
    manifestExecutable: 'python/bin/python3',
  };
  const platformArtifacts = {
    pythonArchive,
    pythonDistributions: Object.freeze([
      Object.freeze({
        distribution: 'typing-extensions',
        version: '4.16.0',
        distInfoDirectory: 'typing_extensions-4.16.0.dist-info',
        recordSha256: 'a312f9e1bb37f35dda5987619648525e68c5d60317c92a64f55840cb77b50d0c',
      }),
    ]),
  };
  return {
    PLATFORM_KEY: platformKey,
    TRUSTED_EXPENSE_BRIDGE_PATH: bridgePath,
    TRUSTED_EXPENSE_COMPONENT_FILES: Object.freeze(sourceFiles.map(({ content: _content, ...file }) => Object.freeze(file))),
    TRUSTED_EXPENSE_PLATFORM_ARTIFACTS: { [platformKey]: platformArtifacts },
    dependencyFixture: dependency,
    pythonArchiveFixture: pythonArchive,
    recordFixture: record,
    sourceFixtures: sourceFiles,
    assertCanonicalExpenseWorkbenchAgentMock: vi.fn(),
    startManagedStdioProcessMock: vi.fn(),
  };
});

vi.mock('../../../src/main/util/managed-stdio-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/util/managed-stdio-process')>();
  return { ...actual, startManagedStdioProcess: startManagedStdioProcessMock };
});

vi.mock('../../../src/main/features/expense_workbench/canonical-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/expense_workbench/canonical-agent')>();
  return { ...actual, assertCanonicalExpenseWorkbenchAgent: assertCanonicalExpenseWorkbenchAgentMock };
});

vi.mock('../../../src/main/features/expense_workbench/trusted-component-manifest', () => ({
  TRUSTED_EXPENSE_COMPONENT_VERSION: 'v1.3.0-rc1',
  TRUSTED_EXPENSE_BRIDGE_PATH,
  TRUSTED_EXPENSE_COMPONENT_FILES,
  TRUSTED_EXPENSE_PLATFORM_ARTIFACTS,
}));

let workspaceRoot: string;
let projectRoot: string;
let runtimeRoot: string;
let previousWorkspaceRoot: string | undefined;
let previousResourcesPath: string | undefined;

function writeFixtureFile(destination: string, content: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function removeFixtureTree(root: string): void {
  if (!fs.existsSync(root)) return;
  const thaw = (entryPath: string): void => {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (process.platform !== 'win32') fs.chmodSync(entryPath, 0o700);
      for (const child of fs.readdirSync(entryPath)) thaw(path.join(entryPath, child));
    } else if (stat.isFile() && process.platform !== 'win32') {
      fs.chmodSync(entryPath, 0o600);
    }
  };
  thaw(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function fixtureSitePackages(): string {
  return process.platform === 'win32'
    ? path.join(projectRoot, '.venv', 'Lib', 'site-packages')
    : path.join(projectRoot, '.venv', 'lib', 'python3.12', 'site-packages');
}

function fixtureProjectInterpreter(): string {
  return process.platform === 'win32'
    ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(projectRoot, '.venv', 'bin', 'python3');
}

function createRuntimeFixture(): void {
  const variantRoot = path.join(runtimeRoot, 'python', PLATFORM_KEY);
  const archiveDirectory = path.join(variantRoot, 'archive');
  const archiveSource = path.join(path.dirname(runtimeRoot), 'python-archive-source');
  const archiveInterpreter = path.join(archiveSource, 'python', 'bin', 'python3.12');
  const archiveStdlib = path.join(archiveSource, 'python', 'lib', 'python3.12', 'os.py');
  fs.mkdirSync(path.dirname(archiveInterpreter), { recursive: true });
  fs.mkdirSync(path.dirname(archiveStdlib), { recursive: true });
  fs.writeFileSync(archiveInterpreter, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('python3.12', path.join(path.dirname(archiveInterpreter), 'python3'));
  fs.writeFileSync(archiveStdlib, 'RUNTIME_STDLIB = True\n');
  fs.mkdirSync(archiveDirectory, { recursive: true });
  const archive = path.join(archiveDirectory, pythonArchiveFixture.name);
  createTar({
    cwd: archiveSource,
    file: archive,
    gzip: true,
    sync: true,
    portable: true,
    noMtime: true,
  }, ['python']);
  const archiveBytes = fs.readFileSync(archive);
  pythonArchiveFixture.bytes = archiveBytes.length;
  pythonArchiveFixture.sha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  const asset = {
    name: pythonArchiveFixture.name,
    sha256: pythonArchiveFixture.sha256,
    size: pythonArchiveFixture.bytes,
    archive: 'tar.gz',
    executable: pythonArchiveFixture.manifestExecutable,
  };
  fs.writeFileSync(path.join(runtimeRoot, 'manifest.json'), JSON.stringify({
    schema: 1,
    python: { version: '3.12.13+test', source: 'test-host', release: 'test', assets: { [PLATFORM_KEY]: asset } },
  }));
  fs.writeFileSync(path.join(runtimeRoot, 'python', PLATFORM_KEY, '.orkas-runtime.json'), JSON.stringify({
    schema: 1,
    kind: 'python',
    platformKey: PLATFORM_KEY,
    version: '3.12.13+test',
    source: 'test-host',
    release: 'test',
    asset: asset.name,
    sha256: asset.sha256,
    size: asset.size,
  }));
}

function createTrustedProjectFixture(): void {
  for (const fixture of sourceFixtures) {
    writeFixtureFile(path.join(projectRoot, 'src', ...fixture.path.split('/')), fixture.content);
  }
  const sitePackages = fixtureSitePackages();
  writeFixtureFile(path.join(sitePackages, ...recordFixture.path.split('/')), recordFixture.content);
  writeFixtureFile(path.join(sitePackages, ...dependencyFixture.path.split('/')), dependencyFixture.content);
}

beforeEach(() => {
  vi.resetModules();
  startManagedStdioProcessMock.mockReset();
  assertCanonicalExpenseWorkbenchAgentMock.mockReset().mockResolvedValue({ agent_id: 'c045605cb916' });
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ew-data-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ew-project-'));
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ew-runtime-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  previousResourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  process.env.ORKAS_WORKSPACE_ROOT = workspaceRoot;
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  const resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ew-resources-'));
  runtimeRoot = path.join(resourcesRoot, 'runtime');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesRoot });
  createRuntimeFixture();
  createTrustedProjectFixture();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: previousResourcesPath });
  removeFixtureTree(workspaceRoot);
  removeFixtureTree(projectRoot);
  removeFixtureTree(path.dirname(runtimeRoot));
});

describe('expense workbench adapter project validation', () => {
  it('isolates Python runtime data and host capabilities under the active Mate user', async () => {
    const paths = await import('../../../../src/main/paths');
    const { buildExpenseWorkbenchEnvironment } = await import('../../../../src/main/features/expense_workbench/adapter');
    const env = buildExpenseWorkbenchEnvironment(projectRoot, 'employee-1');

    expect(env.HOME).toBe(fs.realpathSync(paths.userExpenseWorkbenchHomeDir('employee-1')));
    expect(env.USERPROFILE).toBe(fs.realpathSync(paths.userExpenseWorkbenchHomeDir('employee-1')));
    expect(env.TMPDIR).toBe(fs.realpathSync(paths.userExpenseWorkbenchTempDir('employee-1')));
    expect(env.TEMP).toBe(fs.realpathSync(paths.userExpenseWorkbenchTempDir('employee-1')));
    expect(env.TMP).toBe(fs.realpathSync(paths.userExpenseWorkbenchTempDir('employee-1')));
    expect(fs.realpathSync(paths.userExpenseWorkbenchHomeDir('employee-1'))).toBe(env.HOME);
    expect(path.join(
      env.HOME!,
      '.expense_reimbursement',
      'host-confirmations',
    )).toBe(path.join(
      fs.realpathSync(paths.userExpenseWorkbenchHomeDir('employee-1')),
      '.expense_reimbursement',
      'host-confirmations',
    ));
    expect(env).not.toHaveProperty('LLM_API_KEY');
    expect(env).not.toHaveProperty('FEISHU_APP_SECRET');
    expect(env).not.toHaveProperty('PATH');
    expect(env).not.toHaveProperty('Path');
    expect(env.WORKBENCH_PRINCIPAL_ROLE).toBe('employee');
    expect(env).not.toHaveProperty('WORKBENCH_ROLES');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked private-data parent before creating HOME or TMP', async () => {
    const paths = await import('../../../../src/main/paths');
    const outside = path.join(projectRoot, 'outside-private-data');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.dirname(paths.userLocalRoot('employee-1')), { recursive: true });
    fs.symlinkSync(outside, paths.userLocalRoot('employee-1'), 'dir');
    const { buildExpenseWorkbenchEnvironment } = await import('../../../../src/main/features/expense_workbench/adapter');

    expect(() => buildExpenseWorkbenchEnvironment(projectRoot, 'employee-1')).toThrow('symbolic links');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rechecks a private runtime directory replaced after an earlier safe use', async () => {
    const paths = await import('../../../../src/main/paths');
    const outside = path.join(projectRoot, 'outside-replaced-runtime');
    fs.mkdirSync(outside);
    const { buildExpenseWorkbenchEnvironment } = await import('../../../../src/main/features/expense_workbench/adapter');
    buildExpenseWorkbenchEnvironment(projectRoot, 'employee-1');
    fs.rmSync(paths.userExpenseWorkbenchRuntimeDir('employee-1'), { recursive: true });
    fs.symlinkSync(outside, paths.userExpenseWorkbenchRuntimeDir('employee-1'), 'dir');

    expect(() => buildExpenseWorkbenchEnvironment(projectRoot, 'employee-1')).toThrow('symbolic links');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked trusted-cache parent before copying executable code', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    users.activateUser('employee-1');
    const outside = path.join(projectRoot, 'outside-trusted-cache');
    fs.mkdirSync(outside);
    fs.mkdirSync(paths.userExpenseWorkbenchRuntimeDir('employee-1'), { recursive: true });
    fs.symlinkSync(
      outside,
      path.join(paths.userExpenseWorkbenchRuntimeDir('employee-1'), 'trusted-cache'),
      'dir',
    );
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');

    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('symbolic links');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not load configuration through a symlinked config directory', async () => {
    const paths = await import('../../../../src/main/paths');
    const outside = path.join(projectRoot, 'outside-config-directory');
    fs.mkdirSync(outside);
    fs.writeFileSync(
      path.join(outside, 'expense-workbench.json'),
      JSON.stringify({ version: 1, project_root: projectRoot }),
    );
    fs.mkdirSync(paths.userLocalRoot('employee-1'), { recursive: true });
    fs.symlinkSync(outside, paths.userLocalConfigDir('employee-1'), 'dir');
    const { getExpenseProjectStatus } = await import('../../../../src/main/features/expense_workbench/adapter');

    expect(getExpenseProjectStatus('employee-1')).toEqual({
      configured: false,
      platform: process.platform === 'win32' ? 'windows' : 'posix',
    });
  });

  it.skipIf(process.platform === 'win32')('does not load configuration through a symlinked config file', async () => {
    const paths = await import('../../../../src/main/paths');
    const outside = path.join(projectRoot, 'outside-expense-workbench.json');
    fs.writeFileSync(outside, JSON.stringify({ version: 1, project_root: projectRoot }));
    fs.mkdirSync(paths.userLocalConfigDir('employee-1'), { recursive: true });
    fs.symlinkSync(outside, paths.userExpenseWorkbenchConfigFile('employee-1'));
    const { getExpenseProjectStatus } = await import('../../../../src/main/features/expense_workbench/adapter');

    expect(getExpenseProjectStatus('employee-1')).toEqual({
      configured: false,
      platform: process.platform === 'win32' ? 'windows' : 'posix',
    });
  });

  it('accepts the host-pinned component and never executes the project interpreter', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const marker = path.join(workspaceRoot, 'malicious-python-executed');
    const maliciousPython = fixtureProjectInterpreter();
    fs.mkdirSync(path.dirname(maliciousPython), { recursive: true });
    fs.writeFileSync(maliciousPython, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(maliciousPython, 0o755);
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseProjectRoot(projectRoot)).toBe(fs.realpathSync(projectRoot));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects a packaged Python archive whose bytes no longer match the host-owned identity', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const archive = path.join(runtimeRoot, 'python', PLATFORM_KEY, 'archive', pythonArchiveFixture.name);
    fs.appendFileSync(archive, 'tampered');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');

    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('发布归档');
  });

  it('rejects a packaged Python archive symlink even when its target has approved bytes', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const archive = path.join(runtimeRoot, 'python', PLATFORM_KEY, 'archive', pythonArchiveFixture.name);
    const external = path.join(workspaceRoot, pythonArchiveFixture.name);
    fs.copyFileSync(archive, external);
    fs.unlinkSync(archive);
    fs.symlinkSync(external, archive);
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');

    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('发布归档无效');
  });

  it('unconditionally replaces a pre-existing Python cache on first use in this process', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    const firstUseUserId = 'employee-first-use';
    users.activateUser(firstUseUserId);
    const cacheParent = path.join(paths.userExpenseWorkbenchRuntimeDir(firstUseUserId), 'python-runtime');
    const poison = path.join(cacheParent, 'attacker-selected-cache', 'python', 'lib', 'sitecustomize.py');
    writeFixtureFile(poison, 'raise RuntimeError("executed")\n');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');

    expect(validateExpenseProjectRoot(projectRoot)).toBe(fs.realpathSync(projectRoot));
    expect(fs.existsSync(poison)).toBe(false);
    expect(fs.readdirSync(cacheParent)).toHaveLength(1);
  });

  it('rejects a bridge symlink that escapes the selected project', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const external = path.join(workspaceRoot, 'outside-bridge.py');
    fs.writeFileSync(external, '# outside\n');
    const bridge = path.join(projectRoot, 'src', ...TRUSTED_EXPENSE_BRIDGE_PATH.split('/'));
    fs.unlinkSync(bridge);
    fs.symlinkSync(external, bridge);
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow(TRUSTED_EXPENSE_BRIDGE_PATH);
  });

  it('rejects a missing source file from the transitive executable closure', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const expected = TRUSTED_EXPENSE_COMPONENT_FILES.find(({ path: relative }) => relative.endsWith('core/session.py'))!;
    fs.unlinkSync(path.join(projectRoot, 'src', ...expected.path.split('/')));
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow(expected.path);
  });

  it('rejects a modified bridge even when a project manifest claims its new digest', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const bridge = path.join(projectRoot, 'src', ...TRUSTED_EXPENSE_BRIDGE_PATH.split('/'));
    fs.appendFileSync(bridge, '# unreviewed change\n');
    fs.writeFileSync(path.join(projectRoot, 'src', 'expense_reimbursement', 'task_agent', 'workbench_manifest.json'), JSON.stringify({
      bridge_sha256: 'f'.repeat(64),
    }));
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('不是受信的普通文件');
  });

  it('rejects a modified file from the transitive executable closure', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const expected = TRUSTED_EXPENSE_COMPONENT_FILES.find(({ path: relative }) => relative.endsWith('guardrails/deterministic.py'))!;
    fs.appendFileSync(path.join(projectRoot, 'src', ...expected.path.split('/')), '# injected\n');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('不是受信的普通文件');
  });

  it('rejects a dependency RECORD that is internally consistent but not host-pinned', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const distribution = TRUSTED_EXPENSE_PLATFORM_ARTIFACTS[PLATFORM_KEY].pythonDistributions[0];
    const record = path.join(fixtureSitePackages(), distribution.distInfoDirectory, 'RECORD');
    fs.appendFileSync(record, 'extra.py,sha256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,1\n');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('安装记录不受支持');
  });

  it('rejects a dependency RECORD symlink even when its target is host-pinned', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const distribution = TRUSTED_EXPENSE_PLATFORM_ARTIFACTS[PLATFORM_KEY].pythonDistributions[0];
    const record = path.join(fixtureSitePackages(), distribution.distInfoDirectory, 'RECORD');
    const externalRecord = path.join(workspaceRoot, 'external-record');
    fs.copyFileSync(record, externalRecord);
    fs.unlinkSync(record);
    fs.symlinkSync(externalRecord, record);
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('安装记录');
  });

  it('rejects a package file modified after its host-pinned RECORD', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('employee-1');
    const dependency = path.join(fixtureSitePackages(), dependencyFixture.path);
    fs.appendFileSync(dependency, '# injected\n');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseProjectRoot(projectRoot)).toThrow('依赖文件被修改');
  });

  it('rebuilds a trusted cache containing an unapproved shadow module before reuse', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    users.activateUser('employee-1');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseProjectRoot(projectRoot)).toBe(fs.realpathSync(projectRoot));

    const cacheParent = path.join(paths.userExpenseWorkbenchRuntimeDir('employee-1'), 'trusted-cache');
    const cacheDirectories = fs.readdirSync(cacheParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    expect(cacheDirectories).toHaveLength(1);
    const cacheRoot = path.join(cacheParent, cacheDirectories[0].name);
    const sitePackages = path.join(cacheRoot, 'site-packages');
    if (process.platform !== 'win32') {
      fs.chmodSync(cacheRoot, 0o700);
      fs.chmodSync(sitePackages, 0o700);
    }
    const shadowModule = path.join(sitePackages, 'pydantic.py');
    fs.writeFileSync(shadowModule, 'raise RuntimeError("unapproved shadow module executed")\n');

    expect(validateExpenseProjectRoot(projectRoot)).toBe(fs.realpathSync(projectRoot));
    expect(fs.existsSync(shadowModule)).toBe(false);
  });

  it('rebuilds a trusted cache when a previously verified file is modified', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    users.activateUser('employee-1');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseProjectRoot(projectRoot)).toBe(fs.realpathSync(projectRoot));

    const cacheParent = path.join(paths.userExpenseWorkbenchRuntimeDir('employee-1'), 'trusted-cache');
    const [cacheDirectory] = fs.readdirSync(cacheParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    const cachedBridge = path.join(cacheParent, cacheDirectory.name, 'source', ...TRUSTED_EXPENSE_BRIDGE_PATH.split('/'));
    if (process.platform !== 'win32') fs.chmodSync(cachedBridge, 0o600);
    fs.appendFileSync(cachedBridge, '# cache injection\n');

    expect(validateExpenseProjectRoot(projectRoot)).toBe(fs.realpathSync(projectRoot));
    const expectedBridge = TRUSTED_EXPENSE_COMPONENT_FILES.find(({ path: relative }) => relative === TRUSTED_EXPENSE_BRIDGE_PATH)!;
    expect(fs.statSync(cachedBridge).size).toBe(expectedBridge.bytes);
  });

  it.skipIf(process.platform === 'win32')('keeps executable source and dependency caches read-only', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    users.activateUser('employee-1');
    const { validateExpenseProjectRoot } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseProjectRoot(projectRoot)).toBe(fs.realpathSync(projectRoot));
    const cacheParent = path.join(paths.userExpenseWorkbenchRuntimeDir('employee-1'), 'trusted-cache');
    const [cacheDirectory] = fs.readdirSync(cacheParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    const cacheRoot = path.join(cacheParent, cacheDirectory.name);

    const assertReadOnly = (entryPath: string): void => {
      const stat = fs.lstatSync(entryPath);
      if (!stat.isSymbolicLink()) expect(stat.mode & 0o222, entryPath).toBe(0);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const name of fs.readdirSync(entryPath)) assertReadOnly(path.join(entryPath, name));
      }
    };
    assertReadOnly(cacheRoot);
  });

  it('persists configuration only after manifest, health, and identity handshakes succeed', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    users.activateUser('employee-1');
    const lineListeners: Array<(line: string) => void> = [];
    const writes: Array<Record<string, unknown>> = [];
    startManagedStdioProcessMock.mockReturnValue({
      pid: 123,
      onLine(listener: (line: string) => void) { lineListeners.push(listener); return () => undefined; },
      onStderr() { return () => undefined; },
      onExit() { return () => undefined; },
      async writeLine(line: string) {
        const request = JSON.parse(line) as Record<string, unknown>;
        writes.push(request);
        const operation = request.operation;
        const result = operation === 'manifest'
          ? { protocol_version: 1, component_id: 'expense-precheck', component_version: 'v1.3.0-rc1', operations: [
            'manifest', 'health.get', 'identity.get', 'overview.stats', 'applications.list', 'applications.get',
            'applications.create', 'applications.draft', 'applications.precheck', 'applications.confirm',
            'applications.report', 'materials.list', 'materials.add', 'materials.addAndBind', 'materials.delete',
            'reviews.list', 'audit.list', 'settings.get', 'settings.models', 'assistant.inspect', 'assistant.propose',
          ], data_scope: 'isolated_host_user' }
          : operation === 'health.get'
            ? { status: 'ready', component_version: 'v1.3.0-rc1', checks: { domain_store: 'ready', data_scope: 'isolated_host_user', external_connections: 'unconfigured' } }
            : { role: 'employee', capabilities: [
              'manifest', 'health.get', 'identity.get', 'overview.stats', 'applications.list', 'applications.get',
              'applications.create', 'applications.draft', 'applications.precheck', 'applications.confirm',
              'applications.report', 'materials.list', 'materials.add', 'materials.addAndBind', 'materials.delete',
              'reviews.list', 'audit.list', 'settings.get', 'settings.models', 'assistant.inspect', 'assistant.propose',
            ] };
        queueMicrotask(() => lineListeners[0](JSON.stringify({ request_id: request.request_id, ok: true, result })));
      },
      async close() {},
    });
    const agentId = 'c045605cb916';
    const { configureExpenseProject } = await import('../../../../src/main/features/expense_workbench/adapter');

    await configureExpenseProject('employee-1', projectRoot, agentId);

    expect(writes.map(({ operation }) => operation)).toEqual(['manifest', 'health.get', 'identity.get']);
    const launch = startManagedStdioProcessMock.mock.calls[0][0] as { command: string; args: string[]; cwd: string };
    expect(launch.command).toContain(path.join('expense-workbench', 'python-runtime'));
    expect(launch.command).not.toContain(path.join(projectRoot, '.venv'));
    expect(launch.args.slice(0, 5)).toEqual(['-I', '-S', '-B', '-c', expect.stringContaining('runpy.run_path')]);
    expect(launch.args.join('\n')).not.toContain(projectRoot);
    expect(launch.cwd).toContain(path.join('expense-workbench', 'trusted-cache'));
    expect(JSON.parse(fs.readFileSync(paths.userExpenseWorkbenchConfigFile('employee-1'), 'utf8')))
      .toEqual({ version: 1, project_root: fs.realpathSync(projectRoot) });
  });
});

describe('expense workbench JSONL limits', () => {
  it('serializes ASCII and multibyte payloads using compact UTF-8 JSON', async () => {
    const { serializeExpenseWorkbenchRequest } = await import('../../../../src/main/features/expense_workbench/adapter');
    const request = serializeExpenseWorkbenchRequest(
      'request-1',
      'applications.draft',
      'employee-1',
      { ascii: 'receipt', chinese: '报销' },
    );

    expect(request).toBe('{"request_id":"request-1","operation":"applications.draft","user_id":"employee-1","payload":{"ascii":"receipt","chinese":"报销"}}');
    expect(Buffer.byteLength(request, 'utf8')).toBeGreaterThan(request.length);
  });

  it('accepts the exact 256 KiB payload boundary for ASCII and rejects one byte over', async () => {
    const {
      MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES,
      serializeExpenseWorkbenchRequest,
    } = await import('../../../../src/main/features/expense_workbench/adapter');
    const jsonOverhead = Buffer.byteLength('{"value":""}', 'utf8');
    const exactValue = 'a'.repeat(MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES - jsonOverhead);

    expect(() => serializeExpenseWorkbenchRequest(
      'request-2',
      'applications.draft',
      'employee-1',
      { value: exactValue },
    )).not.toThrow();
    expect(() => serializeExpenseWorkbenchRequest(
      'request-3',
      'applications.draft',
      'employee-1',
      { value: `${exactValue}a` },
    )).toThrow(`payload exceeds ${MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES} bytes`);
  });

  it('enforces the 256 KiB payload boundary by UTF-8 bytes', async () => {
    const {
      MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES,
      serializeExpenseWorkbenchRequest,
    } = await import('../../../../src/main/features/expense_workbench/adapter');
    const jsonOverhead = Buffer.byteLength('{"value":""}', 'utf8');
    const availableBytes = MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES - jsonOverhead;
    const exactValue = '报'.repeat(Math.floor(availableBytes / 3)) + 'a'.repeat(availableBytes % 3);

    expect(Buffer.byteLength(JSON.stringify({ value: exactValue }), 'utf8'))
      .toBe(MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES);
    expect(() => serializeExpenseWorkbenchRequest(
      'request-4',
      'applications.draft',
      'employee-1',
      { value: exactValue },
    )).not.toThrow();
    expect(() => serializeExpenseWorkbenchRequest(
      'request-5',
      'applications.draft',
      'employee-1',
      { value: `${exactValue}a` },
    )).toThrow(`payload exceeds ${MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES} bytes`);
  });

  it('accepts the exact 512 KiB JSONL boundary and rejects one byte over', async () => {
    const {
      MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES,
      serializeExpenseWorkbenchRequest,
    } = await import('../../../../src/main/features/expense_workbench/adapter');
    const emptyEnvelope = serializeExpenseWorkbenchRequest('', 'manifest', '', {});
    const exactRequestId = 'r'.repeat(
      MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES - Buffer.byteLength(emptyEnvelope, 'utf8'),
    );

    const exact = serializeExpenseWorkbenchRequest(exactRequestId, 'manifest', '', {});
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES);
    expect(() => serializeExpenseWorkbenchRequest(`${exactRequestId}r`, 'manifest', '', {}))
      .toThrow(`request line exceeds ${MAX_EXPENSE_WORKBENCH_REQUEST_LINE_BYTES} bytes`);
  });

  it('rejects non-serializable payloads with contextual error chaining', async () => {
    const { serializeExpenseWorkbenchRequest } = await import('../../../../src/main/features/expense_workbench/adapter');
    const payload: JsonObject = {};
    payload.self = payload;

    let thrown: Error | undefined;
    try {
      serializeExpenseWorkbenchRequest('request-6', 'manifest', 'employee-1', payload);
    } catch (error) {
      thrown = error instanceof Error ? error : undefined;
    }
    expect(thrown?.message).toBe('expense bridge payload is not JSON serializable');
    expect(thrown?.cause).toBeInstanceOf(TypeError);
  });

  it('rejects oversized and non-serializable requests before starting the bridge process', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    users.activateUser('employee-1');
    const {
      MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES,
      callExpenseWorkbench,
    } = await import('../../../../src/main/features/expense_workbench/adapter');
    fs.mkdirSync(path.dirname(paths.userExpenseWorkbenchConfigFile('employee-1')), { recursive: true });
    fs.writeFileSync(paths.userExpenseWorkbenchConfigFile('employee-1'), JSON.stringify({
      version: 1,
      project_root: projectRoot,
    }));
    const agentId = 'c045605cb916';

    await expect(callExpenseWorkbench(
      'employee-1',
      agentId,
      'applications.draft',
      { value: 'a'.repeat(MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES) },
    )).rejects.toThrow(`payload exceeds ${MAX_EXPENSE_WORKBENCH_PAYLOAD_BYTES} bytes`);

    const circularPayload: JsonObject = {};
    circularPayload.self = circularPayload;
    await expect(callExpenseWorkbench(
      'employee-1',
      agentId,
      'applications.draft',
      circularPayload,
    )).rejects.toThrow('expense bridge payload is not JSON serializable');
    expect(startManagedStdioProcessMock).not.toHaveBeenCalled();
  });
});

describe('expense workbench response boundary', () => {
  it('requires an exact success or failure envelope and bounded error fields', async () => {
    const { parseExpenseWorkbenchResponse } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(parseExpenseWorkbenchResponse(JSON.stringify({
      request_id: 'request-1', ok: true, result: {},
    }))).toEqual({ request_id: 'request-1', ok: true, result: {} });
    expect(parseExpenseWorkbenchResponse(JSON.stringify({
      request_id: 'request-2', ok: false,
      error: { code: 'E_INVALID_REQUEST', message: 'invalid', retryable: false },
    }))).toEqual({
      request_id: 'request-2', ok: false,
      error: { code: 'E_INVALID_REQUEST', message: 'invalid', retryable: false },
    });
    expect(parseExpenseWorkbenchResponse(JSON.stringify({
      request_id: 'request-python-1', ok: false,
      error: { code: 'internal_error', message: 'operation failed', retryable: true },
    }))).toEqual({
      request_id: 'request-python-1', ok: false,
      error: { code: 'internal_error', message: 'operation failed', retryable: true },
    });

    const invalidEnvelopes = [
      { request_id: 'request-3', ok: true, result: {}, error: { code: 'E_BAD', message: 'bad', retryable: false } },
      { request_id: 'request-4', ok: false, result: {}, error: { code: 'E_BAD', message: 'bad', retryable: false } },
      { request_id: 'request-5', ok: true, result: {}, extra: true },
      { request_id: 'request-6', ok: false, error: { code: 'bad-code', message: 'bad', retryable: false } },
      { request_id: 'request-7', ok: false, error: { code: 'E_BAD', message: 'x'.repeat(4_001), retryable: false } },
      { request_id: 'request-8', ok: false, error: { code: 'E_BAD', message: 'bad', retryable: false, extra: true } },
    ];
    for (const envelope of invalidEnvelopes) {
      expect(() => parseExpenseWorkbenchResponse(JSON.stringify(envelope))).toThrow();
    }
  });

  it('accepts only the operation-specific top-level response fields', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseWorkbenchResult('overview.stats', {
      total_applications: 2,
      status_counts: { draft: 2 },
    })).toEqual({ total_applications: 2, status_counts: { draft: 2 } });
    expect(() => validateExpenseWorkbenchResult('overview.stats', {
      total_applications: 2,
      status_counts: {},
      ok: true,
    })).toThrow('schema');
  });

  it('accepts the live application projection fields used after external submission', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    const timestamp = '2026-08-04T00:00:00+00:00';
    expect(validateExpenseWorkbenchResult('applications.list', {
      applications: [{
        schema_version: 1,
        application_id: 'APP-1',
        application_type: 'daily_expense',
        application_type_label: '日常费用报销',
        status: 'submitted',
        current_version: 2,
        current_payload_hash: 'a'.repeat(64),
        external_application_id: 'instance-1',
        precheck_status: 'ready_for_confirmation',
        confirmation_status: 'confirmed',
        oa_status: 'submitted',
        feishu_status: 'synced',
        target: {
          system: 'oa', environment: 'feishu', adapter: 'feishu-approval',
          form_type: 'approval.v4', mapping_version: 'feishu-expense-v1',
        },
        submission_gate: { status: 'passed' },
        formal_report_gate: { status: 'passed' },
        created_at: timestamp,
        updated_at: timestamp,
      }],
    })).toMatchObject({ applications: [{ external_application_id: 'instance-1', oa_status: 'submitted' }] });
  });

  it('accepts Unicode approval roles and explicitly blocked formal reports', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(validateExpenseWorkbenchResult('applications.approve', {
      approval_id: 'APR-1', application_id: 'APP-1', application_version: 1,
      approval_role: '直属经理', status: 'approved', decision: 'approve',
      acted_at: '2026-08-04T00:00:00+00:00', subject_hash: 'a'.repeat(64),
      artifact_hash: 'b'.repeat(64), bundle_hash: 'c'.repeat(64),
    })).toMatchObject({ approval_role: '直属经理', status: 'approved' });
    expect(validateExpenseWorkbenchResult('applications.report', {
      status: 'formal_report_blocked', application_id: 'APP-1', version: 1,
      report: { error_code: 'formal_report_blocked', message: 'approval.missing' },
    })).toMatchObject({ status: 'formal_report_blocked' });
  });

  it('rejects unknown and mistyped fields at nested operation-specific locations', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseWorkbenchResult('materials.add', {
      material: {
        ref: `workspace://mat-${'a'.repeat(32)}`,
        name: 'receipt.pdf', media_type: 'application/pdf', size: '4', sha256: 'b'.repeat(64),
        material_category: 'expense_receipt', extra: true,
      },
    })).toThrow('schema');
  });

  it('rejects duplicate or excessive advertised capabilities and malformed timestamps', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseWorkbenchResult('identity.get', {
      role: 'employee', capabilities: ['manifest', 'manifest'],
    })).toThrow('schema');
    expect(() => validateExpenseWorkbenchResult('identity.get', {
      role: 'employee', capabilities: Array.from({ length: 33 }, () => 'manifest'),
    })).toThrow('schema');
    expect(() => validateExpenseWorkbenchResult('audit.list', {
      total: 1,
      logs: [{ session_id: 'APP-1', action: 'created', created_at: '2026-08-03 00:00:00' }],
    })).toThrow('schema');
    expect(() => validateExpenseWorkbenchResult('reviews.list', {
      total: 1,
      reviews: [{
        task_id: 'hitl-20260803-aaaaaaaa', application_id: 'APP-1', status: 'approved',
        reviewed_at: '2026-08-03T00:00:00',
      }],
    })).toThrow('schema');
  });

  it.each([
    ['user_id', 'employee-1'],
    ['project_root', '/private/project'],
    ['data_base64', 'YWJj'],
    ['host_capability_id', 'hcap-secret'],
  ] as const)('rejects private nested field %s', async (field, value) => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseWorkbenchResult('applications.get', {
      application: { application_id: 'APP-1', [field]: value },
    })).toThrow('private');
  });

  it('rejects absolute path values even under an innocuous field name', async () => {
    const { validateExpenseWorkbenchResult } = await import('../../../../src/main/features/expense_workbench/adapter');
    expect(() => validateExpenseWorkbenchResult('assistant.inspect', {
      message: '/Users/example/private.pdf',
    })).toThrow('private path');
  });
});
