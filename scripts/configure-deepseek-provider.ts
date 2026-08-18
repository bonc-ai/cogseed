#!/usr/bin/env tsx
/**
 * Provision a DeepSeek (OpenAI-protocol) custom provider into the
 * active user's encrypted auth-profiles.json.
 *
 * Uses the app's own `addCustomProvider` so the stored schema (ProfilesFile v6)
 * and the chat-dispatch entry binding stay correct. Read-only by default;
 * pass `--apply` to write.
 *
 * Usage:
 *   ORKAS_WORKSPACE_ROOT="$HOME/.cogseed/runtime-variants/cogseed/data" \
 *     DEEPSEEK_API_KEY="sk-..." \
 *     npx tsx scripts/configure-deepseek-provider.ts [--apply]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activateUser } from '../src/main/features/users';
import { addCustomProvider, listCustomProviders } from '../src/main/features/custom_providers';

const APPLY = process.argv.includes('--apply');
const wsRoot = process.env.ORKAS_WORKSPACE_ROOT;
if (!wsRoot) {
  console.error('ORKAS_WORKSPACE_ROOT not set. Run with ORKAS_WORKSPACE_ROOT=<data dir>.');
  process.exit(2);
}
if (!BASE_URL) {
  console.error('DEEPSEEK_BASE_URL not set. Run with DEEPSEEK_BASE_URL=<gateway>/v1.');
  process.exit(2);
}

const BASE_URL = (process.env.DEEPSEEK_BASE_URL || '').trim();
const API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();

const registry = JSON.parse(fs.readFileSync(path.join(wsRoot, 'users.json'), 'utf8'));
const uid = registry.dev_current_user_id || registry.current_user_id;
if (!uid) {
  console.error('no active user in users.json');
  process.exit(2);
}
activateUser(uid);
console.log(`active uid: ${uid}`);
console.log(`target baseUrl: ${BASE_URL}`);

const providers = listCustomProviders(uid);
console.log(`existing custom providers: ${providers.length}`);
for (const p of providers) {
  console.log(`  - [${p.id}] ${p.name} (${p.protocol}) ${p.baseUrl} enabled=${p.enabled} models=${p.models.map((m) => m.id).join(',')}`);
}

const existing = providers.find((p) => p.baseUrl === BASE_URL);
if (existing) {
  console.log(`provider already exists: ${existing.id} ${existing.name} — nothing to do (idempotent).`);
  process.exit(0);
}

const draft = {
  name: 'DeepSeek',
  protocol: 'openai',
  baseUrl: BASE_URL,
  apiKey: API_KEY || '<DEEPSEEK_API_KEY>',
  notes: 'DeepSeek 网关（经 DEEPSEEK_BASE_URL 指定）',
  models: [
    { id: 'deepseek-v4-pro', contextWindow: 1024000, maxTokens: 8192 },
    { id: 'deepseek-v4-flash', contextWindow: 1024000, maxTokens: 8192 },
  ],
};

if (!APPLY) {
  console.log('\nno DeepSeek provider yet. Run with --apply to add:');
  console.log(JSON.stringify(draft, null, 2));
  process.exit(0);
}

if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY not set — refusing to write an empty key.');
  process.exit(2);
}

const res = addCustomProvider(uid, { ...draft, apiKey: API_KEY }, 'front');
if (!res.ok) {
  console.error('add failed:', (res as { error: string }).error);
  process.exit(1);
}
console.log('added provider:', res.id);

const after = listCustomProviders(uid).find((p) => p.id === (res as { id: string }).id);
console.log('verification:', JSON.stringify(after, null, 2));