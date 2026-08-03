import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { t } from '../../i18n';
import { callExpenseWorkbench } from './adapter';
import { isJsonObject, type JsonObject, type JsonValue } from './contracts';

export const MAX_EXPENSE_MATERIAL_FILES = 20;
export const MAX_EXPENSE_MATERIAL_BYTES = 176 * 1024;

const MATERIAL_CATEGORY = 'expense_receipt';
const MAX_MATERIAL_NAME_CHARS = 256;
const MATERIAL_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
} as const;

type SupportedExtension = keyof typeof MATERIAL_TYPES;

interface InspectedMaterial {
  name: string;
  mediaType: typeof MATERIAL_TYPES[SupportedExtension];
  content: Buffer;
  sha256: string;
}

export interface ExpenseMaterialSummary {
  ref: string;
  name: string;
  media_type: string;
  size: number;
  sha256: string;
  material_category: typeof MATERIAL_CATEGORY;
}

export interface ExpenseMaterialFailure {
  name: string;
  error: string;
}

export interface AddExpenseMaterialsResult {
  materials: ExpenseMaterialSummary[];
  failed: ExpenseMaterialFailure[];
}

export interface AddAndBindExpenseMaterialsResult extends AddExpenseMaterialsResult {
  application: JsonObject;
}

export interface ExpenseMaterialTarget {
  application: JsonObject;
  expectedVersion: number;
}

type MaterialImportErrorCode =
  | 'invalid_path'
  | 'invalid_name'
  | 'unsupported_type'
  | 'unsafe_file'
  | 'empty_file'
  | 'too_large'
  | 'file_changed'
  | 'type_mismatch'
  | 'unavailable';

class MaterialImportError extends Error {
  constructor(readonly errorCode: MaterialImportErrorCode) {
    super(errorCode);
    this.name = 'MaterialImportError';
  }
}

function materialErrorMessage(code: MaterialImportErrorCode): string {
  const keys: Record<MaterialImportErrorCode, string> = {
    invalid_path: 'expense_workbench.material.invalid_path',
    invalid_name: 'expense_workbench.material.invalid_name',
    unsupported_type: 'expense_workbench.material.unsupported_type',
    unsafe_file: 'expense_workbench.material.unsafe_file',
    empty_file: 'expense_workbench.material.empty_file',
    too_large: 'expense_workbench.material.too_large',
    file_changed: 'expense_workbench.material.file_changed',
    type_mismatch: 'expense_workbench.material.type_mismatch',
    unavailable: 'expense_workbench.material.unavailable',
  };
  return t(keys[code], { kib: MAX_EXPENSE_MATERIAL_BYTES / 1024 });
}

function safeDisplayName(filePath: string): string {
  if (!filePath || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new MaterialImportError('invalid_path');
  }
  const name = path.basename(filePath).normalize('NFC');
  if (!name || name === '.' || name === '..' || name.length > MAX_MATERIAL_NAME_CHARS) {
    throw new MaterialImportError('invalid_name');
  }
  return name;
}

function supportedExtension(name: string): SupportedExtension {
  const extension = path.extname(name).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MATERIAL_TYPES, extension)) {
    throw new MaterialImportError('unsupported_type');
  }
  return extension as SupportedExtension;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: fs.Stats, right: fs.Stats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function validatePreOpenStat(stat: fs.Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new MaterialImportError('unsafe_file');
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new MaterialImportError('unsafe_file');
  if (stat.size === 0) throw new MaterialImportError('empty_file');
  if (stat.size > MAX_EXPENSE_MATERIAL_BYTES) throw new MaterialImportError('too_large');
}

function matchesMagic(content: Buffer, extension: SupportedExtension): boolean {
  if (extension === '.pdf') return content.subarray(0, 4).equals(Buffer.from('%PDF'));
  if (extension === '.png') return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === '.jpg' || extension === '.jpeg') {
    return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  }
  if (content.length < 12 || content.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
  return new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'])
    .has(content.subarray(8, 12).toString('ascii'));
}

async function readBoundedFile(handle: fsp.FileHandle): Promise<Buffer> {
  const target = Buffer.allocUnsafe(MAX_EXPENSE_MATERIAL_BYTES + 1);
  let total = 0;
  while (total < target.length) {
    const { bytesRead } = await handle.read(target, total, target.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > MAX_EXPENSE_MATERIAL_BYTES) throw new MaterialImportError('too_large');
  if (total === 0) throw new MaterialImportError('empty_file');
  return target.subarray(0, total);
}

async function inspectExpenseMaterial(filePath: string): Promise<InspectedMaterial> {
  const name = safeDisplayName(filePath);
  const extension = supportedExtension(name);
  let before: fs.Stats;
  try {
    before = await fsp.lstat(filePath);
  } catch {
    throw new MaterialImportError('unavailable');
  }
  validatePreOpenStat(before);

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new MaterialImportError('unavailable');
  }

  let content: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new MaterialImportError('file_changed');
    }
    content = await readBoundedFile(handle);
    const after = await handle.stat();
    if (!sameFileSnapshot(opened, after) || after.size !== content.length) {
      throw new MaterialImportError('file_changed');
    }
  } catch (error) {
    if (error instanceof MaterialImportError) throw error;
    throw new MaterialImportError('unavailable');
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (!matchesMagic(content, extension)) throw new MaterialImportError('type_mismatch');
  return {
    name,
    mediaType: MATERIAL_TYPES[extension],
    content,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function validateExpenseMaterialRegistration(
  response: JsonObject,
  expected: Pick<ExpenseMaterialSummary, 'name' | 'media_type' | 'size' | 'sha256'>,
): ExpenseMaterialSummary {
  const raw = response.material;
  if (!isJsonObject(raw)) throw new Error('material registration returned an invalid response');
  const ref = asString(raw.ref);
  const responseName = asString(raw.name);
  const responseMediaType = asString(raw.media_type);
  const responseSha256 = asString(raw.sha256);
  const responseCategory = asString(raw.material_category);
  const responseSize = raw.size;
  if (!ref || !/^workspace:\/\/mat-[0-9a-f]{32}$/.test(ref)
    || responseName !== expected.name
    || responseMediaType !== expected.media_type
    || responseSize !== expected.size
    || responseSha256 !== expected.sha256
    || responseCategory !== MATERIAL_CATEGORY) {
    throw new Error('material registration returned an invalid response');
  }
  return {
    ref,
    name: expected.name,
    media_type: expected.media_type,
    size: expected.size,
    sha256: expected.sha256,
    material_category: MATERIAL_CATEGORY,
  };
}

function failureName(filePath: string): string {
  try {
    const name = path.basename(filePath).normalize('NFC');
    return name && name !== '.' && name !== '..' ? name.slice(0, MAX_MATERIAL_NAME_CHARS) : t('expense_workbench.material.unnamed');
  } catch {
    return t('expense_workbench.material.unnamed');
  }
}

export async function assertExpenseMaterialTarget(
  userId: string,
  agentId: string,
  applicationId: string,
): Promise<ExpenseMaterialTarget> {
  const response = await callExpenseWorkbench(userId, agentId, 'applications.get', {
    application_id: applicationId,
  });
  const application = response.application;
  if (!isJsonObject(application) || application.application_id !== applicationId
      || typeof application.current_version !== 'number'
      || !Number.isInteger(application.current_version)
      || application.current_version < 0) {
    throw new Error(t('expense_workbench.material.target_unavailable'));
  }
  return { application: response, expectedVersion: application.current_version };
}

function nextVersionForBinding(response: JsonObject, applicationId: string, previousVersion: number): number {
  const application = response.application;
  const draft = response.draft;
  if (!isJsonObject(application) || !isJsonObject(draft)
      || application.application_id !== applicationId
      || typeof application.current_version !== 'number'
      || !Number.isInteger(application.current_version)
      || application.current_version !== previousVersion + 1
      || draft.version !== application.current_version) {
    throw new Error('atomic material binding returned an inconsistent draft version');
  }
  return application.current_version;
}

async function bindInspectedMaterial(
  userId: string,
  agentId: string,
  applicationId: string,
  expectedVersion: number,
  inspected: InspectedMaterial,
): Promise<{ response: JsonObject; material: ExpenseMaterialSummary; nextVersion: number }> {
  const mutationId = `material-${crypto.randomBytes(16).toString('hex')}`;
  const payload: JsonObject = {
    application_id: applicationId,
    expected_version: expectedVersion,
    mutation_id: mutationId,
    material: {
      name: inspected.name,
      media_type: inspected.mediaType,
      data_base64: inspected.content.toString('base64'),
      material_category: MATERIAL_CATEGORY,
    },
  };
  let firstError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await callExpenseWorkbench(
        userId, agentId, 'materials.addAndBind', payload,
      );
      const material = validateExpenseMaterialRegistration(response, {
        name: inspected.name,
        media_type: inspected.mediaType,
        size: inspected.content.length,
        sha256: inspected.sha256,
      });
      return {
        response,
        material,
        nextVersion: nextVersionForBinding(response, applicationId, expectedVersion),
      };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (attempt === 0) {
        firstError = error;
        continue;
      }
      throw new Error('atomic material binding failed after an idempotent retry', {
        cause: new AggregateError(firstError ? [firstError, error] : [error]),
      });
    }
  }
  throw new Error('atomic material binding retry loop terminated unexpectedly');
}

export async function addAndBindExpenseMaterialsFromPaths(
  userId: string,
  agentId: string,
  applicationId: string,
  selectedPaths: readonly string[],
  target?: ExpenseMaterialTarget,
): Promise<AddAndBindExpenseMaterialsResult> {
  if (selectedPaths.length > MAX_EXPENSE_MATERIAL_FILES) {
    throw new Error(t('expense_workbench.material.too_many', { count: MAX_EXPENSE_MATERIAL_FILES }));
  }
  const currentTarget = target ?? await assertExpenseMaterialTarget(userId, agentId, applicationId);
  let application = currentTarget.application;
  let expectedVersion = currentTarget.expectedVersion;
  const materials: ExpenseMaterialSummary[] = [];
  const failed: ExpenseMaterialFailure[] = [];
  for (const filePath of selectedPaths) {
    try {
      const inspected = await inspectExpenseMaterial(filePath);
      const bound = await bindInspectedMaterial(
        userId, agentId, applicationId, expectedVersion, inspected,
      );
      application = bound.response;
      expectedVersion = bound.nextVersion;
      materials.push(bound.material);
    } catch (error) {
      failed.push({
        name: failureName(filePath),
        error: error instanceof MaterialImportError
          ? materialErrorMessage(error.errorCode)
          : t('expense_workbench.material.registration_failed'),
      });
    }
  }
  return { materials, failed, application };
}
