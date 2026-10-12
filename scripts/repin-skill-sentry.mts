/**
 * Regenerate the skill-sentry integrity pin.
 *
 *   node_modules/.bin/tsx scripts/repin-skill-sentry.mts
 *
 * WHY THIS IS REQUIRED, NOT OPTIONAL
 * ----------------------------------
 * `resources/guardrail/skill-sentry.INTEGRITY` holds a hash of the WHOLE scanner
 * tree. Any edit inside `resources/guardrail/skill-sentry/` invalidates it, and
 * the consequence is not a cosmetic warning:
 *
 *     scannerTrustedForLoad() -> { trusted: false }   when status is 'tampered'
 *
 * which makes the app REFUSE TO LOAD THE SCANNER. Every skill then loses its
 * security check, and the status page reports tampering — pointing at the
 * engine rather than at the edit that caused it.
 *
 * The pin lives BESIDE the tree (`../skill-sentry.INTEGRITY`), never inside it:
 * writing it inside would change the very hash it records, so the comparison
 * could never match. That mistake was made once already; see the comment on
 * `PIN_FILE` in src/main/features/scanner_trust.ts.
 *
 * This helper calls the app's own `skillPayloadHash` rather than reimplementing
 * the walk. A second implementation would drift from the first, and the failure
 * mode of that drift is "the scanner silently refuses to load".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

// `paths.ts` throws unless the data root is resolved first, and ESM hoists static
// imports above this assignment — hence the dynamic imports below.
const { resolveInstallContainer } = require_(path.join(REPO, 'src/main/install-data-root.cjs'));
process.env.COGSEED_WORKSPACE_ROOT =
  process.env.COGSEED_WORKSPACE_ROOT || resolveInstallContainer('cogseed');

const scannerDir = path.join(REPO, 'resources/guardrail/skill-sentry');
const pinPath = path.join(REPO, 'resources/guardrail/skill-sentry.INTEGRITY');

if (!fs.existsSync(scannerDir)) {
  console.error(`scanner tree not found: ${scannerDir}`);
  process.exit(1);
}

const { verifyScannerIntegrity } = await import(path.join(REPO, 'src/main/features/scanner_trust.ts'));
const { skillPayloadHash } = await import(path.join(REPO, 'src/main/features/skill_trust.ts'));

const before = verifyScannerIntegrity(scannerDir);
console.log(`scanner tree : ${path.relative(REPO, scannerDir)}`);
console.log(`pin file     : ${path.relative(REPO, pinPath)}`);
console.log(`before       : ${before.status}`);

if (before.status === 'verified') {
  console.log('already verified — nothing to do (pass --force to rewrite anyway)');
  if (!process.argv.includes('--force')) process.exit(0);
}

const actual = skillPayloadHash(scannerDir);
if (!actual) {
  console.error('hash came back empty; refusing to write a pin that matches nothing');
  process.exit(1);
}

fs.writeFileSync(pinPath, `${actual}\n`, 'utf8');
console.log(`wrote        : ${actual}`);

const after = verifyScannerIntegrity(scannerDir);
console.log(`after        : ${after.status}`);
if (after.status !== 'verified') {
  console.error('pin did not take; the scanner would refuse to load');
  process.exit(1);
}
console.log('ok');
