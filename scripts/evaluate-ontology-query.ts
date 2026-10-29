import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  assessOntologyJevRollout,
  evaluateOntologyQueryDataset,
} from '../src/main/features/recall/ontology-query-evaluation';

async function main(): Promise<void> {
  const [inputArg, outputArg] = process.argv.slice(2);
  if (!inputArg) throw new Error('usage: npm run eval:ontology -- <desensitized-dataset.json> [report.json]');

  const inputPath = path.resolve(inputArg);
  const dataset = JSON.parse(await fs.readFile(inputPath, 'utf8')) as unknown;
  const report = evaluateOntologyQueryDataset(dataset);
  const serialized = `${JSON.stringify({ report, rollout: assessOntologyJevRollout(report) }, null, 2)}\n`;
  if (!outputArg) {
    process.stdout.write(serialized);
    return;
  }

  const outputPath = path.resolve(outputArg);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, serialized, 'utf8');
  process.stdout.write(`ontology evaluation report written to ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
