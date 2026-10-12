/** Developer replay: tsx scripts/evaluate-asset-catalog.ts cases.json old.json new.json */
import * as fs from 'node:fs/promises';

import {
  evaluateCatalogRuns,
  type CatalogEvaluatedRun,
  type CatalogJudgedCase,
} from '../src/main/features/recall/catalog-evaluation';

async function main(): Promise<void> {
  const [casesFile, ...runFiles] = process.argv.slice(2);
  if (!casesFile || !runFiles.length) {
    throw new Error('usage: tsx scripts/evaluate-asset-catalog.ts cases.json old-runs.json [new-runs.json]');
  }
  const cases = JSON.parse(await fs.readFile(casesFile, 'utf8')) as CatalogJudgedCase[];
  if (!Array.isArray(cases)) throw new Error('cases file must be an array');
  for (const file of runFiles) {
    const runs = JSON.parse(await fs.readFile(file, 'utf8')) as CatalogEvaluatedRun[];
    if (!Array.isArray(runs)) throw new Error(`runs file must be an array: ${file}`);
    process.stdout.write(`${JSON.stringify({ file, ...evaluateCatalogRuns(cases, runs) })}\n`);
  }
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
