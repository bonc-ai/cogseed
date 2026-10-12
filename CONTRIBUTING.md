# Contributing to CogSeed

English · [简体中文](./CONTRIBUTING.zh-CN.md)

Thanks for your interest in contributing to CogSeed! The public repository
contains reviewed release snapshots; development takes place in a private
repository. Contributions — bug reports, fixes, documentation, features, tests,
and examples — are welcome.

## Code of Conduct

Please read and follow our [Code of Conduct](./CODE_OF_CONDUCT.md). By
participating, you are expected to uphold this code.

## Getting Started

To try a release from source, follow the [README](./README.md#run-from-source). The steps below are for contributing changes from the latest public `main`.

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

3. Create a short-lived branch from the latest public `main`:

   ```bash
   git switch -c dev/<your-github-username> upstream/main
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
  [Development Guide](./docs/DEVELOPMENT.md#development-rules).
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

Acceptance into `community/skills/` means repository-reviewed candidate source
only, imported into private development before a later public snapshot. It does
not mean application import verification, Hub publication, release bundling, or
production approval.

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

- Open external contributions against the public `main` branch.
- Reference the issue your pull request addresses, if any.
- Describe what changed, why it is needed, and how you verified it.
- Keep generated output and unrelated formatting changes out of the diff.
- Be responsive to review feedback and keep the branch current with
  `upstream/main`.

For a first-time contributor, GitHub may show the workflow as waiting for
maintainer approval. This is expected for pull requests from forks and does not
mean the checks failed.

Before review, run the verification commands above and the tests relevant to
your change. Public CI checks are defined by the workflows and required checks
actually configured in the public repository; a document is not evidence that
a check has run or passed. Report any platform you have not verified.

## Contribution integration

The public `main` branch receives approved source snapshots at release time.
External pull requests are reviewed against that branch, then accepted patches
are imported into the private development repository. Maintainers preserve the
public PR reference, original commit authors and DCO sign-offs. Import alone
keeps the public PR open; it is not a completed merge or a release.

After the corresponding source candidate passes its release gates, maintainers
merge the reviewed public PR into `main` with a merge commit, retaining the
original contributor commits. Required CI and CODEOWNERS approval still apply;
do not squash or rebase away those commits. The next snapshot starts from that
updated public `main`, and synchronization refuses to proceed while a registered
contribution is missing from its history. Use a GitHub-linked noreply author
email so GitHub can associate those commits with your account.

Only reviewed public history based on the current clean public baseline may be
merged. Contributions based on older history need a clean migration retaining
authorship; never reconnect pre-baseline or private history. For content already
published in a snapshot, a reviewed history repair must preserve the complete
current file tree and pass the same CI and approval gates.

Acceptance and a source merge do not mean a release is available. Maintainers
link the public release when available. Internal review records and private
commit history are not copied into the public repository.

Create contributor branches from `upstream/main` and follow the public PR's
review feedback. Do not merge private branches or push release snapshots into
the public repository yourself.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <subject>
```

Example: `fix(messaging): handle disconnected group delivery`.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
