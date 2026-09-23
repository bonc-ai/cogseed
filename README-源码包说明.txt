CogSeed source package
======================

Project: CogSeed
Repository: https://github.com/bonc-ai/cogseed.git

Contents
--------
- Source: src/ (Electron main, renderer, Core Agent)
- Resources: resources/ (agents/skills, branding, runtime manifests)
- Tests: test/
- Docs: AGENTS.md, README.md, README.zh-CN.md

Local / rebuildable (not required in a minimal source tree)
----------------------------------------------------------
- node_modules/ (npm install)
- resources/runtime/ (npm run runtime:ensure)
- resources/embedding-model/ (prepared by postinstall)
- platform-specific resources under resources/

Quick start
-----------
npm install
./run.sh      # macOS / Linux
./run.cmd     # Windows

Verify
------
npm run typecheck
npm test

Notes
-----
Packaged release Hub / API defaults use the open-source placeholder
https://hub.example.com. Override with COGSEED_API_BASE_URL /
COGSEED_HUB_API_BASE for your deployment.
