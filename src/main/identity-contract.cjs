const fs = require('node:fs');
const path = require('node:path');

const IDENTITY_JSON = path.join(__dirname, '../resources/identity.json');

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

const IDENTITY = deepFreeze(JSON.parse(fs.readFileSync(IDENTITY_JSON, 'utf8')));

function normalizeRuntimeVariant(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return IDENTITY.runtimeVariant;
  }
  const candidate = String(value).trim();
  if (candidate === IDENTITY.runtimeVariant) return candidate;
  throw new Error(
    `invalid runtime variant ${JSON.stringify(value)}; expected ${IDENTITY.runtimeVariant}`,
  );
}

function normalizeEnv(env) {
  const normalized = { ...(env || {}) };
  const runtimeKey = `${IDENTITY.envPrefix}_RUNTIME_VARIANT`;
  if (normalized[runtimeKey] !== undefined) {
    normalized[runtimeKey] = normalizeRuntimeVariant(normalized[runtimeKey]);
  }
  return normalized;
}

function protocolSchemes() {
  return [IDENTITY.protocolScheme];
}

module.exports = {
  IDENTITY,
  normalizeRuntimeVariant,
  normalizeEnv,
  protocolSchemes,
};
