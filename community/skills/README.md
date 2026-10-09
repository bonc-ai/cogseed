# Community Skill Pilot

[简体中文](./README.zh-CN.md)

The first pilot accepts developer-proposed, declarative Skills that work with
user-provided or explicitly authorized local content. The starter Issues are
optional examples, not a whitelist, quota, or prerequisite. Pilot candidates
must not contain or instruct scripts, network access, external-system writes,
binary files, or new dependencies.

## Contribution flow

1. Choose either path:
   - claim a starter `community skill` Issue; or
   - independently propose a Skill, with no prior approval or Issue required.
2. Search existing Skills and open pull requests to avoid an obvious duplicate.
3. Copy `_template/` to `community/skills/<skill-id>/`. Use lowercase ASCII
   kebab-case for `<skill-id>`.
4. Replace every template placeholder and add at least one positive and one
   negative evaluation case.
5. Record the GitHub author and all third-party material in `provenance.json`.
6. Run `npm run community:skills:check`.
7. Commit with DCO sign-off and open a pull request against `develop` using the
   [community Skill PR template](../../.github/PULL_REQUEST_TEMPLATE/community-skill.md).
   If GitHub opened the generic template, select this template with the
   `template=community-skill.md` pull-request query parameter or copy its body.

The general repository setup and DCO rules remain mandatory; see
[CONTRIBUTING.md](../../CONTRIBUTING.md).

Maintainers can start from the reviewed
[pilot Issue drafts](../PILOT_BACKLOG.zh-CN.md). They are optional onboarding
prompts and do not limit independent proposals.

## Required package

```text
community/skills/<skill-id>/
├── SKILL.md
├── evals/
│   └── evals.json
└── provenance.json
```

Optional text-only content may be placed in `references/`, `templates/`, or
`examples/`. The pilot allows at most 30 files and 1 MiB per package. Symlinks,
executables, scripts, binaries, machine-specific absolute paths, and unresolved
template placeholders are rejected.

## Review and status

Reviewers check the user value, trigger and refusal boundaries, output quality,
evaluation cases, authorship, privacy, and safety. The pilot targets an initial
response within three business days, but does not guarantee acceptance or a
merge date.

The status chain is deliberately separate:

1. **Pull request opened** — proposed contribution.
2. **Merged community candidate** — repository-reviewed source only.
3. **Import verified** — separately tested in a clean CogSeed environment.
4. **Hub published** — separately approved and distributed through CogSeed Hub.
5. **Bundled** — separately approved for inclusion in an application release.

No earlier state implies a later one. The initial pilot ends at state 2 unless
the maintainers explicitly run and record an additional gate.

## Review ownership

`community/` is owned by `@windsgone` through CODEOWNERS. Security-sensitive,
copyright-sensitive, executable, networked, or dependency-bearing proposals are
outside the pilot and must be returned for a separate maintainer review path.
