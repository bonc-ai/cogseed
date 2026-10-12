/** Developer replay: rebuild per-turn catalog snapshots for labelled cases.
 *
 * Usage: npx tsx scripts/replay-asset-catalog.ts <userId> <cases.json> <runs-out.json>
 * cases.json: [{ id, taskText }] — extra fields (relevantIds, notes) are ignored
 * here and consumed by scripts/evaluate-asset-catalog.ts instead.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
require('../src/main/install-data-root.cjs')
  .initializeInstallDataRoot(process.env.COGSEED_RUNTIME_VARIANT || 'cogseed');

interface ReplayCase {
  id: string;
  taskText: string;
}

async function main(): Promise<void> {
  const [userId, casesFile, outFile] = process.argv.slice(2);
  if (!userId || !casesFile || !outFile) {
    throw new Error('usage: tsx scripts/replay-asset-catalog.ts <userId> <cases.json> <runs-out.json>');
  }
  const parsed = JSON.parse(await fs.readFile(casesFile, 'utf8')) as unknown;
  const cases = (Array.isArray(parsed) ? parsed : (parsed as { cases?: unknown }).cases) as ReplayCase[] | undefined;
  if (!Array.isArray(cases) || cases.some((item) => !item?.id || typeof item.taskText !== 'string')) {
    throw new Error('cases file must be an array of { id, taskText } or an object with a cases array');
  }
  const { catalogSnapshot } = await import('../src/main/features/recall/catalog-engine');
  const { renderCatalogPrompt } = await import('../src/main/features/recall/asset-catalog-hint');
  const runs: Array<{ caseId: string; rankedIds: string[]; shownIds: string[] }> = [];
  for (const item of cases) {
    const snapshot = await catalogSnapshot(userId, {
      cid: `eval-${item.id}`,
      turnId: `eval-${item.id}`,
      taskText: item.taskText,
    });
    const rendered = renderCatalogPrompt(snapshot);
    runs.push({
      caseId: item.id,
      rankedIds: snapshot.ranked.map((row) => row.assetId),
      shownIds: rendered.shown.map((row) => row.id),
    });
    process.stdout.write(`${item.id}: ranked=${snapshot.ranked.length} shown=${rendered.shown.length}\n`);
  }
  await fs.writeFile(outFile, `${JSON.stringify(runs, null, 1)}\n`, 'utf8');
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
