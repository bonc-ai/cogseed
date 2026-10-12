/** Hub governance observations only; never change bytes, pins or user preferences. */
import * as path from 'node:path';
import { userMarketplaceSkillDir } from '../../paths';
import { readJson, writeJson } from '../../storage';
import { hubContentStatus } from '../../../shared/hub-content-status';
import { withMarketplaceInstallLock } from '../marketplace_locks';
import { readInstalls, addSkillInstall } from '../marketplace_installs';

export async function observeHubSkillStatus(userId: string, contentId: string, row: { status?: unknown; state?: unknown }): Promise<void> {
  await withMarketplaceInstallLock(userId, 'skill', contentId, () => observeHubSkillStatusLocked(userId, contentId, row));
}

/** Only for the installation path that already owns this content's install lock. */
export async function observeHubSkillStatusLocked(userId: string, contentId: string, row: { status?: unknown; state?: unknown }): Promise<void> {
  const status = hubContentStatus(row);
  if (!status) return; // Missing fields and failed requests do not imply recovery.
  const marker = path.join(userMarketplaceSkillDir(userId, contentId), '_install.json');
  const meta = await readJson<Record<string, unknown>>(marker);
  if (meta && typeof meta.version === 'string' && hubContentStatus(meta) !== status) await writeJson(marker, { ...meta, status });
  const installed = (await readInstalls(userId)).skills.find((skill) => skill.id === contentId);
  if (installed && hubContentStatus(installed) !== status) await addSkillInstall(userId, { ...installed, status });
}
