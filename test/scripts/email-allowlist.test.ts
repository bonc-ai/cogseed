/**
 * The email-hygiene allowlist is policy, so its failure modes are the ones worth freezing:
 * an entry that outlives its expiry, an entry that allowlists a real personal mailbox, and
 * a "temporary" exception drifting back into the workflow file.
 *
 * Why the expiry case matters: the gate used to carry its allowlist as an inline `grep -E`
 * literal in `.github/workflows/email-gate.yml`. Two real mailboxes were added there as
 * "temporary" entries in Sep 2026 and neither had an expiry — both stayed in the public
 * repository until #376 removed them. A record that can outlive its reason is the whole
 * bug, so `--check` refuses to let one exist, and the workflow runs `--check` on every PR
 * and push.
 *
 * Why the personal-mailbox case matters: the same two entries were allowlisted *because*
 * they were real mailboxes, which turned a one-off merge accident into a permanent hole.
 * Exceptions are for noreply-FORM variants only; hiding a real address is never the fix.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  ALLOWLIST_FILE,
  AUTHOR_POLICY,
  COMMITTER_POLICY,
  buildPatterns,
  isNoreplyForm,
  isPersonalMailbox,
  loadAllowlist,
  parseLedger,
  validateLedger,
} from '../../scripts/email-allowlist.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ledgerPath = path.join(repoRoot, ALLOWLIST_FILE);
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'email-gate.yml');

/** Literal personal addresses, as they would appear if someone pasted one into the workflow. */
const PERSONAL_ADDRESS_IN_TEXT =
  /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|qq|foxmail|163|126|sina|sohu|outlook|hotmail|icloud|yahoo)\.(?:com|cn|net|org)\b|[A-Za-z0-9._-]+@[A-Za-z0-9._-]*\.local\b/i;

const record = (overrides = {}) => ({
  lineNo: 1,
  kind: 'author',
  pattern: '[A-Za-z0-9._-]+@users\\.noreply\\.github\\.com',
  expires: '2026-12-31',
  approver: 'cx677',
  reason: 'account has not switched to the id-prefixed form yet',
  ...overrides,
});

describe('email allowlist ledger', () => {
  it('accepts the ledger committed in the repository', () => {
    const { patterns } = loadAllowlist(ledgerPath);

    expect(patterns.author).toContain(AUTHOR_POLICY[0]);
    // A team address is sanctioned for authors; GitHub's own automation identity is not.
    expect(patterns.author).toContain('business@bonc\\.com\\.cn');
    expect(patterns.author).not.toContain('noreply@github\\.com');
    expect(patterns.committer).toContain('noreply@github\\.com');
  });

  it('rejects a record whose expiry has passed, so an exception cannot outlive its reason', () => {
    const errors = validateLedger([record({ expires: '2026-09-01' })], '2026-09-23');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expired on 2026-09-01');
    expect(errors[0]).toContain('remove the record');
  });

  it('accepts a record on its final day and rejects only after it', () => {
    expect(validateLedger([record({ expires: '2026-09-23' })], '2026-09-23')).toEqual([]);
    expect(validateLedger([record({ expires: '2026-09-22' })], '2026-09-23')).toHaveLength(1);
  });

  it('refuses to allowlist a real personal mailbox even with a valid future expiry', () => {
    for (const pattern of [
      '[A-Za-z0-9._-]+@qq\\.com',
      '[A-Za-z0-9._%+-]+@gmail\\.com',
      '[A-Za-z0-9._-]+@MacBook-Pro\\.local',
      'someone@163\\.com',
    ]) {
      const errors = validateLedger([record({ pattern })], '2026-09-23');
      expect(errors.join('\n')).toContain('real personal mailbox');
    }
  });

  it('limits exceptions to noreply forms', () => {
    // A corporate address is not a personal mailbox, but it is still not an exception we accept.
    const errors = validateLedger([record({ pattern: 'someone@example\\.com' })], '2026-09-23');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('exceptions are limited to noreply forms');
  });

  it('reports a malformed line instead of skipping it silently', () => {
    const { records, errors } = parseLedger(
      ['# comment', '', 'author\t[a-z]+@users\\.noreply\\.github\\.com\t2026-12-31', '   '].join('\n'),
    );

    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expected 5 tab-separated fields');
  });

  it('requires an approver and a reason on every record', () => {
    const errors = validateLedger([record({ approver: '-', reason: '' })], '2026-09-23');

    expect(errors.join('\n')).toContain('approver is required');
    expect(errors.join('\n')).toContain('reason is required');
  });

  it('routes an exception into the columns its kind names', () => {
    const patterns = buildPatterns([
      record({ kind: 'author', pattern: 'author-only@users\\.noreply\\.github\\.com' }),
      record({ kind: 'committer', pattern: 'committer-only@users\\.noreply\\.github\\.com' }),
      record({ kind: 'both', pattern: 'both@users\\.noreply\\.github\\.com' }),
    ]);

    expect(patterns.author).toContain('author-only@users\\.noreply\\.github\\.com');
    expect(patterns.author).toContain('both@users\\.noreply\\.github\\.com');
    expect(patterns.author).not.toContain('committer-only@users\\.noreply\\.github\\.com');

    expect(patterns.committer).toContain('committer-only@users\\.noreply\\.github\\.com');
    expect(patterns.committer).toContain('both@users\\.noreply\\.github\\.com');
    expect(patterns.committer).not.toContain('author-only@users\\.noreply\\.github\\.com');
  });

  it('classifies hosts the way the policy depends on', () => {
    expect(isPersonalMailbox('[0-9]+\\+[^@]+@users\\.noreply\\.github\\.com')).toBe(false);
    expect(isPersonalMailbox('.*@gmail\\.com')).toBe(true);
    expect(isPersonalMailbox('.*@MacBook-Pro\\.local')).toBe(true);
    expect(isNoreplyForm('.*@users\\.noreply\\.github\\.com')).toBe(true);
    expect(isNoreplyForm('.*@example\\.com')).toBe(false);
  });

  it('throws rather than returning a silently weakened allowlist', () => {
    expect(() => loadAllowlist(path.join(repoRoot, 'does', 'not', 'exist.txt'))).toThrow(/cannot read allowlist ledger/);
  });
});

describe('email-gate workflow contract', () => {
  const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));
  const source = readFileSync(workflowPath, 'utf8');

  it('runs on pull requests and on pushes to the branches whose merges create commits', () => {
    // `pull_request` sees only commits that exist before the merge; the merge / squash commit
    // is generated afterwards, so a push trigger is the only place it can be inspected.
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(['pull_request', 'push']));
    expect(workflow.on.push.branches).toEqual(['develop', 'cicd']);
  });

  it('keeps the required-check job name for pull requests', () => {
    // `check-commit-emails` is a required status check on develop; renaming it would make
    // every pull request wait forever for a check that never reports.
    expect(workflow.jobs['check-commit-emails']).toBeDefined();
    expect(workflow.jobs['check-commit-emails'].if).toBe("github.event_name == 'pull_request'");
    expect(workflow.jobs['check-pushed-emails'].if).toBe("github.event_name == 'push'");
  });

  it('keeps commit headers out of the workflow: no inline allowlist and no personal addresses', () => {
    const { patterns } = loadAllowlist(ledgerPath);

    // The allowlist must come from the ledger, not from a literal in the YAML.
    expect(source).not.toContain(AUTHOR_POLICY[0]);
    expect(source).not.toContain('business@bonc\\.com\\.cn');

    // This is the regression that cost the most: a real mailbox written into the workflow as a
    // "temporary" exception, where nothing could expire it. Scanning the workflow text against
    // the ledger's own personal-mailbox rule would have caught both retired entries.
    expect(isPersonalMailbox(patterns.author)).toBe(false);
    expect(source).not.toMatch(PERSONAL_ADDRESS_IN_TEXT);
  });

  it('checks the committer column as well as the author column', () => {
    const steps = JSON.stringify(workflow);
    expect(steps).toContain('%cn|%ce');
    expect(steps).toContain('%an|%ae');
  });
});

