#!/usr/bin/env node
'use strict';

const path = require('node:path');

const pcDir = process.env.COGSEED_PC_DIR || path.resolve(__dirname, '..');
require(require.resolve('tsx/cjs', { paths: [pcDir] }));
require(path.join(pcDir, 'src/main/features/kb_embed_worker_entry.ts'));
