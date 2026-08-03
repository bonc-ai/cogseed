#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const brand = require('../src/resources/brand.json');

const RUNTIME_VARIANTS = Object.freeze(['main', 'cognition', 'expense', 'integration']);
const LABELS = Object.freeze({
  main: 'Main',
  cognition: 'Cognition',
  expense: 'Expense',
  integration: 'Integration',
});
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
const MAIN_EXECUTABLE = path.join('Contents', 'MacOS', 'Electron');
const REQUIRED_RUNTIME_EXECUTABLES = Object.freeze([
  path.join('Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
  path.join('Contents', 'Frameworks', 'Electron Helper.app', 'Contents', 'MacOS', 'Electron Helper'),
  path.join('Contents', 'Frameworks', 'Electron Helper (GPU).app', 'Contents', 'MacOS', 'Electron Helper (GPU)'),
  path.join('Contents', 'Frameworks', 'Electron Helper (Renderer).app', 'Contents', 'MacOS', 'Electron Helper (Renderer)'),
]);

function sourceRuntimeIdentity(value) {
  if (typeof value !== 'string' || !RUNTIME_VARIANTS.includes(value)) {
    throw new Error(`invalid source runtime variant ${JSON.stringify(value)}; expected ${RUNTIME_VARIANTS.join('|')}`);
  }
  return Object.freeze({
    variant: value,
    appName: `${brand.appName} [${LABELS[value]}]`,
    appId: `${brand.appId}.source.${value}`,
    protocolOwner: value === 'integration',
  });
}

function sourceRuntimeBundleSpec(value) {
  const identity = sourceRuntimeIdentity(value);
  return Object.freeze({
    ...identity,
    protocolSchemes: identity.protocolOwner
      ? Object.freeze([brand.protocolScheme, brand.legacyConnectorScheme])
      : Object.freeze([]),
  });
}

function runChecked(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || `exit ${result.status}`).trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
}

function runForOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.error || result.status !== 0 ? null : String(result.stdout || '').trim();
}

function currentAppFromPathFile(distDir, pathFile) {
  let relative = '';
  try { relative = fs.readFileSync(pathFile, 'utf8').trim(); } catch { return ''; }
  const suffix = '/Contents/MacOS/Electron';
  const normalized = relative.replaceAll('\\', '/');
  if (!normalized.endsWith(suffix)) return '';
  const appRelative = normalized.slice(0, -suffix.length);
  const candidate = path.resolve(distDir, appRelative);
  const relativeToDist = path.relative(path.resolve(distDir), candidate);
  if (!relativeToDist || relativeToDist.startsWith('..') || path.isAbsolute(relativeToDist)) return '';
  return fs.existsSync(candidate) ? candidate : '';
}

function findSourceApp(distDir, pathFile) {
  for (const name of ['Electron.app', 'Orkas.app', `${brand.appName}.app`]) {
    const candidate = path.join(distDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  const current = currentAppFromPathFile(distDir, pathFile);
  if (current) return current;
  throw new Error('Electron macOS application bundle is unavailable');
}

function replacePlistString(plist, key, value) {
  runChecked('plutil', ['-replace', key, '-string', value, plist], `set ${key}`);
}

function configureProtocols(plist, schemes) {
  spawnSync('plutil', ['-remove', 'CFBundleURLTypes', plist], { encoding: 'utf8' });
  if (schemes.length === 0) return;
  const urlTypes = JSON.stringify([{
    CFBundleURLName: `${brand.appId}.connectors`,
    CFBundleURLSchemes: schemes,
  }]);
  runChecked('plutil', ['-insert', 'CFBundleURLTypes', '-json', urlTypes, plist], 'declare connector callback protocols');
}

function readPlistString(plist, key) {
  return runForOutput('plutil', ['-extract', key, 'raw', '-o', '-', plist]);
}

function readProtocolSchemes(plist) {
  const raw = runForOutput('plutil', ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', plist]);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.CFBundleURLSchemes)) return null;
    return parsed[0].CFBundleURLSchemes.filter((value) => typeof value === 'string');
  } catch {
    return null;
  }
}

function executableFileIsUsable(file, requireDirectFile = false) {
  try {
    const entry = fs.lstatSync(file);
    if (requireDirectFile && !entry.isFile()) return false;
    const target = requireDirectFile ? entry : fs.statSync(file);
    return target.isFile() && (target.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function bundleRuntimeFilesAreUsable(destination) {
  if (!executableFileIsUsable(path.join(destination, MAIN_EXECUTABLE), true)) return false;
  return REQUIRED_RUNTIME_EXECUTABLES.every((relative) => (
    executableFileIsUsable(path.join(destination, relative))
  ));
}

function bundleIsCurrent(destination, identity, electronVersion) {
  const plist = path.join(destination, 'Contents', 'Info.plist');
  const stamp = `${destination}.runtime.json`;
  if (!fs.existsSync(plist) || !bundleRuntimeFilesAreUsable(destination)) return false;
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(stamp, 'utf8')); } catch { return false; }
  return metadata?.schema_version === 1
    && metadata?.variant === identity.variant
    && metadata?.electron_version === electronVersion
    && readPlistString(plist, 'CFBundleIdentifier') === identity.appId
    && readPlistString(plist, 'CFBundleName') === identity.appName
    && readPlistString(plist, 'CFBundleDisplayName') === identity.appName
    && JSON.stringify(readProtocolSchemes(plist)) === JSON.stringify(identity.protocolSchemes);
}

function prepareSourceRuntimeBundle(options = {}) {
  const identity = sourceRuntimeBundleSpec(options.variant);
  if ((options.platform || process.platform) !== 'darwin') return { ...identity, appBundle: null };

  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const electronDir = path.join(root, 'node_modules', 'electron');
  const distDir = path.join(electronDir, 'dist');
  const pathFile = path.join(electronDir, 'path.txt');
  const destination = path.join(distDir, `${identity.appName}.app`);
  const electronVersion = fs.readFileSync(path.join(distDir, 'version'), 'utf8').trim();
  const executableRelative = `${identity.appName}.app/Contents/MacOS/Electron`;

  if (bundleIsCurrent(destination, identity, electronVersion)) {
    fs.writeFileSync(pathFile, executableRelative, 'utf8');
    return { ...identity, appBundle: destination };
  }

  const source = findSourceApp(distDir, pathFile);
  if (source !== destination) {
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  }

  const plist = path.join(destination, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) throw new Error('Electron macOS application bundle has no Info.plist');
  replacePlistString(plist, 'CFBundleIdentifier', identity.appId);
  replacePlistString(plist, 'CFBundleName', identity.appName);
  replacePlistString(plist, 'CFBundleDisplayName', identity.appName);
  configureProtocols(plist, identity.protocolSchemes);
  runChecked('codesign', ['--force', '--deep', '--sign', '-', destination], 'ad-hoc sign source runtime');
  fs.writeFileSync(`${destination}.runtime.json`, `${JSON.stringify({
    schema_version: 1,
    variant: identity.variant,
    electron_version: electronVersion,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(pathFile, executableRelative, 'utf8');
  if (fs.existsSync(LSREGISTER)) {
    runChecked(LSREGISTER, ['-f', destination], 'register source runtime with Launch Services');
  }
  return { ...identity, appBundle: destination };
}

function parseVariant(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--variant') {
      if (index + 1 >= argv.length) throw new Error('--variant requires a value');
      values.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith('--variant=')) {
      values.push(argument.slice('--variant='.length));
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (values.length !== 1) throw new Error('exactly one --variant is required');
  return sourceRuntimeIdentity(values[0]).variant;
}

function parseIntegrationWorktreeVariant(argv) {
  const variant = parseVariant(argv);
  if (variant !== 'integration') {
    throw new Error('this source worktree is locked to the integration runtime variant');
  }
  return variant;
}

function main() {
  try {
    const result = prepareSourceRuntimeBundle({ variant: parseIntegrationWorktreeVariant(process.argv.slice(2)) });
    if (result.appBundle) console.log(`[Mate Agent] Prepared source runtime bundle: ${result.appName}`);
  } catch (error) {
    console.error(`[Mate Agent] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  RUNTIME_VARIANTS,
  sourceRuntimeIdentity,
  sourceRuntimeBundleSpec,
  currentAppFromPathFile,
  bundleIsCurrent,
  parseVariant,
  parseIntegrationWorktreeVariant,
  prepareSourceRuntimeBundle,
};
