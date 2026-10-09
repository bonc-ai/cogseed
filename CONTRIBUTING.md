# Contributing to CogSeed

English · [简体中文](./CONTRIBUTING.zh-CN.md)

Thanks for your interest in contributing to CogSeed! This project is developed
in the open, and contributions — bug reports, fixes, documentation, features,
tests, and examples — are welcome.

## Code of Conduct

Please read and follow our [Code of Conduct](./CODE_OF_CONDUCT.md). By
participating, you are expected to uphold this code.

## Getting Started

To try a release from source, follow the [README](./README.md#run-from-source). The steps below are for contributing changes from the latest `develop`.

CogSeed's primary development platforms are macOS and Windows. Before you
start, install Git, Node.js 24.x, and npm 11.11.0. See the
[Development Guide](./docs/DEVELOPMENT.md#development-setup) for platform and
setup details.

1. Fork the repository, then clone your fork and add the upstream repository:

   ```bash
   git clone https://github.com/<your-github-username>/cogseed.git
   cd cogseed
   git remote add upstream https://github.com/bonc-ai/cogseed.git
   git fetch upstream
   ```

2. Configure a repository-local Git identity. Copy your exact noreply address
   from **GitHub → Settings → Emails**; CogSeed's public-history gate requires
   the `{user-id}+{username}@users.noreply.github.com` form:

   ```bash
   git config user.name "Your Name"
   git config user.email "<github-user-id>+<username>@users.noreply.github.com"
   ```

3. Create a short-lived branch from the latest `develop`:

   ```bash
   git switch -c dev/<your-github-username> upstream/develop
   ```

4. Install the locked dependencies. `npm ci` also prepares native modules and
   downloads required development assets, so the first install needs network
   access and can take several minutes:

   ```bash
   npm ci
   npm run test:resources:setup
   ```

5. Verify the clean baseline before making changes:

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run readme:check
   ```

## Development Commands

| Command | Purpose |
|---|---|
| `./run.sh` | Launch the source app on macOS or Linux |
| `run.cmd` | Launch the source app on Windows |
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | Static checks for source, test, and script files |
| `npm test` | Full JavaScript and resource test suites |
| `npm run test:js -- <file>` | Run one JavaScript/TypeScript test file |
| `npm run test:resources` | Run the Python resource tests |
| `npm run readme:check` | Verify local links and bundled README assets |
| `npm run builtin:manifest` | Regenerate the built-in resources manifest |
| `npm run builtin:manifest:check` | Verify the manifest is up to date |

Do not invoke Vitest directly. The repository test runner manages Electron's
native-module ABI before and after the JavaScript suite.

## Making Changes

- Keep changes focused; prefer small, reviewable pull requests.
- Follow the repository layout and engineering boundaries in
  [AGENTS.md](./AGENTS.md).
- Add or update tests for behavior you change, including failure and recovery
  paths where relevant.
- Run `npm run typecheck`, `npm run lint`, `npm test`, and
  `npm run readme:check` before opening a pull request.
- If you change built-in resources, run `npm run builtin:manifest` and include
  the updated manifest.
- Never commit credentials, private logs, local runtime data, or customer
  material. Report suspected vulnerabilities privately as described in
  [SECURITY.md](./SECURITY.md).

### Community Skill pilot

Developers may claim a starter community Skill Issue or independently design a
declarative candidate from
[`community/skills/_template/`](./community/skills/_template/). Independent
proposals need no prior approval and do not require an Issue, but their pull
request must fully describe the user problem, boundaries, evaluation cases,
and sources. The first pilot does not accept scripts, executables, binaries,
network access, external-system writes, or new dependencies. See the
[Community Skill guide](./community/skills/README.md) for the package shape,
verification command, review boundary, and candidate states.

A merge into `community/skills/` means repository-reviewed candidate source
only. It does not mean import verification, Hub publication, release bundling,
or production approval.

## Developer Certificate of Origin (DCO)

Every commit must include a `Signed-off-by` trailer certifying that you have
the right to submit the contribution under the project's license. The trailer
must use the same GitHub noreply address as the commit author:

```text
Signed-off-by: Your Name <12345678+username@users.noreply.github.com>
```

Create signed-off commits with:

```bash
git commit -s
```

To add the trailer to your latest local commit, use:

```bash
git commit --amend --no-edit --signoff
```

By signing off, you agree to the terms of the
[Developer Certificate of Origin](https://developercertificate.org/). Do not
place other email addresses in commit messages or trailers; the email-hygiene
gate scans the complete public commit record.

## Reporting Issues

- Search existing issues before filing a new one.
- Include the CogSeed version, platform, expected behavior, actual behavior,
  and reproducible steps.
- Remove credentials and private data from screenshots and logs.
- For security vulnerabilities, **do not open a public issue** — follow
  [SECURITY.md](./SECURITY.md).

## Pull Requests

- Open external contributions against `develop`, not `main` or `cicd`.
- Reference the issue your pull request addresses, if any.
- Describe what changed, why it is needed, and how you verified it.
- Keep generated output and unrelated formatting changes out of the diff.
- Be responsive to review feedback and keep the branch current with
  `upstream/develop`.

For a first-time contributor, GitHub may show the workflow as waiting for
maintainer approval. This is expected for pull requests from forks and does not
mean the checks failed.

Pull requests to `develop` must pass:

- `check-commit-emails` — protects the public history from personal addresses;
- `static-gates` — typecheck, lint, design tokens, built-in manifest, README
  links, and skipped-test policy;
- `affected-tests` — module-graph-aware tests selected from the pull request
  diff.

Windows test shards also run and must be investigated when red, although they
are not currently required status checks. A full suite runs again after changes
land on `develop`; promotion to `cicd` runs the complete macOS, Windows, and
compliance release gates.

## Branching and Merge Rules

CogSeed uses three long-lived branches:

- `main` — protected public release branch; always intended to be releasable.
- `develop` — protected integration branch and the target for feature and
  external-contributor pull requests.
- `cicd` — protected release gate; promotion from `develop` runs the full
  verification and compliance pipeline before a release tag is accepted.

Short-lived contributor branches use `dev/<your-github-username>` by default.
Release maintainers may create `release/vX.Y` branches for patch-only work.

Merging requires at least one approving CODEOWNER review and all required
status checks. Pull request authors cannot approve their own changes; only a
maintainer with write access can merge after the requirements are satisfied.
Maintainers who merge through GitHub must enable **Keep my email addresses
private** so the generated merge commit also uses a noreply address.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <subject>
```

Example: `fix(messaging): handle disconnected group delivery`.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
