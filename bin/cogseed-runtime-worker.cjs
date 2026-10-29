#!/usr/bin/env node
'use strict';

const path = require('node:path');

const pcDir = process.env.COGSEED_PC_DIR || path.resolve(__dirname, '..');
require(require.resolve('tsx/cjs', { paths: [pcDir] }));

// This child runs with ELECTRON_RUN_AS_NODE=1, where the `electron` package
// cannot be resolved (it is a devDependency and is not shipped). Host modules
// in the entry's import graph still do `import { app } from 'electron'`, so
// alias the bare specifier to the inert stand-in shipped alongside this file.
// Installed AFTER tsx so this hook is outermost and sees the request first.
const Module = require('node:module');
const electronStub = path.join(__dirname, 'child-electron-stub.cjs');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return resolveFilename.call(this, request, ...rest);
};

require(path.join(pcDir, 'src/main/features/cogseed_runtime/worker-entry.ts'));
