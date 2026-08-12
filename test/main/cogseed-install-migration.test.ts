import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

async function loadMigration() {
  return import('../../../src/main/cogseed-install-migration.cjs');
}

describe('CogSeed legacy data-root migration', () => {
  it('mounts the identity contract and migration before tsx in bootstrap', () => {
    const bootstrap = read('bootstrap.cjs');
    const pkg = JSON.parse(read('package.json')) as { main?: string };

    expect(pkg.main).toBe('bootstrap.cjs');
    expect(bootstrap).toContain("require('./src/main/identity-contract.cjs')");
    expect(bootstrap).toContain("require('./src/main/cogseed-install-migration.cjs')");
    expect(bootstrap.indexOf('cogseed-install-migration')).toBeLessThan(bootstrap.indexOf("require('tsx/cjs')"));
  });

  it('resolves canonical and legacy install containers from identity inputs', async () => {
    const migration = await loadMigration();

    expect(migration.resolveCanonicalContainer({ platform: 'darwin', home: '/Users/alice', env: {} }))
      .toBe(path.join('/Users/alice', '.cogseed'));
    expect(migration.resolveCanonicalContainer({ platform: 'linux', home: '/home/alice', env: {} }))
      .toBe(path.join('/home/alice', '.cogseed'));
    expect(migration.resolveCanonicalContainer({ platform: 'win32', localAppData: 'C:/Users/Alice/AppData/Local', env: {} }))
      .toBe(path.win32.join('C:\\', '.cogseed'));
    expect(migration.resolveLegacyContainer({ platform: 'darwin', home: '/Users/alice', env: {} }))
      .toBe(path.join('/Users/alice', '.orkas'));
    expect(migration.resolveLegacyContainer({ platform: 'darwin', home: '/Users/alice', env: { COGSEED_BUILD_CHANNEL: 'packaged-dev' } }))
      .toBe(path.join('/Users/alice', '.orkas-dev'));
  });

  it('copies and verifies a canonical migration without deleting the source root', async () => {
    const migration = await loadMigration();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-migrate-'));
    const source = path.join(tmp, '.orkas');
    const destination = path.join(tmp, '.cogseed');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'note.txt'), 'hello');
    fs.writeFileSync(path.join(source, 'users.json'), JSON.stringify({ users: [] }));

    const result = migration.copyAndVerifyMigration({
      sourceRoot: source,
      destinationRoot: destination,
      progress: () => {},
    });

    expect(result.fileCount).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(source, 'nested', 'note.txt'))).toBe(true);
    expect(fs.existsSync(path.join(destination, 'nested', 'note.txt'))).toBe(true);
    expect(fs.existsSync(path.join(destination, '.migrate.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(destination, '.migrate.json'), 'utf8'))).toMatchObject({
      migration: 'legacy-orkas-to-cogseed',
      source_kind: 'orkas',
      legacy_root_retained: true,
    });
  });


  it('skips volatile Electron userData while copying legacy roots', async () => {
    const migration = await loadMigration();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-volatile-'));
    const source = path.join(tmp, '.orkas');
    const destination = path.join(tmp, '.cogseed');
    const volatileDir = path.join(source, 'electron-user-data');
    fs.mkdirSync(volatileDir, { recursive: true });
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    fs.writeFileSync(path.join(source, 'data', 'users.json'), JSON.stringify({ users: [] }));
    fs.writeFileSync(path.join(volatileDir, 'SingletonCookie'), 'ephemeral');

    const fsImpl = {
      ...fs,
      readdirSync(current: fs.PathLike) {
        const names = fs.readdirSync(current as fs.PathLike);
        if (String(current) === volatileDir) {
          fs.rmSync(path.join(volatileDir, 'SingletonCookie'), { force: true });
        }
        return names;
      },
    };

    expect(() => migration.copyAndVerifyMigration({
      sourceRoot: source,
      destinationRoot: destination,
      progress: () => {},
      fsImpl,
    })).not.toThrow();
    expect(fs.existsSync(path.join(destination, 'data', 'users.json'))).toBe(true);
    expect(fs.existsSync(path.join(destination, 'electron-user-data'))).toBe(false);
  });

  it('plans conflicts when both roots exist without a marker', async () => {
    const migration = await loadMigration();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-plan-'));
    const canonicalRoot = path.join(tmp, '.cogseed');
    const legacyRoot = path.join(tmp, '.orkas');
    fs.mkdirSync(canonicalRoot, { recursive: true });
    fs.mkdirSync(legacyRoot, { recursive: true });
    const plan = migration.planMigration({
      canonicalRoot,
      legacyRoot,
      markerPath: path.join(canonicalRoot, '.migrate.json'),
    });
    expect(plan.kind).toBe('conflict');
  });
});
