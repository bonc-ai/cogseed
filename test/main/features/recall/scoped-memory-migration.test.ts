import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 标题闸门（设计 3.2）后晋升链对不合规 summary 走 LLM 起标题；本文件走的是
// 内生写入路径（summary＝正文首句/模板拼接），单测无模型，mock 出确定性
// 合规标题（与 asset-title-suggestion.test.ts 同一边界口径）。
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async () => ({ title: '模型重起的样本标题' }),
}))

vi.mock('../../../../src/main/features/kb_embed', () => ({
  closeEmbedder: vi.fn(),
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, index) => (digest[index % 32] / 255 - 0.5) * 0.2);
  },
}));

const USER_ID = 'scoped-memory-migration';
const AGENT_ID = 'migration-agent';
const PROJECT_ID = 'migration-project';
let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-scoped-memory-migration-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = workspaceRoot;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

async function setupSources() {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(USER_ID);
  const paths = await import('../../../../src/main/paths');
  const spaces = await import('../../../../src/main/features/spaces');

  const agentMetaPath = path.join(paths.userAgentsDir(USER_ID), AGENT_ID, 'agent.json');
  fs.mkdirSync(path.dirname(agentMetaPath), { recursive: true });
  fs.writeFileSync(agentMetaPath, JSON.stringify({ id: AGENT_ID, name: '迁移 Agent' }), 'utf8');

  const agentCanonicalPath = paths.agentMemoryFile(USER_ID, AGENT_ID);
  const agentLegacyPath = paths.userAgentMemoryFile(USER_ID, AGENT_ID);
  const spaceResult = await spaces.createSpace(USER_ID, { name: '迁移 Space' });
  if (!spaceResult.ok) throw new Error(`failed to create test Space: ${spaceResult.error}`);
  const spaceId = spaceResult.space.space_id;
  const spacePath = paths.spaceMemoryFile(USER_ID, spaceId);
  const projectMetaPath = paths.projectMetaFile(USER_ID, PROJECT_ID);
  const projectPath = paths.projectMemoryFile(USER_ID, PROJECT_ID);

  for (const file of [agentCanonicalPath, agentLegacyPath, spacePath, projectMetaPath, projectPath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(projectMetaPath, JSON.stringify({ id: PROJECT_ID, name: '旧 Project', space_id: spaceId }), 'utf8');

  return {
    paths,
    spaceId,
    agentCanonicalPath,
    agentLegacyPath,
    spacePath,
    projectMetaPath,
    projectPath,
  };
}

async function migrationModule() {
  return import('../../../../src/main/features/recall/scoped-memory-migration');
}

describe('scoped legacy memory migration', () => {
  it('previews Agent, Space and Project sources without changing bytes or merging across scope owners', async () => {
    const files = await setupSources();
    fs.writeFileSync(files.agentCanonicalPath, '同一 Agent 记忆。\n§\n保留 canonical 记录。', 'utf8');
    fs.writeFileSync(files.agentLegacyPath, '同一 Agent 记忆。\n§\n保留 legacy 记录。', 'utf8');
    fs.writeFileSync(files.spacePath, 'Space 专属记忆。\n§\n保留 Space 记录。', 'utf8');
    fs.writeFileSync(files.projectPath, 'Project 专属记忆。\n§\n保留 Project 记录。', 'utf8');
    const before = [files.agentCanonicalPath, files.agentLegacyPath, files.spacePath, files.projectPath]
      .map((file) => fs.readFileSync(file));

    const preview = await (await migrationModule()).previewLegacyScopedMemoryMigration(USER_ID);

    const agentItem = preview.items.find((item) => item.kind === 'agent' && item.id === AGENT_ID && item.text === '同一 Agent 记忆。');
    expect(agentItem).toMatchObject({ occurrences: 2, scopePolicy: { agentIds: [AGENT_ID] } });
    expect(agentItem?.sourceKeys).toEqual([
      `agent:${AGENT_ID}:canonical`,
      `agent:${AGENT_ID}:legacy`,
    ]);
    expect(preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'space', id: files.spaceId, text: 'Space 专属记忆。', scopePolicy: { workspaceIds: [files.spaceId] } }),
      expect.objectContaining({
        kind: 'project', id: PROJECT_ID, text: 'Project 专属记忆。',
        scopePolicy: { workspaceIds: [files.spaceId], projectIds: [PROJECT_ID] },
        spaceId: files.spaceId,
      }),
    ]));
    expect(preview.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: `agent:${AGENT_ID}:canonical`, status: 'ready', eligibleRecords: 2 }),
      expect.objectContaining({ sourceKey: `space:${files.spaceId}:canonical`, status: 'ready' }),
      expect.objectContaining({ sourceKey: `project:${PROJECT_ID}:legacy`, runtimeVisibility: 'shadowed' }),
    ]));
    expect([files.agentCanonicalPath, files.agentLegacyPath, files.spacePath, files.projectPath]
      .map((file) => fs.readFileSync(file))).toEqual(before);
  });

  it('backs up every selected source, preserves unselected text, and migrates each entry with its exact scope and evidence', async () => {
    const files = await setupSources();
    fs.writeFileSync(files.agentCanonicalPath, '迁移 Agent 内容。\n§\n保留 canonical 内容。', 'utf8');
    fs.writeFileSync(files.agentLegacyPath, '迁移 Agent 内容。\n§\n保留 legacy 内容。', 'utf8');
    fs.writeFileSync(files.spacePath, '迁移 Space 内容。\n§\n保留 Space 内容。', 'utf8');
    fs.writeFileSync(files.projectPath, '迁移 Project 内容。\n§\n保留 Project 内容。', 'utf8');
    const migration = await migrationModule();
    const preview = await migration.previewLegacyScopedMemoryMigration(USER_ID);
    const selectedEntries = preview.items.filter((item) => item.text.startsWith('迁移 '));
    const report = await migration.migrateLegacyScopedMemoryToAssets(USER_ID, {
      selectedEntries,
      expectedFingerprints: preview.fingerprints,
    });

    expect(report).toMatchObject({ selected: 3, migrated: 4, pendingReview: 0, failed: 0, backupFailed: false, cleanupFailedFiles: 0 });
    expect(report.backupDir).toBeTruthy();
    const manifest = JSON.parse(fs.readFileSync(path.join(report.backupDir!, 'manifest.json'), 'utf8'));
    expect(manifest.sources).toHaveLength(4);
    const expectedBackups = new Map([
      [`agent:${AGENT_ID}:canonical`, { file: files.agentCanonicalPath, text: '迁移 Agent 内容。\n§\n保留 canonical 内容。' }],
      [`agent:${AGENT_ID}:legacy`, { file: files.agentLegacyPath, text: '迁移 Agent 内容。\n§\n保留 legacy 内容。' }],
      [`space:${files.spaceId}:canonical`, { file: files.spacePath, text: '迁移 Space 内容。\n§\n保留 Space 内容。' }],
      [`project:${PROJECT_ID}:legacy`, { file: files.projectPath, text: '迁移 Project 内容。\n§\n保留 Project 内容。' }],
    ]);
    expect(manifest.sources.map((source: { sourceKey: string }) => source.sourceKey).sort())
      .toEqual([...expectedBackups.keys()].sort());
    for (const source of manifest.sources as Array<{ sourceKey: string; backupFile: string }>) {
      const expected = expectedBackups.get(source.sourceKey);
      expect(expected).toBeDefined();
      expect(fs.readFileSync(path.join(report.backupDir!, source.backupFile))).toEqual(Buffer.from(expected!.text));
    }
    for (const [index, file] of [files.agentCanonicalPath, files.agentLegacyPath, files.spacePath, files.projectPath].entries()) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain(index < 2 ? '迁移 Agent 内容。' : index === 2 ? '迁移 Space 内容。' : '迁移 Project 内容。');
    }
    expect(fs.readFileSync(files.agentCanonicalPath, 'utf8')).toContain('保留 canonical 内容。');
    expect(fs.readFileSync(files.agentLegacyPath, 'utf8')).toContain('保留 legacy 内容。');

    const assets = await import('../../../../src/main/features/recall/asset-service');
    const migrated = await assets.listAbilityAssets(USER_ID);
    expect(migrated.find((asset) => asset.statement === '迁移 Agent 内容。')).toMatchObject({
      type: 'personal',
      status: 'active',
      scopePolicy: { agentIds: [AGENT_ID] },
    });
    expect(migrated.find((asset) => asset.statement === '迁移 Space 内容。')).toMatchObject({
      type: 'personal',
      status: 'active',
      scopePolicy: { workspaceIds: [files.spaceId] },
    });
    expect(migrated.find((asset) => asset.statement === '迁移 Project 内容。')).toMatchObject({
      type: 'personal',
      status: 'active',
      scopePolicy: { workspaceIds: [files.spaceId], projectIds: [PROJECT_ID] },
    });
    const agentAsset = migrated.find((asset) => asset.statement === '迁移 Agent 内容。');
    expect(agentAsset?.evidenceRefs.filter((ref) => ref.kind === 'memory')).toHaveLength(2);
    expect(agentAsset?.version).toBe('1');
    expect((await migration.previewLegacyScopedMemoryMigration(USER_ID)).items.map((item) => item.text))
      .not.toContain('迁移 Agent 内容。');
  });

  it('keeps the original source and exposes the pending candidate when migration needs review', async () => {
    vi.doMock('../../../../src/main/features/recall/candidate-service', () => ({
      ingestLegacyMemoryKnowledge: async () => ({ mode: 'pending-review', candidateId: 'candidate-held-for-review' }),
    }));
    try {
      const files = await setupSources();
      fs.writeFileSync(files.agentCanonicalPath, '需要人工判断的 Agent 记忆。', 'utf8');
      const original = fs.readFileSync(files.agentCanonicalPath);
      const migration = await migrationModule();
      const preview = await migration.previewLegacyScopedMemoryMigration(USER_ID);
      const selection = preview.items.filter((item) => item.text === '需要人工判断的 Agent 记忆。');

      const report = await migration.migrateLegacyScopedMemoryToAssets(USER_ID, {
        selectedEntries: selection,
        expectedFingerprints: preview.fingerprints,
      });

      expect(report).toMatchObject({ migrated: 0, pendingReview: 1, pendingCandidateIds: ['candidate-held-for-review'] });
      expect(fs.readFileSync(files.agentCanonicalPath)).toEqual(original);
    } finally {
      vi.doUnmock('../../../../src/main/features/recall/candidate-service');
      vi.resetModules();
    }
  });

  it('does not ingest or clean any source when the byte-exact backup cannot be verified', async () => {
    const files = await setupSources();
    fs.writeFileSync(files.agentCanonicalPath, '备份失败时仍须保留的记忆。', 'utf8');
    const original = fs.readFileSync(files.agentCanonicalPath);
    const migration = await migrationModule();
    const preview = await migration.previewLegacyScopedMemoryMigration(USER_ID);
    const selection = preview.items.filter((item) => item.text === '备份失败时仍须保留的记忆。');
    const ingestLegacyMemoryKnowledge = vi.fn(async () => ({ mode: 'created' as const, assetId: 'asset-should-not-exist' }));

    vi.doMock('../../../../src/main/storage', async () => {
      const actual = await vi.importActual<typeof import('../../../../src/main/storage')>('../../../../src/main/storage');
      return {
        ...actual,
        writeTextAtomicSync: (target: string, contents: string | Buffer) => {
          if (String(target).includes('scoped-memory-backup-')) throw new Error('backup denied');
          return actual.writeTextAtomicSync(target, contents);
        },
      };
    });
    vi.doMock('../../../../src/main/features/recall/candidate-service', () => ({ ingestLegacyMemoryKnowledge }));
    try {
      vi.resetModules();
      const freshMigration = await migrationModule();
      const report = await freshMigration.migrateLegacyScopedMemoryToAssets(USER_ID, {
        selectedEntries: selection,
        expectedFingerprints: preview.fingerprints,
      });

      expect(report).toMatchObject({ backupFailed: true, migrated: 0, failed: 1 });
      expect(ingestLegacyMemoryKnowledge).not.toHaveBeenCalled();
      expect(fs.readFileSync(files.agentCanonicalPath)).toEqual(original);
    } finally {
      vi.doUnmock('../../../../src/main/storage');
      vi.doUnmock('../../../../src/main/features/recall/candidate-service');
      vi.resetModules();
    }
  });

  it('rejects stale source bytes without cleaning or ingesting the old preview selection', async () => {
    const files = await setupSources();
    fs.writeFileSync(files.agentCanonicalPath, '预览时存在的记忆。', 'utf8');
    const migration = await migrationModule();
    const preview = await migration.previewLegacyScopedMemoryMigration(USER_ID);
    const selection = preview.items.filter((item) => item.text === '预览时存在的记忆。');
    fs.writeFileSync(files.agentCanonicalPath, '预览后新增的记忆。\n§\n预览时存在的记忆。', 'utf8');
    const changed = fs.readFileSync(files.agentCanonicalPath);

    const report = await migration.migrateLegacyScopedMemoryToAssets(USER_ID, {
      selectedEntries: selection,
      expectedFingerprints: preview.fingerprints,
    });

    expect(report).toMatchObject({ migrated: 0, sourceChangedFiles: 1, staleSelections: 1 });
    expect(fs.readFileSync(files.agentCanonicalPath)).toEqual(changed);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect((await assets.listAbilityAssets(USER_ID)).filter((asset) => asset.statement === '预览时存在的记忆。')).toEqual([]);
  });

  it('blocks a corrupted source instead of presenting it as empty or modifying it', async () => {
    const files = await setupSources();
    const corrupt = '<!-- cogseed-agent-memory:v1 invalid -->\n仍然可读但归属不明的内容。';
    fs.writeFileSync(files.agentCanonicalPath, corrupt, 'utf8');
    const migration = await migrationModule();

    const preview = await migration.previewLegacyScopedMemoryMigration(USER_ID);

    expect(preview.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: `agent:${AGENT_ID}:canonical`, status: 'blocked', eligibleEntries: 0 }),
    ]));
    expect(preview.items.some((item) => item.text.includes('仍然可读但归属不明'))).toBe(false);
    expect(fs.readFileSync(files.agentCanonicalPath, 'utf8')).toBe(corrupt);
  });
});
