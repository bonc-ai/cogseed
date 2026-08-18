import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const requireMigration = () => require(path.join(root, 'src/main/util/migrate-runtime-variant-data.cjs')) as {
  migrateRuntimeVariantData(input: {
    sourceContainer: string;
    destinationContainer: string;
    sourceVariant: string;
  }): { migrated: boolean; sourceUserIds: string[]; activeUserId?: string };
};

describe('source runtime variant data migration', () => {
  it('preserves the legacy user tree and activates it for the renamed source runtime', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-variant-migration-'));
    const sourceContainer = path.join(tmp, 'runtime-variants', 'mate');
    const destinationContainer = path.join(tmp, 'runtime-variants', 'cogseed');
    const legacyUid = '02570566';
    const newUid = '68127190';

    fs.mkdirSync(path.join(sourceContainer, 'data', legacyUid, 'cloud', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(sourceContainer, 'data', legacyUid, 'cloud', 'chats', 'legacy.jsonl'), '{"id":"legacy"}\n');
    fs.writeFileSync(path.join(sourceContainer, 'data', 'users.json'), JSON.stringify({
      current_user_id: legacyUid,
      dev_current_user_id: legacyUid,
      users: [{ user_id: legacyUid, created_at: '2026-08-04T10:16:10Z' }],
    }, null, 2));

    fs.mkdirSync(path.join(destinationContainer, 'data', newUid, 'cloud', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(destinationContainer, 'data', newUid, 'cloud', 'chats', 'new.jsonl'), '{"id":"new"}\n');
    fs.writeFileSync(path.join(destinationContainer, 'data', 'users.json'), JSON.stringify({
      current_user_id: newUid,
      dev_current_user_id: newUid,
      users: [{ user_id: newUid, created_at: '2026-08-17T17:42:23Z' }],
    }, null, 2));

    const migration = requireMigration();
    const result = migration.migrateRuntimeVariantData({
      sourceContainer,
      destinationContainer,
      sourceVariant: 'mate',
    });

    expect(result).toMatchObject({ migrated: true, sourceUserIds: [legacyUid], activeUserId: legacyUid });
    expect(fs.existsSync(path.join(sourceContainer, 'data', legacyUid, 'cloud', 'chats', 'legacy.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(destinationContainer, 'data', legacyUid, 'cloud', 'chats', 'legacy.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(destinationContainer, 'data', newUid, 'cloud', 'chats', 'new.jsonl'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(destinationContainer, 'data', 'users.json'), 'utf8'))).toMatchObject({
      current_user_id: newUid,
      dev_current_user_id: legacyUid,
      users: expect.arrayContaining([
        expect.objectContaining({ user_id: legacyUid }),
        expect.objectContaining({ user_id: newUid }),
      ]),
    });
  });
});
