import * as fs from 'node:fs/promises';

import { nowIso, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import * as localSecrets from '../../util/local-secret-store';
import type { ToolSchema, Transport } from '../connectors/types';
import {
  assertMateConnectorId,
  assertMateUserId,
  mateConnectorFile,
  mateConnectorSecretFile,
  mateConnectorsDirectory,
} from './paths';

export const MATE_CONNECTOR_SCHEMA_VERSION = 1 as const;
export type MateConnectorStatus = 'disconnected' | 'connected' | 'error';

export interface MateConnectorRecord {
  schemaVersion: typeof MATE_CONNECTOR_SCHEMA_VERSION;
  id: string;
  displayName: string;
  transport: Transport;
  enabledSubtools: string[] | null;
  toolsCache: ToolSchema[];
  toolsCachedAt: number;
  status: MateConnectorStatus;
  createdAt: string;
  updatedAt: string;
}

interface MateConnectorMetadata extends Omit<MateConnectorRecord, 'transport'> {
  transportKind: Transport['kind'];
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function secretContext(userId: string, id: string): localSecrets.LocalSecretContext {
  return { namespace: 'mate.connectors.transport', ownerId: userId, recordId: id };
}

function validateTransport(value: unknown): Transport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid CogSeed connector transport');
  const row = value as Record<string, unknown>;
  if (row.kind === 'streamable-http') {
    if (typeof row.url !== 'string' || !/^https?:\/\//.test(row.url)) throw new Error('invalid CogSeed connector URL');
    return { kind: 'streamable-http', url: row.url, ...(row.headers && typeof row.headers === 'object' ? { headers: row.headers as Record<string, string> } : {}) };
  }
  if (row.kind === 'stdio') {
    if (typeof row.command !== 'string' || !row.command.trim() || !Array.isArray(row.args)) throw new Error('invalid CogSeed connector stdio transport');
    return { kind: 'stdio', command: row.command, args: row.args.map(String), ...(row.env && typeof row.env === 'object' ? { env: row.env as Record<string, string> } : {}), ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}), ...(typeof row.proxyTargetUrl === 'string' ? { proxyTargetUrl: row.proxyTargetUrl } : {}) };
  }
  throw new Error('unsupported CogSeed connector transport');
}

function validateMetadata(userId: string, value: unknown, expectedId: string): MateConnectorMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed connector metadata');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_CONNECTOR_SCHEMA_VERSION || row.id !== expectedId || typeof row.displayName !== 'string') throw new Error('malformed CogSeed connector metadata');
  assertMateConnectorId(expectedId);
  if (row.transportKind !== 'stdio' && row.transportKind !== 'streamable-http') throw new Error('malformed CogSeed connector metadata');
  if (!Array.isArray(row.toolsCache) || (row.enabledSubtools !== null && !Array.isArray(row.enabledSubtools))) throw new Error('malformed CogSeed connector metadata');
  if (typeof row.status !== 'string' || !['disconnected', 'connected', 'error'].includes(row.status)) throw new Error('malformed CogSeed connector metadata');
  if (typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') throw new Error('malformed CogSeed connector metadata');
  void userId;
  return row as unknown as MateConnectorMetadata;
}

async function readMetadata(userId: string, id: string): Promise<MateConnectorMetadata> {
  try { return validateMetadata(userId, JSON.parse(await fs.readFile(mateConnectorFile(userId, id), 'utf8')), id); }
  catch (error) {
    if (isEnoent(error)) throw new Error('CogSeed connector not found');
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed connector metadata');
    throw error;
  }
}

export async function createMateConnector(userId: string, input: { id: string; displayName: string; transport: Transport; enabledSubtools?: string[] | null }): Promise<MateConnectorRecord> {
  assertMateUserId(userId);
  const id = assertMateConnectorId(input.id);
  const displayName = String(input.displayName || '').trim();
  if (!displayName || displayName.length > 200) throw new Error('invalid CogSeed connector display name');
  const transport = validateTransport(input.transport);
  const now = nowIso();
  const metadata: MateConnectorMetadata = { schemaVersion: MATE_CONNECTOR_SCHEMA_VERSION, id, displayName, transportKind: transport.kind, enabledSubtools: input.enabledSubtools === undefined ? null : (input.enabledSubtools === null ? null : Array.from(new Set((input.enabledSubtools || []).map(String)))), toolsCache: [], toolsCachedAt: 0, status: 'disconnected', createdAt: now, updatedAt: now };
  const secret = localSecrets.encryptLocalSecret(secretContext(userId, id), JSON.stringify(transport));
  await fileEditLock(mateConnectorFile(userId, id)).runExclusive(async () => {
    await writeJson(mateConnectorFile(userId, id), metadata);
    await writeJson(mateConnectorSecretFile(userId, id), { schemaVersion: MATE_CONNECTOR_SCHEMA_VERSION, encryptedTransport: secret });
  });
  return { ...metadata, transport };
}

export async function readMateConnector(userId: string, id: string): Promise<MateConnectorRecord> {
  assertMateUserId(userId);
  const connectorId = assertMateConnectorId(id);
  const metadata = await readMetadata(userId, connectorId);
  let secret: { encryptedTransport?: unknown };
  try { secret = JSON.parse(await fs.readFile(mateConnectorSecretFile(userId, connectorId), 'utf8')); }
  catch (error) { if (isEnoent(error)) throw new Error('CogSeed connector transport secret not found'); throw error; }
  if (typeof secret.encryptedTransport !== 'string') throw new Error('malformed CogSeed connector transport secret');
  const transport = validateTransport(JSON.parse(localSecrets.decryptLocalSecret(secretContext(userId, connectorId), secret.encryptedTransport)));
  return { ...metadata, transport };
}

export async function listMateConnectors(userId: string): Promise<MateConnectorRecord[]> {
  assertMateUserId(userId);
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(mateConnectorsDirectory(userId), { withFileTypes: true }); }
  catch (error) { if (isEnoent(error)) return []; throw error; }
  const out: MateConnectorRecord[] = [];
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json')) out.push(await readMateConnector(userId, entry.name.slice(0, -5)));
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function updateMateConnectorTools(userId: string, id: string, toolsCache: ToolSchema[], status: MateConnectorStatus): Promise<MateConnectorRecord> {
  const current = await readMateConnector(userId, id);
  const metadata: MateConnectorMetadata = { schemaVersion: MATE_CONNECTOR_SCHEMA_VERSION, id: current.id, displayName: current.displayName, transportKind: current.transport.kind, enabledSubtools: current.enabledSubtools, toolsCache, toolsCachedAt: Date.now(), status, createdAt: current.createdAt, updatedAt: nowIso() };
  await writeJson(mateConnectorFile(userId, current.id), metadata);
  return { ...metadata, transport: current.transport };
}


export async function updateMateConnectorEnabledSubtools(userId: string, id: string, enabledSubtools: string[] | null): Promise<MateConnectorRecord> {
  assertMateUserId(userId);
  const connectorId = assertMateConnectorId(id);
  const current = await readMateConnector(userId, connectorId);
  const normalized = enabledSubtools === null ? null : Array.from(new Set(enabledSubtools.map(String).filter(Boolean)));
  const metadata: MateConnectorMetadata = {
    schemaVersion: MATE_CONNECTOR_SCHEMA_VERSION,
    id: current.id,
    displayName: current.displayName,
    transportKind: current.transport.kind,
    enabledSubtools: normalized,
    toolsCache: current.toolsCache,
    toolsCachedAt: current.toolsCachedAt,
    status: current.status,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  };
  await fileEditLock(mateConnectorFile(userId, connectorId)).runExclusive(async () => writeJson(mateConnectorFile(userId, connectorId), metadata));
  return { ...metadata, transport: current.transport };
}

export async function deleteMateConnector(userId: string, id: string): Promise<void> {
  assertMateUserId(userId);
  const connectorId = assertMateConnectorId(id);
  await fs.rm(mateConnectorFile(userId, connectorId), { force: true });
  await fs.rm(mateConnectorSecretFile(userId, connectorId), { force: true });
}
