#!/usr/bin/env tsx
// ============================================================
// Meta-Skill Engine Self-Check
// Validates the engine's own compliance (is-a principle)
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}: ${detail}`);
  }
}

console.log('=== Meta-Skill Engine Self-Check ===\n');

// ── 1. Identity Contract ─────────────────────────────────────
console.log('📋 Identity Contract:');
const skillMd = fs.readFileSync(path.join(import.meta.dirname, '../SKILL.md'), 'utf-8');
check('SKILL.md exists', skillMd.length > 0, 'file empty');
check('skill_class: meta_skill', skillMd.includes('skill_class: meta_skill'), 'missing field');
check('is_skill_of_skill: true', skillMd.includes('is_skill_of_skill: true'), 'missing field');
check('promotion_ceiling: staged', skillMd.includes('promotion_ceiling: staged'), 'missing field');
check('production_release_allowed: false', skillMd.includes('production_release_allowed: false'), 'missing field');

// ── 2. Nine-Element Contract ────────────────────────────────
console.log('\n📋 Nine-Element Contract:');
check('Trigger Semantics', skillMd.includes('Trigger Semantics'), 'missing section');
check('Business Context Mapping', skillMd.includes('Ontology Binding') || skillMd.includes('ontology'), 'missing section');
check('Executable Workflow', skillMd.includes('capture_interaction') || skillMd.includes('Workflow'), 'missing section');
check('Tool/Resource Binding', skillMd.includes('allowed-tools') || skillMd.includes('allowed_tools'), 'missing section');
check('Validation Contract', skillMd.includes('Validation Gate') || skillMd.includes('Validation'), 'missing section');
check('Eval/Replay/Regression', skillMd.includes('Replay') || skillMd.includes('Eval'), 'missing section');
check('Failure Attribution', skillMd.includes('Attribution') || skillMd.includes('归因'), 'missing section');
check('KSTAR Evolution Hook', skillMd.includes('KSTAR') || skillMd.includes('Evolution'), 'missing section');
check('Governance Boundaries', skillMd.includes('Governance Boundaries'), 'missing section');

// ── 3. Artifact Structure ───────────────────────────────────
console.log('\n📋 Artifact Structure:');
const refDir = path.join(import.meta.dirname, '../references');
check('references/ directory exists', fs.existsSync(refDir), 'directory missing');
check('ontology-mapping.md exists', fs.existsSync(path.join(refDir, 'ontology-mapping.md')), 'file missing');
check('kstar-evolution.md exists', fs.existsSync(path.join(refDir, 'kstar-evolution.md')), 'file missing');
check('governance-boundaries.md exists', fs.existsSync(path.join(refDir, 'governance-boundaries.md')), 'file missing');

// ── 4. Source Code Modules ──────────────────────────────────
console.log('\n📋 Source Code Modules:');
const srcDir = path.join(import.meta.dirname, '../src/modules');
check('ontology-reader.ts', fs.existsSync(path.join(srcDir, 'ontology-reader.ts')), 'module missing');
check('evidence-collector.ts', fs.existsSync(path.join(srcDir, 'evidence-collector.ts')), 'module missing');
check('attribution-engine.ts', fs.existsSync(path.join(srcDir, 'attribution-engine.ts')), 'module missing');
check('patch-generator.ts', fs.existsSync(path.join(srcDir, 'patch-generator.ts')), 'module missing');
check('governance-gates.ts', fs.existsSync(path.join(srcDir, 'governance-gates.ts')), 'module missing');
check('skill-creator.ts', fs.existsSync(path.join(srcDir, 'skill-creator.ts')), 'module missing');
check('registry-manager.ts', fs.existsSync(path.join(srcDir, 'registry-manager.ts')), 'module missing');

// ── 5. Config ───────────────────────────────────────────────
console.log('\n📋 Configuration:');
const configFile = path.join(import.meta.dirname, '../src/config/engine-config.ts');
check('engine-config.ts exists', fs.existsSync(configFile), 'file missing');
if (fs.existsSync(configFile)) {
  const config = fs.readFileSync(configFile, 'utf-8');
  check('identity config', config.includes('skill_class'), 'missing identity');
  check('recursive guardrails', config.includes('max_self_patch_ops'), 'missing guardrails');
  check('edit budget', config.includes('max_operations'), 'missing edit budget');
  check('three gates', config.includes('Validation Gate'), 'missing gates');
}

// ── Summary ─────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('❌ Self-check FAILED');
  process.exit(1);
} else {
  console.log('✅ Self-check PASSED — Engine is L5 Meta-Skill compliant');
  process.exit(0);
}
