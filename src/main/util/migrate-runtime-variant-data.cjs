'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER_FILENAME = '.migrated-runtime-variant-data.json';
const USER_ID_RE = /^[A-Za-z0-9_-]+$/;

function migrateRuntimeVariantData(input) {
  if (!input || typeof input !== 'object') throw new TypeError('runtime variant migration input is required');
  const sourceContainer = validateDirectoryPath(input.sourceContainer, 'sourceContainer');
  const destinationContainer = validateDirectoryPath(input.destinationContainer, 'destinationContainer');
  const sourceVariant = typeof input.sourceVariant === 'string' ? input.sourceVariant.trim() : '';
  if (!sourceVariant) throw new TypeError('sourceVariant is required');
  if (sourceContainer === destinationContainer) throw new Error('runtime variant migration source and destination must differ');

  const sourceData = path.join(sourceContainer, 'data');
  const destinationData = path.join(destinationContainer, 'data');
  const markerPath = path.join(destinationContainer, MARKER_FILENAME);
  if (isFile(markerPath)) return { migrated: false, sourceUserIds: [] };

  const sourceRegistry = readRegistry(path.join(sourceData, 'users.json'));
  if (!sourceRegistry || sourceRegistry.users.length === 0) return { migrated: false, sourceUserIds: [] };

  fs.mkdirSync(destinationData, { recursive: true });
  const destinationRegistry = readRegistry(path.join(destinationData, 'users.json')) || {
    current_user_id: '',
    dev_current_user_id: '',
    users: [],
  };
  const sourceUserIds = sourceRegistry.users.map((user) => user.user_id);
  for (const uid of sourceUserIds) {
    const sourceUserRoot = path.join(sourceData, uid);
    if (!isDirectory(sourceUserRoot)) continue;
    const destinationUserRoot = path.join(destinationData, uid);
    if (!isDirectory(destinationUserRoot)) {
      fs.cpSync(sourceUserRoot, destinationUserRoot, { recursive: true, force: false, errorOnExist: false });
    } else {
      copyMissingEntries(sourceUserRoot, destinationUserRoot);
    }
  }

  const usersById = new Map(destinationRegistry.users.map((user) => [user.user_id, user]));
  for (const user of sourceRegistry.users) {
    if (!usersById.has(user.user_id)) usersById.set(user.user_id, user);
  }
  const users = Array.from(usersById.values()).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const sourceActive = validUserId(sourceRegistry.dev_current_user_id)
    ? sourceRegistry.dev_current_user_id
    : sourceRegistry.current_user_id;
  const mergedRegistry = {
    current_user_id: users.some((user) => user.user_id === destinationRegistry.current_user_id)
      ? destinationRegistry.current_user_id
      : (validUserId(sourceRegistry.current_user_id) ? sourceRegistry.current_user_id : sourceActive),
    dev_current_user_id: users.some((user) => user.user_id === sourceActive)
      ? sourceActive
      : (destinationRegistry.dev_current_user_id || destinationRegistry.current_user_id),
    users,
  };
  writeJsonAtomic(path.join(destinationData, 'users.json'), mergedRegistry);
  writeJsonAtomic(markerPath, {
    migration: 'runtime-variant-data',
    source_variant: sourceVariant,
    source_container: sourceContainer,
    migrated_at: new Date().toISOString(),
    source_user_ids: sourceUserIds,
  });
  return { migrated: true, sourceUserIds, activeUserId: mergedRegistry.dev_current_user_id };
}

function validateDirectoryPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return path.resolve(value);
}

function validUserId(value) {
  return typeof value === 'string' && USER_ID_RE.test(value);
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function readRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.users)) return null;
    const users = parsed.users.filter((user) => (
      user && typeof user === 'object' && validUserId(user.user_id) && typeof user.created_at === 'string'
    )).map((user) => ({ user_id: user.user_id, created_at: user.created_at }));
    return {
      current_user_id: validUserId(parsed.current_user_id) ? parsed.current_user_id : '',
      dev_current_user_id: validUserId(parsed.dev_current_user_id) ? parsed.dev_current_user_id : '',
      users,
    };
  } catch {
    return null;
  }
}

function copyMissingEntries(source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      if (!isDirectory(destinationPath)) fs.mkdirSync(destinationPath, { recursive: true });
      copyMissingEntries(sourcePath, destinationPath);
    } else if (!fs.existsSync(destinationPath)) {
      fs.cpSync(sourcePath, destinationPath, { recursive: false, force: false, errorOnExist: false });
    }
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

module.exports = { migrateRuntimeVariantData };
