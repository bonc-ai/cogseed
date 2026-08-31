#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const ts = require('typescript');
const { captureIpcContract } = require('./capture-ipc-contract.cjs');

const SCHEMA_VERSION = 1;
const DEFAULT_OUTPUT = path.join('src', 'renderer-app', 'migration', 'inventory.generated.json');
const DOM_METHODS = new Set([
  'append', 'appendChild', 'before', 'closest', 'createElement', 'createTextNode',
  'getElementById', 'getElementsByClassName', 'getElementsByName', 'getElementsByTagName',
  'insertAdjacentHTML', 'insertAdjacentElement', 'prepend', 'querySelector', 'querySelectorAll',
  'remove', 'removeChild', 'replaceChildren', 'replaceWith', 'scrollIntoView', 'setAttribute',
]);
const DOM_QUERY_METHODS = new Set([
  'getElementById', 'getElementsByClassName', 'getElementsByName', 'getElementsByTagName',
  'querySelector', 'querySelectorAll',
]);
const GLOBAL_EVENT_TARGETS = new Set(['document', 'window', 'globalThis']);
const TIMER_NAMES = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback']);
const OBSERVER_NAMES = new Set(['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver']);

function parseArgs(argv) {
  const args = { write: false, check: false, rootDir: process.cwd(), output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') args.write = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--root') args.rootDir = path.resolve(argv[++index]);
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.write && args.check) throw new Error('Choose only one of --write or --check');
  return args;
}

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) result.push(absolute);
    }
  }
  walk(directory);
  return result.sort();
}

function getPropertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function getCallName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return getPropertyName(node.expression.name);
  return null;
}

function getReceiverName(node) {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const receiver = node.expression.expression;
  return ts.isIdentifier(receiver) ? receiver.text : null;
}

function inspectModule(rootDir, filePath, ipcByFile) {
  const source = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let directDomCallCount = 0;
  let domQueryCallCount = 0;
  let globalEventRegistrations = 0;
  let timerCount = 0;
  let observerCount = 0;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callName = getCallName(node);
      const receiverName = getReceiverName(node);
      if (callName && DOM_METHODS.has(callName)) directDomCallCount += 1;
      if (callName && DOM_QUERY_METHODS.has(callName)) domQueryCallCount += 1;
      if (callName === 'addEventListener' && receiverName && GLOBAL_EVENT_TARGETS.has(receiverName)) globalEventRegistrations += 1;
      if (callName && TIMER_NAMES.has(callName) && ts.isIdentifier(node.expression)) timerCount += 1;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && OBSERVER_NAMES.has(node.expression.text)) observerCount += 1;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const relativeFile = path.relative(rootDir, filePath).split(path.sep).join('/');
  return {
    file: relativeFile,
    loc: Math.max(0, source.split(/\r?\n/).length - 1),
    directDomCallCount,
    domQueryCallCount,
    globalEventRegistrations,
    timerCount,
    observerCount,
    directIpcCallCount: ipcByFile.get(relativeFile) || 0,
  };
}

function parseIndexAssets(rootDir) {
  const indexPath = path.resolve(rootDir, 'src/renderer/index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => {
    const attributes = match[1] || '';
    const source = attributes.match(/\bsrc=["']([^"']+)["']/i);
    return source ? { type: 'external', src: source[1] } : { type: 'inline' };
  });
  const stylesheets = [...html.matchAll(/<link\b([^>]*)>/gi)]
    .map((match) => match[1] || '')
    .filter((attributes) => /\brel=["']stylesheet["']/i.test(attributes))
    .map((attributes) => attributes.match(/\bhref=["']([^"']+)["']/i)?.[1] || null)
    .filter(Boolean);
  return { scriptTags, stylesheets };
}

function getBaselineCommit(rootDir) {
  try {
    return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function captureRendererInventory({ rootDir = process.cwd(), baselineCommit } = {}) {
  const rendererDir = path.resolve(rootDir, 'src/renderer');
  const moduleDir = path.join(rendererDir, 'modules');
  const vendorDir = path.join(rendererDir, 'vendor');
  const ipcSnapshot = captureIpcContract({ rootDir, baselineCommit });
  const ipcByFile = new Map();
  for (const callsite of ipcSnapshot.callsites) ipcByFile.set(callsite.file, (ipcByFile.get(callsite.file) || 0) + 1);

  const firstPartyModules = listJavaScriptFiles(moduleDir).map((filePath) => inspectModule(rootDir, filePath, ipcByFile));
  const vendorFiles = listJavaScriptFiles(vendorDir).map((filePath) => ({
    file: path.relative(rootDir, filePath).split(path.sep).join('/'),
    loc: Math.max(0, fs.readFileSync(filePath, 'utf8').split(/\r?\n/).length - 1),
  }));
  const assets = parseIndexAssets(rootDir);
  const cssFiles = listFilesByExtension(rendererDir, '.css').map((filePath) => path.relative(rootDir, filePath).split(path.sep).join('/'));
  const total = (key) => firstPartyModules.reduce((sum, module) => sum + module[key], 0);

  return {
    schemaVersion: SCHEMA_VERSION,
    baselineCommit: baselineCommit || getBaselineCommit(rootDir),
    source: {
      rendererRoot: 'src/renderer',
      indexHtml: 'src/renderer/index.html',
    },
    totals: {
      firstPartyModules: firstPartyModules.length,
      vendorJavaScriptFiles: vendorFiles.length,
      scriptTags: assets.scriptTags.length,
      externalScriptTags: assets.scriptTags.filter((tag) => tag.type === 'external').length,
      inlineScriptTags: assets.scriptTags.filter((tag) => tag.type === 'inline').length,
      cssFiles: cssFiles.length,
      loc: total('loc') + vendorFiles.reduce((sum, file) => sum + file.loc, 0),
      firstPartyLoc: total('loc'),
      directDomCallCount: total('directDomCallCount'),
      domQueryCallCount: total('domQueryCallCount'),
      globalEventRegistrations: total('globalEventRegistrations'),
      timerCount: total('timerCount'),
      observerCount: total('observerCount'),
      directIpcCallCount: total('directIpcCallCount'),
    },
    assets: {
      scriptTags: assets.scriptTags,
      stylesheets: assets.stylesheets,
      cssFiles,
      vendorFiles,
    },
    firstPartyModules,
  };
}

function listFilesByExtension(directory, extension) {
  const result = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(extension)) result.push(absolute);
    }
  }
  walk(directory);
  return result.sort();
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function run(options) {
  if (options.help) {
    console.log('Usage: node scripts/capture-renderer-inventory.cjs [--write|--check] [--root <dir>] [--output <file>]');
    return;
  }
  const snapshot = captureRendererInventory({ rootDir: options.rootDir });
  const outputPath = path.resolve(options.rootDir, options.output);
  const serialized = canonicalJson(snapshot);
  if (options.write) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized);
    console.log(`[capture-renderer-inventory] wrote ${path.relative(options.rootDir, outputPath)}`);
    console.log(`[capture-renderer-inventory] modules=${snapshot.totals.firstPartyModules} scripts=${snapshot.totals.scriptTags} css=${snapshot.totals.cssFiles} ipc=${snapshot.totals.directIpcCallCount}`);
    return;
  }
  if (options.check) {
    if (!fs.existsSync(outputPath)) throw new Error(`Missing snapshot: ${path.relative(options.rootDir, outputPath)}`);
    if (fs.readFileSync(outputPath, 'utf8') !== serialized) {
      console.error(`[capture-renderer-inventory] drift detected in ${path.relative(options.rootDir, outputPath)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[capture-renderer-inventory] check passed`);
    return;
  }
  process.stdout.write(serialized);
}

if (require.main === module) {
  try { run(parseArgs(process.argv.slice(2))); }
  catch (error) {
    console.error(`[capture-renderer-inventory] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { captureRendererInventory, run };
