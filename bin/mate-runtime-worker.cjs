#!/usr/bin/env node
'use strict';

const path = require('node:path');

const pcDir = process.env.ORKAS_PC_DIR || path.resolve(__dirname, '..');
require(require.resolve('tsx/cjs', { paths: [pcDir] }));
require(path.join(pcDir, 'src/main/features/mate_agent_runtime/worker-entry.ts'));
