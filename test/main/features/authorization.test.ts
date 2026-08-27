import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Grants are stored per user under <WS_ROOT>/.../cloud/config/authorization.json.
// Pin COGSEED_WORKSPACE_ROOT to a throwaway dir before importing the service so
// its transitive import of paths.ts never freezes to the developer's real data
// root (see test/setup-env.ts for the full rationale).
const UID = 'authorization-test-user';

let tmpDir: string;
let prevWs: string | undefined;
let auth: typeof import('../../../src/main/features/authorization/authorization-service');

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-authorization-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  auth = await import('../../../src/main/features/authorization/authorization-service');
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sessionInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: UID,
    resourceType: 'session',
    resourceId: 'sess-abc123',
    subjectType: 'agent',
    subjectId: 'agent-xyz789',
    permission: 'body.read',
    ...overrides,
  };
}

function sessionGrant(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: 'session',
    resourceId: 'sess-abc123',
    subjectType: 'agent',
    subjectId: 'agent-xyz789',
    permissions: ['metadata.read', 'body.read', 'search.read'],
    ...overrides,
  };
}

describe('authorization service', () => {
  it('lets the owning user read without any grant', async () => {
    const decision = await auth.decide({ ...sessionInput(), subjectType: 'user', subjectId: UID });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('user-owner');
  });

  it('denies an agent subject with no grant', async () => {
    const decision = await auth.decide(sessionInput());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing-grant');
  });

  it('grants and then allows the exact permission', async () => {
    const grant = await auth.grant(UID, sessionGrant());
    expect(grant.status).toBe('active');
    expect(grant.version).toBe(1);
    const decision = await auth.decide(sessionInput());
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('grant');
    expect(decision.grantId).toBe(grant.id);
  });

  it('denies a permission that was never granted', async () => {
    await auth.grant(UID, { ...sessionGrant(), permissions: ['metadata.read'] });
    const decision = await auth.decide(sessionInput()); // body.read
    expect(decision.allowed).toBe(false);
  });

  it('revokes a previously granted permission', async () => {
    await auth.grant(UID, sessionGrant());
    const revoked = await auth.revoke(UID, {
      resourceType: 'session',
      resourceId: 'sess-abc123',
      subjectType: 'agent',
      subjectId: 'agent-xyz789',
    });
    expect(revoked?.status).toBe('revoked');
    const decision = await auth.decide(sessionInput());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('revoked');
  });

  it('re-granting after revoke reactivates and bumps the version', async () => {
    const first = await auth.grant(UID, sessionGrant());
    expect(first.version).toBe(1);
    await auth.revoke(UID, {
      resourceType: 'session',
      resourceId: 'sess-abc123',
      subjectType: 'agent',
      subjectId: 'agent-xyz789',
    });
    const second = await auth.grant(UID, sessionGrant());
    expect(second.version).toBe(3);
    expect(second.status).toBe('active');
    expect((await auth.decide(sessionInput())).allowed).toBe(true);
  });

  it('inherits body.read from the parent project', async () => {
    await auth.grant(UID, {
      resourceType: 'project',
      resourceId: 'proj-p1',
      subjectType: 'agent',
      subjectId: 'agent-xyz789',
      permissions: ['body.read'],
    });
    const inherited = await auth.decide({ ...sessionInput(), parentProjectId: 'proj-p1' });
    expect(inherited.allowed).toBe(true);
    // Without the parent hint the same session is denied.
    const noInherit = await auth.decide(sessionInput());
    expect(noInherit.allowed).toBe(false);
  });

  it('inherits body.read from the parent agent', async () => {
    await auth.grant(UID, {
      resourceType: 'agent',
      resourceId: 'agent-xyz789',
      subjectType: 'agent',
      subjectId: 'agent-xyz789',
      permissions: ['body.read'],
    });
    const inherited = await auth.decide({ ...sessionInput(), parentAgentId: 'agent-xyz789' });
    expect(inherited.allowed).toBe(true);
  });

  it('acquires a read lease and keeps it valid while the grant holds', async () => {
    await auth.grant(UID, sessionGrant());
    const lease = await auth.acquireReadLease(sessionInput());
    expect(lease.grantId).toBeTruthy();
    expect(lease.permission).toBe('body.read');
    await expect(auth.assertLeaseStillValid(lease)).resolves.toBeUndefined();
  });

  it('throws when acquiring a read lease without authorization', async () => {
    await expect(auth.acquireReadLease(sessionInput())).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
    });
  });

  it('invalidates a lease after the grant is revoked', async () => {
    await auth.grant(UID, sessionGrant());
    const lease = await auth.acquireReadLease(sessionInput());
    await auth.revoke(UID, {
      resourceType: 'session',
      resourceId: 'sess-abc123',
      subjectType: 'agent',
      subjectId: 'agent-xyz789',
    });
    await expect(auth.assertLeaseStillValid(lease)).rejects.toMatchObject({
      code: 'AUTHORIZATION_REVOKED',
    });
  });

  it('reports metadata_only, authorized, and revoked state transitions', async () => {
    let st = await auth.state(sessionInput());
    expect(st.authorizationState).toBe('metadata_only');
    await auth.grant(UID, sessionGrant());
    st = await auth.state(sessionInput());
    expect(st.authorizationState).toBe('authorized');
    await auth.revoke(UID, {
      resourceType: 'session',
      resourceId: 'sess-abc123',
      subjectType: 'agent',
      subjectId: 'agent-xyz789',
    });
    st = await auth.state(sessionInput());
    expect(st.authorizationState).toBe('revoked');
  });
});
