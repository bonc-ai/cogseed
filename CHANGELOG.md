# Changelog

All notable changes to CogSeed are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **In-app update reminders** — silent startup check plus a Settings › 通用 › 更新
  entry; once-per-day reminders with a "skip this version" option; in-app download
  with sha256 verification and OS installer hand-off (macOS dmg; zip-based
  automatic replacement is a planned phase 2). Server contract:
  `GET {COGSEED_API_BASE_URL}/updates/latest` — see `docs/design/updates-api.md`.

## [0.0.5] - 2026-08-19

CogSeed's first public release.

### Added

- **Continue existing work** — switch entry points without losing task
  context, requirements, or established decisions; resume prior work in a new
  conversation or with a supported Agent.
- **Durable cognition** — confirmed goals, boundaries, and working methods
  persist across conversations as personal working knowledge.
- **Visible usage** — see which content was brought into and actually used in
  new work; you decide what is worth keeping.
- **Local-first** — personal space, task state, and confirmed content are
  stored locally by default; first release supports Apple Silicon Macs.

### Standards

- Implements the IEEE P3394 standard for agent interoperability (see
  [README](./README.md#standards)).
