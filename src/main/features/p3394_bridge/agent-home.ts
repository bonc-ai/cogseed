import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidP3394AgentId } from './identity';

export type P3394AgentHomeArea = 'manifest' | 'identity' | 'peers' | 'sessions' | 'policy' | 'consent' | 'audit' | 'journal';

export interface P3394AgentHome {
  uid: string;
  agent_id: string;
  root: string;
  manifestFile: string;
  identityFile: string;
  peersRegistryFile: string;
  policyDir: string;
  consentDir: string;
  auditDir: string;
  journalDir: string;
  sessionDir(sessionId: string): string;
  sessionFile(sessionId: string): string;
  workspaceDir(sessionId: string): string;
  artifactsDir(sessionId: string): string;
  checkpointsDir(sessionId: string): string;
  traceFile(sessionId: string): string;
  kstarDir(sessionId: string): string;
  kstarFile(sessionId: string, name: 'episode' | 'aar' | 'feedback' | 'proposed-updates'): string;
}

export type P3394AgentHomeResult = { ok: true; home: P3394AgentHome } | { ok: false; error: { reason: string; field: string; message: string } };

function fail(reason: string, field: string, message: string): P3394AgentHomeResult {
  return { ok: false, error: { reason, field, message } };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function safeSegment(value: string): boolean { return SAFE_ID.test(value) && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\'); }

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function joinInside(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments);
  if (!inside(root, target)) throw new Error('p3394_agent_home_path_escape');
  return target;
}

export function resolveP3394AgentHome(input: { userLocalRoot: string; uid: string; agent_id: string; create?: boolean }): P3394AgentHomeResult {
  if (!input.userLocalRoot || !path.isAbsolute(input.userLocalRoot)) return fail('invalid_root', 'userLocalRoot', 'Agent home root must be absolute.');
  const baseRoot = path.resolve(input.userLocalRoot);
  if (!safeSegment(input.uid)) return fail('invalid_uid', 'uid', 'Invalid user id segment.');
  if (!isValidP3394AgentId(input.agent_id)) return fail('invalid_agent_id', 'agent_id', 'Invalid P3394 agent id.');
  const root = joinInside(baseRoot, input.uid, 'local', 'p3394', 'agents', input.agent_id);
  const sessionDir = (sessionId: string): string => {
    if (!safeSegment(sessionId)) throw new Error('invalid_session_id');
    return joinInside(root, 'sessions', sessionId);
  };
  const home: P3394AgentHome = {
    uid: input.uid,
    agent_id: input.agent_id,
    root,
    manifestFile: joinInside(root, 'manifest.json'),
    identityFile: joinInside(root, 'identity.json'),
    peersRegistryFile: joinInside(root, 'peers', 'registry.json'),
    policyDir: joinInside(root, 'policy'),
    consentDir: joinInside(root, 'consent'),
    auditDir: joinInside(root, 'audit'),
    journalDir: joinInside(root, 'journal'),
    sessionDir,
    sessionFile: (id) => joinInside(sessionDir(id), 'session.json'),
    workspaceDir: (id) => joinInside(sessionDir(id), 'workspace'),
    artifactsDir: (id) => joinInside(sessionDir(id), 'artifacts'),
    checkpointsDir: (id) => joinInside(sessionDir(id), 'checkpoints'),
    traceFile: (id) => joinInside(sessionDir(id), 'trace.jsonl'),
    kstarDir: (id) => joinInside(sessionDir(id), 'kstar'),
    kstarFile: (id, name) => joinInside(sessionDir(id), 'kstar', `${name}.json`),
  };
  if (input.create) {
    for (const dir of [root, path.dirname(home.peersRegistryFile), home.policyDir, home.consentDir, home.auditDir, home.journalDir]) fs.mkdirSync(dir, { recursive: true });
  }
  return { ok: true, home };
}
