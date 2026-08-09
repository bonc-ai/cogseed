'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BUILTIN_MANIFEST_NAME = '_manifest.json';
const BUILTIN_MANIFEST_SCHEMA = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {{ path: string, bytes: number, sha256: string }} BuiltinManifestFile
 * @typedef {{ allowIgnoredJunk?: boolean }} BuiltinManifestOptions
 * @typedef {{ schema: number, content_tree_sha256: string, files: BuiltinManifestFile[] }} BuiltinContentManifest
 */

/** @param {string} value */
function slash(value) {
  return value.split(path.sep).join('/');
}

/** @param {string} relativePath */
function isIgnoredJunk(relativePath) {
  const parts = slash(relativePath).split('/');
  const name = parts.at(-1) || '';
  return name === '.DS_Store' || name.endsWith('.pyc') || parts.includes('__pycache__');
}

/**
 * @param {unknown} options
 * @returns {{ allowIgnoredJunk: boolean }}
 */
function normalizeOptions(options) {
  if (options === undefined) return { allowIgnoredJunk: false };
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('[builtin-content-manifest] options must be an object');
  }
  const candidate = /** @type {{ allowIgnoredJunk?: unknown }} */ (options);
  if (candidate.allowIgnoredJunk !== undefined && typeof candidate.allowIgnoredJunk !== 'boolean') {
    throw new TypeError('[builtin-content-manifest] allowIgnoredJunk must be a boolean');
  }
  return { allowIgnoredJunk: candidate.allowIgnoredJunk === true };
}

/**
 * @param {string} label
 * @param {string} target
 * @param {'directory' | 'file'} kind
 * @returns {fs.Stats}
 */
function requiredEntry(label, target, kind) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw new Error(`[builtin-content-manifest] missing ${label}: ${target}`);
    }
    throw new Error(
      `[builtin-content-manifest] cannot inspect ${label}: ${target}: ${/** @type {Error} */ (error).message}`,
      { cause: error },
    );
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`[builtin-content-manifest] symbolic links are not allowed: ${target}`);
  }
  if ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    throw new Error(`[builtin-content-manifest] missing ${label}: ${target}`);
  }
  return stat;
}

/**
 * @param {string} label
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readObjectJson(label, file) {
  const stat = requiredEntry(label, file, 'file');
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`[builtin-content-manifest] ${label} exceeds ${MAX_MANIFEST_BYTES} bytes: ${file}`);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      `[builtin-content-manifest] cannot read ${label}: ${file}: ${/** @type {Error} */ (error).message}`,
      { cause: error },
    );
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('root value must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `[builtin-content-manifest] invalid ${label}: ${file}: ${/** @type {Error} */ (error).message}`,
      { cause: error },
    );
  }
}

/** @param {Buffer | string} bytes */
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {unknown} files
 * @returns {BuiltinManifestFile[]}
 */
function validateManifestFiles(files) {
  if (!Array.isArray(files)) {
    throw new Error('[builtin-content-manifest] builtin manifest files must be an array');
  }
  /** @type {BuiltinManifestFile[]} */
  const validated = [];
  let previousPath = '';
  for (let index = 0; index < files.length; index += 1) {
    const raw = files[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`[builtin-content-manifest] invalid builtin manifest file row at index ${index}`);
    }
    const row = /** @type {{ path?: unknown, bytes?: unknown, sha256?: unknown }} */ (raw);
    const keys = Object.keys(row).sort();
    if (keys.length !== 3 || keys[0] !== 'bytes' || keys[1] !== 'path' || keys[2] !== 'sha256') {
      throw new Error(`[builtin-content-manifest] invalid builtin manifest file fields at index ${index}`);
    }
    if (typeof row.path !== 'string'
        || !row.path
        || row.path.includes('\\')
        || row.path.includes('\0')
        || path.posix.isAbsolute(row.path)
        || path.posix.normalize(row.path) !== row.path
        || row.path === '.'
        || row.path === BUILTIN_MANIFEST_NAME) {
      throw new Error(`[builtin-content-manifest] invalid builtin manifest path at index ${index}`);
    }
    if (index > 0 && previousPath.localeCompare(row.path) >= 0) {
      throw new Error('[builtin-content-manifest] builtin manifest paths must be unique and sorted');
    }
    if (!Number.isSafeInteger(row.bytes) || /** @type {number} */ (row.bytes) < 0) {
      throw new Error(`[builtin-content-manifest] invalid builtin manifest byte count for ${row.path}`);
    }
    if (typeof row.sha256 !== 'string' || !SHA256_PATTERN.test(row.sha256)) {
      throw new Error(`[builtin-content-manifest] invalid builtin manifest sha256 for ${row.path}`);
    }
    const validRow = {
      path: row.path,
      bytes: /** @type {number} */ (row.bytes),
      sha256: row.sha256,
    };
    validated.push(validRow);
    previousPath = validRow.path;
  }
  return validated;
}

/**
 * @param {string} root
 * @param {BuiltinManifestOptions} [options]
 * @returns {BuiltinManifestFile[]}
 */
function collectBuiltinFiles(root, options = {}) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new TypeError('[builtin-content-manifest] builtin root must be a non-empty string');
  }
  const normalizedOptions = normalizeOptions(options);
  const resolvedRoot = path.resolve(root);
  requiredEntry('builtin root', resolvedRoot, 'directory');
  /** @type {BuiltinManifestFile[]} */
  const records = [];

  /** @param {string} dir */
  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(
        `[builtin-content-manifest] cannot enumerate builtin directory: ${dir}: ${/** @type {Error} */ (error).message}`,
        { cause: error },
      );
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relativePath = slash(path.relative(resolvedRoot, absolute));
      if (relativePath === BUILTIN_MANIFEST_NAME) continue;
      if (normalizedOptions.allowIgnoredJunk && isIgnoredJunk(relativePath)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`[builtin-content-manifest] symbolic links are not allowed: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`[builtin-content-manifest] unsupported filesystem entry: ${absolute}`);
      }
      let bytes;
      try {
        bytes = fs.readFileSync(absolute);
      } catch (error) {
        throw new Error(
          `[builtin-content-manifest] cannot read builtin file: ${absolute}: ${/** @type {Error} */ (error).message}`,
          { cause: error },
        );
      }
      records.push({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }

  visit(resolvedRoot);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * @param {unknown} files
 * @returns {string}
 */
function contentTreeSha256(files) {
  const validated = validateManifestFiles(files);
  const hash = crypto.createHash('sha256');
  for (const file of validated) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Verifies the release manifest against every file before returning any
 * manifest metadata to runtime callers.
 *
 * @param {string} root
 * @param {BuiltinManifestOptions} [options]
 * @returns {BuiltinContentManifest & Record<string, unknown>}
 */
function verifyBuiltinContentManifest(root, options = {}) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new TypeError('[builtin-content-manifest] builtin root must be a non-empty string');
  }
  const resolvedRoot = path.resolve(root);
  const manifestFile = path.join(resolvedRoot, BUILTIN_MANIFEST_NAME);
  const rawManifest = readObjectJson('builtin content manifest', manifestFile);
  if (rawManifest.schema !== BUILTIN_MANIFEST_SCHEMA) {
    throw new Error(`[builtin-content-manifest] unsupported builtin manifest schema: ${String(rawManifest.schema)}`);
  }
  if (typeof rawManifest.content_tree_sha256 !== 'string'
      || !SHA256_PATTERN.test(rawManifest.content_tree_sha256)) {
    throw new Error('[builtin-content-manifest] builtin manifest has an invalid content tree sha256');
  }
  const declaredFiles = validateManifestFiles(rawManifest.files);
  const declaredTreeHash = contentTreeSha256(declaredFiles);
  if (declaredTreeHash !== rawManifest.content_tree_sha256) {
    throw new Error('[builtin-content-manifest] builtin manifest file rows do not match its content tree sha256');
  }
  const actualFiles = collectBuiltinFiles(resolvedRoot, options);
  const actualTreeHash = contentTreeSha256(actualFiles);
  if (rawManifest.content_tree_sha256 !== actualTreeHash
      || JSON.stringify(declaredFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(
      `[builtin-content-manifest] builtin content tree mismatch: manifest=${rawManifest.content_tree_sha256} actual=${actualTreeHash}`,
    );
  }
  return /** @type {BuiltinContentManifest & Record<string, unknown>} */ ({
    ...rawManifest,
    files: declaredFiles,
  });
}

module.exports = {
  BUILTIN_MANIFEST_NAME,
  BUILTIN_MANIFEST_SCHEMA,
  collectBuiltinFiles,
  contentTreeSha256,
  verifyBuiltinContentManifest,
};
