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
    // 成功迁移后：最终标记存在，进行中标记被清理（下次启动不再重复迁移）。
    expect(fs.existsSync(path.join(destinationContainer, '.migrated-runtime-variant-data.json'))).toBe(true);
    expect(fs.existsSync(path.join(destinationContainer, '.migrating-runtime-variant-data.json'))).toBe(false);
  });

  it('resumes a half-finished migration (in-progress marker) by merging missing files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-variant-resume-'));
    const sourceContainer = path.join(tmp, 'runtime-variants', 'mate');
    const destinationContainer = path.join(tmp, 'runtime-variants', 'cogseed');
    const legacyUid = '02570566';

    // 源侧两个用户：uid A 上次已拷过（含旧文件），uid B 尚未拷。
    const uidA = legacyUid;
    const uidB = '88123456';
    fs.mkdirSync(path.join(sourceContainer, 'data', uidA, 'cloud', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(sourceContainer, 'data', uidA, 'cloud', 'chats', 'a-old.jsonl'), '{"id":"a-old"}\n');
    fs.writeFileSync(path.join(sourceContainer, 'data', uidA, 'cloud', 'chats', 'a-new.jsonl'), '{"id":"a-new"}\n');
    fs.mkdirSync(path.join(sourceContainer, 'data', uidB, 'cloud', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(sourceContainer, 'data', uidB, 'cloud', 'chats', 'b.jsonl'), '{"id":"b"}\n');
    fs.writeFileSync(path.join(sourceContainer, 'data', 'users.json'), JSON.stringify({
      current_user_id: uidA,
      dev_current_user_id: uidA,
      users: [
        { user_id: uidA, created_at: '2026-08-04T10:16:10Z' },
        { user_id: uidB, created_at: '2026-08-05T10:16:10Z' },
      ],
    }, null, 2));

    // 模拟上次中断：目标已有 uid A 的部分数据 + 残留进行中标记。
    fs.mkdirSync(path.join(destinationContainer, 'data', uidA, 'cloud', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(destinationContainer, 'data', uidA, 'cloud', 'chats', 'a-old.jsonl'), '{"id":"a-old"}\n');
    fs.writeFileSync(path.join(destinationContainer, '.migrating-runtime-variant-data.json'), JSON.stringify({
      migration: 'runtime-variant-data', source_variant: 'mate', pid: 99999, started_at: new Date().toISOString(),
    }));

    const migration = requireMigration();
    const result = migration.migrateRuntimeVariantData({
      sourceContainer,
      destinationContainer,
      sourceVariant: 'mate',
    });

    expect(result).toMatchObject({ migrated: true, sourceUserIds: [uidA, uidB] });
    // uid A：已有文件保留，缺失文件被补上（合并续传，不整树覆盖）。
    expect(fs.readFileSync(path.join(destinationContainer, 'data', uidA, 'cloud', 'chats', 'a-old.jsonl'), 'utf8')).toBe('{"id":"a-old"}\n');
    expect(fs.readFileSync(path.join(destinationContainer, 'data', uidA, 'cloud', 'chats', 'a-new.jsonl'), 'utf8')).toBe('{"id":"a-new"}\n');
    // uid B：整树拷入。
    expect(fs.readFileSync(path.join(destinationContainer, 'data', uidB, 'cloud', 'chats', 'b.jsonl'), 'utf8')).toBe('{"id":"b"}\n');
    // 续传完成后两个标记状态正确。
    expect(fs.existsSync(path.join(destinationContainer, '.migrated-runtime-variant-data.json'))).toBe(true);
    expect(fs.existsSync(path.join(destinationContainer, '.migrating-runtime-variant-data.json'))).toBe(false);
    // 已迁移：再次调用是幂等 no-op。
    const second = migration.migrateRuntimeVariantData({
      sourceContainer,
      destinationContainer,
      sourceVariant: 'mate',
    });
    expect(second.migrated).toBe(false);
  });
});
