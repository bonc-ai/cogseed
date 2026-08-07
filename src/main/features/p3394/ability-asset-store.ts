import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createLogger } from '../../logger';
import { nowIso, readJson, safeId, writeJson } from '../../storage';
import { userLocalRoot } from '../../paths';
import { withKstarUserLock } from './kstar-lock';
import type { AbilityAsset } from './ability-assets';

export interface AbilityAssetStoreState {
  version: 1;
  assets: AbilityAsset[];
  updated_at: string;
}

const log = createLogger('p3394.ability-asset-store');

function assertSafeId(value: unknown, label: string): string {
  if (!safeId(value)) throw new Error(`invalid ${label}`);
  return String(value);
}

function abilityAssetsDir(uid: string): string {
  return path.join(userLocalRoot(assertSafeId(uid, 'uid')), 'kstar');
}

export function abilityAssetsPath(uid: string): string {
  return path.join(abilityAssetsDir(uid), 'ability-assets.json');
}

function cloneAsset(asset: AbilityAsset): AbilityAsset {
  return JSON.parse(JSON.stringify(asset)) as AbilityAsset;
}

function cloneAssets(assets: AbilityAsset[]): AbilityAsset[] {
  return assets.map(cloneAsset);
}

function asState(raw: Partial<AbilityAssetStoreState> | null | undefined): AbilityAssetStoreState {
  return {
    version: 1,
    assets: Array.isArray(raw?.assets) ? cloneAssets(raw!.assets as AbilityAsset[]) : [],
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : nowIso(),
  };
}

async function readState(uid: string): Promise<AbilityAssetStoreState> {
  return asState(await readJson<Partial<AbilityAssetStoreState>>(abilityAssetsPath(uid)));
}

function assertAsset(asset: AbilityAsset): AbilityAsset {
  assertSafeId(asset.id, 'ability asset id');
  return cloneAsset(asset);
}

async function writeState(uid: string, state: AbilityAssetStoreState): Promise<void> {
  const file = abilityAssetsPath(uid);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const previous = `${file}.previous`;
  const existed = await fs.access(file).then(() => true, () => false);
  if (existed) {
    try {
      await fs.copyFile(file, previous);
    } catch (error) {
      log.warn('failed to archive previous ability assets state', {
        uid,
        error: (error as Error).message,
      });
    }
  }
  await writeJson(file, state);
}

async function mutateState(
  uid: string,
  mutator: (state: AbilityAssetStoreState) => AbilityAssetStoreState | Promise<AbilityAssetStoreState>,
): Promise<AbilityAssetStoreState> {
  return await withKstarUserLock(uid, async () => {
    const next = await mutator(await readState(uid));
    await writeState(uid, next);
    return next;
  });
}

export async function listAbilityAssets(uid: string): Promise<AbilityAsset[]> {
  return cloneAssets((await readState(uid)).assets);
}

export async function getAbilityAsset(uid: string, assetId: string): Promise<AbilityAsset | null> {
  const id = assertSafeId(assetId, 'asset id');
  const asset = (await readState(uid)).assets.find((item) => item.id === id);
  return asset ? cloneAsset(asset) : null;
}

export async function createAbilityAssetRecord(uid: string, asset: AbilityAsset): Promise<AbilityAsset> {
  const nextAsset = assertAsset(asset);
  const next = await mutateState(uid, (state) => {
    const assets = state.assets.filter((item) => item.id !== nextAsset.id);
    assets.push(nextAsset);
    return { version: 1, assets, updated_at: nowIso() };
  });
  return cloneAsset(next.assets.find((item) => item.id === nextAsset.id) ?? nextAsset);
}

export async function updateAbilityAssetRecord(uid: string, asset: AbilityAsset): Promise<AbilityAsset> {
  const nextAsset = assertAsset(asset);
  const next = await mutateState(uid, (state) => {
    if (!state.assets.some((item) => item.id === nextAsset.id)) {
      throw new Error('ability asset not found');
    }
    return {
      version: 1,
      assets: state.assets.map((item) => item.id === nextAsset.id ? nextAsset : item),
      updated_at: nowIso(),
    };
  });
  return cloneAsset(next.assets.find((item) => item.id === nextAsset.id) ?? nextAsset);
}
