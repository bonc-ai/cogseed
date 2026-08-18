const fs = require('node:fs');
const path = require('node:path');

const IDENTITY_JSON = path.join(__dirname, '../resources/identity.json');

function deepFreeze(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
}

const IDENTITY = deepFreeze(JSON.parse(fs.readFileSync(IDENTITY_JSON, 'utf8')));

function normalizeRuntimeVariant(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return IDENTITY.runtimeVariant;
  }
  const candidate = String(value).trim();
  if (candidate === IDENTITY.runtimeVariant || IDENTITY.legacyRuntimeVariants.includes(candidate)) {
    return IDENTITY.runtimeVariant;
  }
  throw new Error(
    `invalid runtime variant ${JSON.stringify(value)}; expected ${[
      IDENTITY.runtimeVariant,
      ...IDENTITY.legacyRuntimeVariants,
    ].join('|')}`,
  );
}

function normalizeEnv(env) {
  const source = env || {};
  const normalized = { ...source };
  const legacyPrefix = `${IDENTITY.legacyEnvPrefix}_`;
  const canonicalPrefix = `${IDENTITY.envPrefix}_`;

  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(legacyPrefix)) {
      continue;
    }
    const canonicalKey = `${canonicalPrefix}${key.slice(legacyPrefix.length)}`;
    const existing = normalized[canonicalKey];
    if (existing !== undefined && existing !== value) {
      throw new Error(`identity environment conflict for ${canonicalKey}`);
    }
    normalized[canonicalKey] = value;
  }

  const runtimeKey = `${canonicalPrefix}RUNTIME_VARIANT`;
  if (normalized[runtimeKey] !== undefined) {
    normalized[runtimeKey] = normalizeRuntimeVariant(normalized[runtimeKey]);
  }

  return normalized;
}

function protocolSchemes() {
  return [IDENTITY.protocolScheme, ...IDENTITY.legacyProtocolSchemes];
}

module.exports = {
  IDENTITY,
  normalizeRuntimeVariant,
  normalizeEnv,
  protocolSchemes,
};
