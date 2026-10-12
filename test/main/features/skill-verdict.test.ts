/**
 * Reading a skill trust verdict.
 *
 * This predicate is the difference between "the scanner found something" and "the
 * scanner found something that matters for security". It has three consumers — the
 * skills list, the security page (through the receipt projection) and the reverify
 * decision — and they disagreed once already: two surfaces read the same 59
 * receipts, one called them `verified` and the other asked the user to pay
 * attention, because only one of them knew that a `risk` decision can be driven
 * entirely by declaration hygiene.
 *
 * The fixtures below are the *measured* shapes from a real profile, not invented
 * ones: 57 × `shape_staged_ceiling_missing`, 1 × `frontmatter_name_invalid`,
 * 1 × `frontmatter_description_too_long`, and one skill whose eight violations were
 * `frontmatter_extension_field` ×3, `frontmatter_description_too_long`,
 * `skill_meta_category_missing`, `skill_meta_routing_incomplete` and two shape
 * rules — all scored 100/100 by the deep scanner.
 */
import { describe, expect, it } from 'vitest';

import { isConventionRule, securityNotableOf } from '../../../src/main/features/skill_verdict';

describe('skill verdict › convention rules', () => {
  it('recognises every completeness family, not just shape_', () => {
    // The first version of this predicate tested `startsWith('shape_')` only, so
    // `frontmatter_*` and `skill_meta_*` still counted as substantive and kept the
    // whole library at `risk`.
    for (const rule of [
      'shape_staged_ceiling_missing', 'shape_trigger_missing', 'shape_frontmatter_incomplete',
      'frontmatter_name_invalid', 'frontmatter_description_too_long', 'frontmatter_extension_field',
      'skill_meta_category_missing', 'skill_meta_routing_incomplete', 'skill_meta_unparseable',
      'agent_name_missing', 'agent_category_invalid',
    ]) {
      expect(isConventionRule(rule), rule).toBe(true);
    }
  });

  it('treats anything that describes safety or runner policy as substantive', () => {
    for (const rule of [
      'no_credential_path_read', 'no_raw_ip_or_suspicious_tld_endpoint',
      'skill_script_requires_runner', 'requests_post', '', 'shape',
    ]) {
      expect(isConventionRule(rule), rule).toBe(false);
    }
  });

  it('fails toward substance for an unrecognised family', () => {
    // A new completeness family will show up as a false risk — noisy but visible.
    // A new *security* rule must never be swallowed into "convention" silently.
    expect(isConventionRule('integrity_manifest_missing')).toBe(false);
  });
});

describe('skill verdict › security notability', () => {
  it('does not make a declaration gap a security risk', () => {
    for (const topRule of ['shape_staged_ceiling_missing', 'frontmatter_description_too_long']) {
      expect(securityNotableOf({ decision: 'risk', topRule, topLevel: 'MEDIUM' }), topRule)
        .toBe(false);
    }
  });

  it('keeps a substantive finding notable at MEDIUM and EXTREME', () => {
    expect(securityNotableOf({
      decision: 'risk', topRule: 'no_raw_ip_or_suspicious_tld_endpoint', topLevel: 'MEDIUM',
    })).toBe(true);
    expect(securityNotableOf({
      decision: 'risk', topRule: 'no_credential_path_read', topLevel: 'EXTREME',
    })).toBe(true);
  });

  it('does not raise a warning for a LOW substantive finding', () => {
    // LOW is where metadata nits live; the receipt keeps the raw decision either way.
    expect(securityNotableOf({
      decision: 'risk', topRule: 'skill_script_requires_runner', topLevel: 'LOW',
    })).toBe(false);
  });

  it('treats a receipt without a level as not notable, and one without a rule as notable', () => {
    // No level: written before `topLevel` existed; the next rescan fills it in.
    expect(securityNotableOf({ decision: 'risk', topRule: 'no_credential_path_read' })).toBe(false);
    // No rule name: nothing says it was convention, so it stays visible.
    expect(securityNotableOf({ decision: 'risk', topLevel: 'MEDIUM' })).toBe(true);
  });

  it('is false for every non-risk decision', () => {
    for (const decision of ['pass', 'blocked', 'unknown', '']) {
      expect(securityNotableOf({ decision, topRule: 'no_credential_path_read', topLevel: 'EXTREME' }))
        .toBe(false);
    }
  });
});
