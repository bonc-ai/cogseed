#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const ts = require('typescript');

const SCHEMA_VERSION = 1;
const DEFAULT_SOURCE_DIR = path.join('src', 'renderer', 'modules');
const DEFAULT_OUTPUT = path.join('src', 'renderer-app', 'ipc', 'contract.generated.json');

function parseArgs(argv) {
  const args = { write: false, check: false, rootDir: process.cwd(), sourceDir: DEFAULT_SOURCE_DIR, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') args.write = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--root') args.rootDir = path.resolve(argv[++index]);
    else if (arg === '--source-dir') args.sourceDir = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.write && args.check) throw new Error('Choose only one of --write or --check');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/capture-ipc-contract.cjs [--write|--check] [options]\n\nOptions:\n  --root <dir>        Repository root (default: cwd)\n  --source-dir <dir> Source directory relative to root (default: ${DEFAULT_SOURCE_DIR})\n  --output <file>     Snapshot path relative to root (default: ${DEFAULT_OUTPUT})\n  --write             Write the canonical snapshot\n  --check             Compare against the canonical snapshot\n`);
}

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function getPropertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function isWindowCogSeed(expression) {
  if (!expression) return false;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  return getPropertyName(expression.name) === 'cogseed' && ts.isIdentifier(expression.expression) && expression.expression.text === 'window';
}

function isBridgeAccess(expression) {
  if (!expression || !ts.isPropertyAccessExpression(expression)) return null;
  const kind = getPropertyName(expression.name);
  if (kind !== 'invoke' && kind !== 'stream') return null;
  return isWindowCogSeed(expression.expression) ? kind : null;
}

function getBridgeKind(call) {
  const direct = isBridgeAccess(call.expression);
  if (direct) return direct;
  // TypeScript represents optional calls as a property access with a
  // questionDotToken on either the access or the call; the same receiver
  // shape is still available through call.expression.
  return null;
}

function getStaticChannel(argument) {
  if (!argument) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  return null;
}

function captureIpcContract({ rootDir = process.cwd(), sourceDir = DEFAULT_SOURCE_DIR, baselineCommit } = {}) {
  const absoluteSourceDir = path.resolve(rootDir, sourceDir);
  const files = listJavaScriptFiles(absoluteSourceDir);
  const callsites = [];

  for (const filePath of files) {
    const relativeFile = path.relative(rootDir, filePath).split(path.sep).join('/');
    const source = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const kind = getBridgeKind(node);
        if (kind) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const channel = getStaticChannel(node.arguments[0]);
          callsites.push({
            file: relativeFile,
            line: location.line + 1,
            column: location.character + 1,
            kind,
            channel,
            argumentCount: node.arguments.length,
            payloadNodeKind: node.arguments[1] ? ts.SyntaxKind[node.arguments[1].kind] : null,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  callsites.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column);
  const staticChannels = new Set(callsites.filter((call) => call.channel !== null).map((call) => call.channel));
  const invokeChannels = new Set(callsites.filter((call) => call.kind === 'invoke' && call.channel !== null).map((call) => call.channel));
  const streamChannels = new Set(callsites.filter((call) => call.kind === 'stream' && call.channel !== null).map((call) => call.channel));

  return {
    schemaVersion: SCHEMA_VERSION,
    baselineCommit: baselineCommit || getBaselineCommit(rootDir),
    totals: {
      calls: callsites.length,
      staticCalls: callsites.filter((call) => call.channel !== null).length,
      dynamicCalls: callsites.filter((call) => call.channel === null).length,
      uniqueStaticChannels: staticChannels.size,
      invokeChannels: invokeChannels.size,
      streamChannels: streamChannels.size,
    },
    callsites,
  };
}

function getBaselineCommit(rootDir) {
  try {
    return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function run(options) {
  if (options.help) {
    printHelp();
    return;
  }
  const snapshot = captureIpcContract({ rootDir: options.rootDir, sourceDir: options.sourceDir });
  const outputPath = path.resolve(options.rootDir, options.output);
  const serialized = canonicalJson(snapshot);
  if (options.write) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized);
    console.log(`[capture-ipc-contract] wrote ${path.relative(options.rootDir, outputPath)} (${snapshot.totals.calls} calls)`);
    return;
  }
  if (options.check) {
    if (!fs.existsSync(outputPath)) throw new Error(`Missing snapshot: ${path.relative(options.rootDir, outputPath)}`);
    const expected = fs.readFileSync(outputPath, 'utf8');
    if (expected !== serialized) {
      console.error(`[capture-ipc-contract] drift detected in ${path.relative(options.rootDir, outputPath)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[capture-ipc-contract] check passed (${snapshot.totals.calls} calls)`);
    return;
  }
  process.stdout.write(serialized);
}

if (require.main === module) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[capture-ipc-contract] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { captureIpcContract, run };
