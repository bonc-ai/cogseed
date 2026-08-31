import * as fs from 'node:fs/promises';

const [workspaceRoot, userId, executionId, childId, readyFile, startFile, resultFile, releaseFile] = process.argv.slice(2);
process.env.COGSEED_WORKSPACE_ROOT = workspaceRoot;

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function waitFor(file: string): Promise<void> {
  while (!await exists(file)) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function main(): Promise<void> {
  await fs.appendFile(readyFile, `${childId}\n`, 'utf8');
  await waitFor(startFile);
  const { acquireCogSeedResultDeliveryLease } = await import(
    '../../../../../src/main/features/cogseed_backend/result-delivery-lease'
  );
  const lease = await acquireCogSeedResultDeliveryLease(userId, executionId);
  await fs.appendFile(resultFile, `${childId}:${lease ? 'acquired' : 'busy'}\n`, 'utf8');
  if (lease) {
    await waitFor(releaseFile);
    await lease.release();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
