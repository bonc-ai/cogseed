# Contributing to CogSeed

Thanks for your interest in contributing to CogSeed! This project is developed in
the open, and contributions — bug reports, fixes, documentation, and features —
are welcome.

## Code of Conduct

Please read and follow our [Code of Conduct](./CODE_OF_CONDUCT.md). By
participating, you are expected to uphold this code.

## Getting Started

1. Fork the repository and clone your fork.
2. Install dependencies: `npm install`
3. Run the type checker: `npm run typecheck`
4. Run the linter: `npm run lint`
5. Run the test suite: `npm test`

## Development Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | Static checks for source, test, and script files |
| `npm test` | Full test suite (JS + resources) |
| `npm run readme:check` | Verify local links and bundled assets referenced by both READMEs |
| `npm test -- <file>` | Run a specific test file |
| `npm run start` | Launch the desktop app locally |
| `npm run builtin:manifest` | Regenerate the builtin resources manifest |
| `npm run builtin:manifest:check` | Verify the manifest is up to date |

## Making Changes

- Keep changes focused; prefer small, reviewable pull requests.
- Follow the repository layout and engineering boundaries described in
  [AGENTS.md](./AGENTS.md).
- Add or update tests for the code you change.
- Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run readme:check` before opening a pull request.
- If you change builtin resources, regenerate the manifest
  (`npm run builtin:manifest`) and include the updated file.

## Developer Certificate of Origin (DCO)

This project uses the **Developer Certificate of Origin** for contributions.
Every commit must include a `Signed-off-by` trailer, which certifies that you
have the right to submit the contribution under the project's license:

```text
Signed-off-by: Your Name <your@email.com>
```

Add it with `git commit -s`. By signing off you agree to the terms of the
[Developer Certificate of Origin](https://developercertificate.org/).

## Reporting Issues

- Search existing issues before filing a new one.
- Include the CogSeed version, your platform, and steps to reproduce.
- For security vulnerabilities, **do not open a public issue** — see
  [SECURITY.md](./SECURITY.md).

## Pull Requests

- Reference the issue your PR addresses, if any.
- Describe what the change does and why.
- Ensure all CI checks pass.
- A maintainer will review; be patient and responsive to feedback.

## Branching and Merge Rules

We use a **three-line branch model**:

- `main` — public release branch. Always releasable and **protected** — no direct pushes, all changes go through pull requests.
- `develop` — the main development branch. All feature work merges here via pull requests; CI (`verify`) must pass and a reviewer must approve before merge.
- `cicd` — release packaging branch. Used to build, sign and publish artifacts; merging into it requires a review (plus a manual security scan by the maintainers).
- Short-lived personal branches: `dev/<your-github-username>` (e.g. `dev/alice`) for day-to-day work; open a pull request against `develop` when ready.
- `release/vX.Y` branches are cut from `main` at release time for patch-only fixes; they are protected by the same review rules.

**For external contributors**: open your pull request against `develop`, not `main`.

### Merge requirements (branch protection)

1. At least **1 approving review** from a designated reviewer (see CODEOWNERS / `@bonc-ai/reviewers`).
2. All required CI checks pass (`verify`).
3. You cannot approve or merge your own pull request.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

Example: `fix(messaging): route wechat group messages correctly`.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
