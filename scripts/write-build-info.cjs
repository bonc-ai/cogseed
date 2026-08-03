#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const channelArg = process.argv.find((arg) => arg.startsWith('--channel='));
const channel = (channelArg ? channelArg.slice('--channel='.length) : process.env.ORKAS_BUILD_CHANNEL) || 'packaged-dev';
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
const commit = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
const info = { channel, commit, dirty, builtAt: new Date().toISOString() };
const dir = path.join(root, '.build');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(info)}\n`);
