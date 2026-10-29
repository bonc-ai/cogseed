'use strict';

// Source launch metadata only. Never loaded by packaged bootstrap.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { selectRuntimeVariant } = require('../../src/main/install-data-root.cjs');

function sourceLaunchConfig(root, env = process.env) {
  const owner = fs.realpathSync(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(owner, 'package.json'), 'utf8'));
  const identity = JSON.parse(fs.readFileSync(path.join(owner, 'src/resources/identity.json'), 'utf8'));
  if (pkg.main !== 'bootstrap.cjs' || identity.runtimeVariant !== 'cogseed' || identity.envPrefix !== 'COGSEED') {
    throw new Error('unsupported source identity contract');
  }
  const variant = selectRuntimeVariant({ sourceVariant: pkg.cogseedSourceRuntimeVariant });
  for (const key of ['COGSEED_RUNTIME_VARIANT', 'COGSEED_SOURCE_RUNTIME_VARIANT']) {
    if (env[key] && env[key] !== variant) {
      throw new Error(`source runtime is locked to ${variant}; ${key}=${env[key]} is not allowed`);
    }
  }
  if (env.COGSEED_WORKSPACE_ROOT) throw new Error('inherited COGSEED_WORKSPACE_ROOT is not allowed');
  if (env.NODE_OPTIONS) throw new Error('inherited NODE_OPTIONS is not allowed in the source launcher');
  const args = [];
  const address = env.COGSEED_DEV_DEBUG_ADDRESS;
  if (address && address !== '127.0.0.1') throw new Error('dev debug address must be 127.0.0.1');
  const ports = ['COGSEED_DEV_CDP_PORT', 'COGSEED_DEV_INSPECT_PORT'].map(key => {
    const value = env[key];
    if (!value) return undefined;
    if (!/^[1-9][0-9]{3,4}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
      throw new Error(`${key} must be a decimal port from 1024 to 65535`);
    }
    return value;
  });
  if (ports.some(Boolean)) {
    if ((env.COGSEED_BUILD_CHANNEL || 'dev') !== 'dev' || (pkg.cogseedBuildChannel && pkg.cogseedBuildChannel !== 'dev') || owner.includes('.asar')) {
      throw new Error('debug ports are available only for source dev launches');
    }
    if (ports[0] && ports[0] === ports[1]) throw new Error('CDP and inspector ports must be different');
    if (ports[1]) args.push(`--inspect=127.0.0.1:${ports[1]}`);
    if (ports[0]) args.push('--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${ports[0]}`);
  }
  const { appName } = require('../prepare-source-runtime.cjs').sourceRuntimeIdentity(variant);
  const key = createHash('sha256').update(owner).digest('hex').slice(0, 16);
  return { variant, appName, runLog: path.join(os.tmpdir(), `cogseed-${variant}-${key}-run.log`), args };
}

if (require.main === module) {
  try {
    const config = sourceLaunchConfig(process.argv[2]);
    process.stdout.write([config.variant, config.appName, config.runLog, ...config.args].join('\n') + '\n');
  } catch (error) {
    process.stderr.write(`[CogSeed] ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { sourceLaunchConfig };
