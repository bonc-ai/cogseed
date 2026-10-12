import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CognitionAsset } from '../../src/main/features/cognition';

/** 旧版 cognition store 的只读 fixture 构造：写入口已下线，测试直写盘。
 *  memory/paths 模块在调用时动态加载——vitest 的 resetModules + 每测临时根
 *  场景下，静态 import 会把 WS_ROOT 钉死在收集时刻的值。 */

const FIXTURE_TS = '2026-09-28T10:00:00';

async function loadMemory(): Promise<typeof import('../../src/main/features/memory')> {
  return import('../../src/main/features/memory');
}

export interface CognitionSeed {
  id: string;
  title: string;
  summary: string;
}

export function cognitionStoreFile(workspaceRoot: string, userId: string): string {
  return path.join(workspaceRoot, userId, 'cloud', 'cognition', 'assets.json');
}

export async function readCognitionStore(workspaceRoot: string, userId: string): Promise<CognitionAsset[]> {
  return (JSON.parse(await fs.readFile(cognitionStoreFile(workspaceRoot, userId), 'utf8')) as {
    assets: CognitionAsset[];
  }).assets;
}

function pendingAsset(seed: CognitionSeed, withEvidence: boolean) {
  const evidence = withEvidence ? [{
    id: `evidence_${seed.id}`,
    kind: 'manual' as const,
    summary: '用户确认这条认知来自可核验证据。',
    sourceLabel: '人工证据',
    createdAt: FIXTURE_TS,
  }] : [];
  return {
    id: seed.id,
    title: seed.title,
    summary: seed.summary,
    stage: withEvidence ? 'sprout' : 'seed',
    reviewState: 'pending',
    evidence,
    reuseEvents: [],
    transitions: [
      { id: `transition_${seed.id}_created`, kind: 'created', at: FIXTURE_TS },
      ...(withEvidence
        ? [{ id: `transition_${seed.id}_evidence`, kind: 'evidence_added', at: FIXTURE_TS, evidenceId: `evidence_${seed.id}` }]
        : []),
    ],
    createdAt: FIXTURE_TS,
    updatedAt: FIXTURE_TS,
  };
}

async function writeStore(
  workspaceRoot: string,
  userId: string,
  assets: Array<Record<string, unknown>>,
): Promise<void> {
  const file = cognitionStoreFile(workspaceRoot, userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 3, assets }, null, 2), 'utf8');
}

/** 合并写入：同 id 覆盖，其他资产保留（多次 seed 不互相清除）。 */
async function mergeIntoStore(
  workspaceRoot: string,
  userId: string,
  asset: Record<string, unknown>,
): Promise<void> {
  let existing: Array<Record<string, unknown>> = [];
  try {
    existing = (JSON.parse(await fs.readFile(cognitionStoreFile(workspaceRoot, userId), 'utf8')) as {
      assets?: Array<Record<string, unknown>>;
    }).assets || [];
  } catch { /* first seed */ }
  await writeStore(workspaceRoot, userId, [...existing.filter((item) => item.id !== asset.id), asset]);
}

export async function seedPendingCognition(
  workspaceRoot: string,
  userId: string,
  seed: CognitionSeed,
  withEvidence = true,
): Promise<void> {
  await mergeIntoStore(workspaceRoot, userId, pendingAsset(seed, withEvidence));
}

/** Confirmed 资产 + MEMORY 记录（经 memory 的 sourced-record 机制绑定）。 */
export async function seedConfirmedCognition(
  workspaceRoot: string,
  userId: string,
  seed: CognitionSeed,
): Promise<void> {
  const { ensureCognitionMemoryEntry, memoryContentHash } = await loadMemory();
  const ensured = ensureCognitionMemoryEntry(userId, seed.id, seed.summary);
  if (!ensured.ok || !ensured.record) throw new Error(`fixture memory ensure failed: ${ensured.error}`);
  const base = pendingAsset(seed, true);
  const asset = {
    ...base,
    stage: 'growing',
    reviewState: 'confirmed',
    confirmedAt: FIXTURE_TS,
    memoryBinding: {
      sourceId: seed.id,
      recordId: ensured.record.recordId,
      contentSha256: memoryContentHash(seed.summary),
      activatedAt: FIXTURE_TS,
    },
    transitions: [
      ...base.transitions,
      { id: `transition_${seed.id}_request`, kind: 'confirmation_requested', at: FIXTURE_TS },
      { id: `transition_${seed.id}_confirmed`, kind: 'confirmed', at: FIXTURE_TS },
    ],
  };
  await mergeIntoStore(workspaceRoot, userId, asset);
}
