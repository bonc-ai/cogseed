# P3394 Bridge Conformance Snapshot

Implemented in `dev/p3394-bridge-runtime`:

- UMF envelope validation.
- Bridge identity, manifest, and capability profile contracts.
- Local peer/alias registry.
- Agent Home logical boundary.
- Idempotency, replay protection, and audit primitives.
- Bridge kernel and bootstrap doctor.
- Runtime adapter contract and lifecycle managers.
- In-process, IPC alias, Unix socket alias, WebSocket opt-in model, inbound/outbound APIs, and external adapter descriptors.

Verification:

- `npm run test:js -- test/main/features/p3394_bridge`
- `npm run typecheck`
- `git diff --check origin/develop...HEAD`

Notes:

This is the bridge conformance foundation. Network and IPC implementations are intentionally contract-first and fail closed by default; production transport hardening remains staged behind explicit adapter work.
