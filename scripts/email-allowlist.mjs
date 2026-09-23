#!/usr/bin/env node
/**
 * Email-hygiene allowlist — the single source of truth for `.github/workflows/email-gate.yml`.
 *
 * Why this is code and not an inline grep pattern in the workflow
 * --------------------------------------------------------------
 * The gate used to carry its allowlist as a `grep -vE` literal inside the workflow file.
 * In Sep 2026 two real personal mailboxes were added there as "temporary" exceptions
 * (first a qq address, then a gmail address). Both stayed for days and neither had an
 * expiry, because a policy hidden inside a shell string is invisible in review and
 * cannot be validated. The sanctioned forms therefore live *here*, where widening them
 * requires changing code that a reviewer reads; time-boxed exceptions live in
 * `.github/email-allowlist.txt`, which `--check` validates for format, expiry and
 * personal-mailbox quarantine.
 *
 * Two allowlists, not one
 * -----------------------
 * GitHub is the committer of every commit it creates: web-UI merge, squash and rebase all
 * commit as GitHub's own automation identity (verified against every web-generated commit on
 * `develop`). That identity must be accepted in the committer column and must never be
 * accepted as an author, so the two columns are kept apart. The author column is the one a
 * merge-time account-email leak lands in.
 *
 * Consumers
 * ---------
 *   .github/workflows/email-gate.yml    --check / --emit-author / --emit-committer
 *   test/scripts/email-allowlist.test.ts the exported helpers
 *
 * Patterns must be POSIX ERE: they are joined with `|` and fed to `grep -E`. Keep them
 * free of constructs whose meaning differs between JS `RegExp` and ERE.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Repository-relative path of the time-boxed exception ledger. */
export const ALLOWLIST_FILE = '.github/email-allowlist.txt';

/** Sanctioned author identities. Widening this list is a policy change: review it as one. */
export const AUTHOR_POLICY = Object.freeze([
  '[0-9]+\\+[^@]+@users\\.noreply\\.github\\.com',
  'business@bonc\\.com\\.cn',
  'support@github\\.com',
]);

/** Committer column: everything authors may use, plus GitHub's own automation identity. */
export const COMMITTER_POLICY = Object.freeze([
  ...AUTHOR_POLICY,
  'noreply@github\\.com',
]);

const KINDS = ['author', 'committer', 'both'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOREPLY_HOST = /@(users\.noreply\.github\.com|github\.com)$/;
const PERSONAL_HOST =
  /(^|\.)(gmail|googlemail|qq|foxmail|163|126|sina|sohu|outlook|hotmail|live|icloud|yahoo|aol|yandex|protonmail)\.(com|cn|net|org)$/;

/** Compare patterns by their literal meaning, not by their regex escaping. */
const unescape = (pattern) => pattern.replace(/\\(.)/g, '$1');

/** Every literal-looking host a pattern could match, e.g. the id-less users.noreply.github.com form. */
function hostsIn(pattern) {
  return (unescape(pattern).match(/@[A-Za-z0-9._-]+/g) || []).map((token) => token.slice(1).toLowerCase());
}

/**
 * True when the pattern can match a real personal mailbox or a machine-local address.
 * Such entries are rejected outright, expiry or not: allowlisting a real mailbox is what
 * turned a one-off merge accident into a permanent hole in Sep 2026.
 */
export function isPersonalMailbox(pattern) {
  return hostsIn(pattern).some((host) => host.endsWith('.local') || PERSONAL_HOST.test(host));
}

/** True when the pattern can only match a sanctioned noreply form — the only kind of exception allowed. */
export function isNoreplyForm(pattern) {
  return NOREPLY_HOST.test(unescape(pattern));
}

/** Split ledger text into records, reporting structural problems (field count) as errors. */
export function parseLedger(text) {
  const records = [];
  const errors = [];

  text.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const fields = line.split('\t').map((field) => field.trim());
    if (fields.length !== 5) {
      errors.push(
        `line ${lineNo}: expected 5 tab-separated fields (kind, pattern, expires, approver, reason), got ${fields.length}`,
      );
      return;
    }

    const [kind, pattern, expires, approver, reason] = fields;
    records.push({ lineNo, kind, pattern, expires, approver, reason });
  });

  return { records, errors };
}

/**
 * Validate parsed records. `today` is an ISO date (`YYYY-MM-DD`); it is passed in so the
 * expiry behaviour is testable without freezing the clock.
 */
export function validateLedger(records, today) {
  const errors = [];

  for (const { lineNo, kind, pattern, expires, approver, reason } of records) {
    if (!KINDS.includes(kind)) {
      errors.push(`line ${lineNo}: kind must be one of ${KINDS.join(' / ')}, got '${kind}'`);
    }
    if (!pattern.includes('@')) {
      errors.push(`line ${lineNo}: pattern does not look like an email address`);
    } else {
      try {
        new RegExp(pattern);
      } catch (err) {
        errors.push(`line ${lineNo}: pattern is not a valid regular expression (${err.message})`);
      }

      if (isPersonalMailbox(pattern)) {
        errors.push(
          `line ${lineNo}: refusing to allowlist a real personal mailbox ('${pattern}'). ` +
            'Exceptions exist for noreply-FORM variants only — fix the address instead of hiding it.',
        );
      } else if (!isNoreplyForm(pattern)) {
        errors.push(
          `line ${lineNo}: exceptions are limited to noreply forms (@users.noreply.github.com / @github.com), got '${pattern}'`,
        );
      }
    }

    if (!ISO_DATE.test(expires)) {
      errors.push(`line ${lineNo}: expires must be YYYY-MM-DD, got '${expires}'`);
    } else if (expires < today) {
      errors.push(
        `line ${lineNo}: exception expired on ${expires} (today is ${today}). ` +
          'An exception is meant to be deleted on its expiry date, not renewed — remove the record.',
      );
    }

    if (!approver || approver === '-') errors.push(`line ${lineNo}: approver is required`);
    if (!reason || reason === '-') errors.push(`line ${lineNo}: reason is required`);
  }

  return errors;
}

/** Combine the policy with the ledger's exceptions into the two `grep -E` alternations. */
export function buildPatterns(records) {
  const forColumn = (column) =>
    records.filter((record) => record.kind === column || record.kind === 'both').map((record) => record.pattern);

  return {
    author: [...AUTHOR_POLICY, ...forColumn('author')].join('|'),
    committer: [...COMMITTER_POLICY, ...forColumn('committer')].join('|'),
  };
}

/** Read + parse + validate the ledger. Throws on any problem so no caller can silently weaken the gate. */
export function loadAllowlist(file = ALLOWLIST_FILE, today = new Date().toISOString().slice(0, 10)) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read allowlist ledger '${file}': ${err.message}`);
  }

  const { records, errors } = parseLedger(text);
  const problems = [...errors, ...validateLedger(records, today)];
  if (problems.length > 0) {
    throw new Error(`allowlist ledger '${file}' is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  return { records, patterns: buildPatterns(records) };
}

const USAGE = `Usage: node scripts/email-allowlist.mjs <command> [--file <path>]

  --check            validate the ledger (format, expiry, personal-mailbox quarantine)
  --emit-author      print the author-column alternation for grep -E
  --emit-committer   print the committer-column alternation for grep -E
`;

function resolveRepoRoot() {
  // This file lives at <repo>/scripts/email-allowlist.mjs, so the repo root is one level up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function main(argv) {
  const command = argv.find((arg) => arg.startsWith('--'));
  const fileFlag = argv.indexOf('--file');
  const fileFlagValue = fileFlag === -1 ? undefined : argv[fileFlag + 1];

  if (!command) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (fileFlag !== -1 && !fileFlagValue) {
    process.stderr.write('--file requires a path\n');
    process.stderr.write(USAGE);
    return 2;
  }

  const file = fileFlagValue ? path.resolve(fileFlagValue) : path.join(resolveRepoRoot(), ALLOWLIST_FILE);

  let loaded;
  try {
    loaded = loadAllowlist(file);
  } catch (err) {
    for (const line of String(err.message).split('\n')) {
      process.stdout.write(line.startsWith('  - ') ? `::error::${line.slice(4)}\n` : `${line}\n`);
    }
    return 1;
  }

  switch (command) {
    case '--check':
      process.stdout.write(
        `✅ Email allowlist ledger is valid (${loaded.records.length} exception(s), ${file}).\n`,
      );
      return 0;
    case '--emit-author':
      process.stdout.write(`${loaded.patterns.author}\n`);
      return 0;
    case '--emit-committer':
      process.stdout.write(`${loaded.patterns.committer}\n`);
      return 0;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

/** True when this module was invoked as a CLI rather than imported by a test. */
function isDirectRun() {
  const entry = process.argv[1];
  // Compare as URLs, not as strings: `import.meta.url` percent-encodes non-ASCII path
  // segments (e.g. a Chinese directory name) while `process.argv[1]` does not, so a
  // string comparison silently skips `main()` and the CLI exits 0 having done nothing.
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  process.exit(main(process.argv.slice(2)));
}
