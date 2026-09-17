#!/usr/bin/env node
// Assert the packaged Electron fuse privacy baseline.
//
// The shipped binary doubles as the app's Node runtime for child processes
// (embed worker, MCP connectors, local CLI agents, p3394 gateway, kernel
// worker): the RunAsNode fuse MUST stay enabled until those spawn paths are
// migrated to the bundled runtime node binary. Everything else must match the
// privacy baseline below; CI packaging jobs run this script so a drift fails
// the build instead of silently shipping.
'use strict';

const { spawnSync } = require('node:child_process');

const EXPECTED = Object.freeze({
  // 架构依赖（子进程复用 Electron 二进制当 Node），暂不可关。
  RunAsNode: true,
  // 阻断 NODE_OPTIONS / --inspect 注入路径。
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  // 启动时校验 app.asar 完整性（配合 build.asarIntegrity）。
  EnableEmbeddedAsarIntegrityValidation: true,
  // 只允许从 asar 加载应用代码。
  OnlyLoadAppFromAsar: true,
});

function readFuses(appPath) {
  const bin = require.resolve('@electron/fuses/dist/bin.js');
  const result = spawnSync(process.execPath, [bin, 'read', '--app', appPath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`fuses read failed for ${appPath}:\n${result.stderr || result.stdout}`);
  }
  const states = {};
  for (const line of String(result.stdout).split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s+is\s+(Enabled|Disabled)/);
    if (match) states[match[1]] = match[2] === 'Enabled';
  }
  return states;
}

function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    throw new Error('usage: node scripts/check-fuses.cjs <app|exe path>...');
  }
  const failures = [];
  for (const target of targets) {
    const states = readFuses(target);
    for (const [name, want] of Object.entries(EXPECTED)) {
      if (states[name] !== want) {
        const got = states[name] === undefined ? 'unknown' : states[name] ? 'Enabled' : 'Disabled';
        failures.push(`${target}: ${name} is ${got} (expected ${want ? 'Enabled' : 'Disabled'})`);
      }
    }
  }
  if (failures.length > 0) {
    console.error(`[check-fuses] baseline violated:\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`[check-fuses] baseline OK for ${targets.length} target(s): ${targets.join(', ')}`);
}

try {
  main();
} catch (error) {
  console.error(`[check-fuses] ${error && error.message ? error.message : error}`);
  process.exit(1);
}
