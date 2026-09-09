# Connections Agent Tab Navigation Fix

## Problem

The Connections page still renders an Agent tab and an embedded Agent pane, but clicking the tab redirects to Settings > Configuration. This conflicts with the visible navigation and leaves the embedded pane unreachable.

## Decision

Restore the Agent tab as a real Connections tab. Settings > Configuration remains available as a separate place for executor configuration; it is not the destination of the Connections Agent tab.

## Behavior

- Clicking Connections > Agent activates `connections-pane-agents` without changing the top-level view.
- Entering the Agent tab lazily refreshes the full Agent list through the existing `loadAgents(false)` path.
- Existing MCP, plugins, skills, sources, touchpoints, and models behavior remains unchanged.
- The fix adds renderer regression coverage proving that Agent activation does not call `setView('settings')` and reveals the Agent pane.

## Scope

Only Connections navigation logic and its focused renderer test are changed. No settings layout, Agent data model, IPC contract, or enterprise model-governance behavior is changed.
