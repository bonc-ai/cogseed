/**
 * CC Switch importer (phase 4, method 2A).
 *
 * Reads CC Switch's own provider store (a SQLite DB at ~/.cc-switch/
 * cc-switch.db) READ-ONLY and maps its third-party provider rows into the
 * shape `custom_providers.addCustomProvider` accepts, tagged
 * `source:'ccswitch'` + `externalId` for re-sync dedupe.
 *
 * ## Hard boundaries (phase-1 review)
 *
 *   1. READ-ONLY. Opened with `readonly:true` + `fileMustExist:true`. We never
 *      write, migrate, or lock CC Switch's DB — breaking their app is not an
 *      option.
 *   2. Fixed path only. `~/.cc-switch/cc-switch.db`; no user-supplied path
 *      (no path-traversal surface).
 *   3. Schema-tolerant. CC Switch's schema is their private implementation and
 *      can change on upgrade. We validate the `providers` table + columns
 *      exist and fail with a clear reason instead of throwing.
 *   4. No silent bulk import. This module only *reads* and returns a preview;
 *      the actual write is a separate, user-confirmed step (the IPC layer
 *      calls addCustomProvider per selected item).
 *   5. Base URL is re-validated by addCustomProvider (http(s) only) — a corrupt
 *      or hostile row can't inject a weird scheme.
 *
 * ## Mapping (CC Switch app_type → our protocol + endpoint)
 *
 *   claude / claude-desktop → protocol 'anthropic'
 *       env.ANTHROPIC_BASE_URL + env.ANTHROPIC_AUTH_TOKEN
 *   codex → protocol 'openai'
 *       auth.OPENAI_API_KEY + base_url parsed from the `config` TOML
 *       (model_providers.*.base_url); OAuth-only codex rows (no API key) are
 *       skipped — we can't turn an OAuth session into a portable key.
 *   gemini → protocol 'gemini'
 *       env.GEMINI_API_KEY / GOOGLE_API_KEY + env base url when present
 *
 * `category='official'` rows are skipped: they're the built-in
 * Anthropic/OpenAI/Google endpoints, already covered by Orkas's own catalog.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { createLogger } from '../logger';

const log = createLogger('ccswitch-import');

export interface CcSwitchImportItem {
  /** CC Switch row id — stored as CustomProvider.externalId for re-sync. */
  externalId: string;
  name: string;
  protocol: 'anthropic' | 'openai' | 'gemini';
  baseUrl: string;
  apiKey: string;
  /** Optional model hints declared in CC Switch's provider configuration. */
  models?: string[];
  notes?: string;
  websiteUrl?: string;
  /** True when CC Switch stored no usable key for this row (e.g. codex rows
   *  that rely on the OPENAI_API_KEY env var, or OAuth). The provider is still
   *  importable so the user sees it, but must supply the key afterwards. */
  needsKey?: boolean;
}

export interface CcSwitchSkippedItem {
  externalId: string;
  name: string;
  appType: string;
  reason: 'official' | 'unsupported_protocol' | 'missing_base_url' | 'missing_api_key' | 'invalid_config';
}

export interface CcSwitchProbe {
  available: boolean;
  reason?: 'not_installed' | 'unreadable' | 'bad_schema';
  dbPath: string;
}

/** Fixed CC Switch DB path. No user override (path-traversal boundary). */
export function ccSwitchDbPath(home = os.homedir()): string {
  return path.join(home, '.cc-switch', 'cc-switch.db');
}

/** Cheap existence/readability probe used to decide whether to show the
 *  "sync from CC Switch" affordance at all. Does not open the DB. */
export function probeCcSwitch(home = os.homedir()): CcSwitchProbe {
  const dbPath = ccSwitchDbPath(home);
  try {
    fs.accessSync(dbPath, fs.constants.R_OK);
  } catch {
    return { available: false, reason: 'not_installed', dbPath };
  }
  return { available: true, dbPath };
}

/** Parse `base_url` out of codex's TOML `config` blob without a full TOML
 *  parser: we only need the first `base_url = "..."` (under model_providers).
 *  Defensive — returns undefined when not found. */
function baseUrlFromCodexConfigToml(configToml: unknown): string | undefined {
  if (typeof configToml !== 'string' || !configToml) return undefined;
  const m = /base_url\s*=\s*"([^"]+)"/.exec(configToml);
  return m ? m[1] : undefined;
}

/** Best-effort key extraction from a codex TOML `config`. CC Switch sometimes
 *  inlines the key as `api_key = "..."`; other rows use `env_key = "NAME"`
 *  (the key is then read from that env var at runtime and NOT stored), or rely
 *  on OPENAI_API_KEY. We only return an inline literal key; `env_key`
 *  references resolve to no stored key (→ needsKey). */
function apiKeyFromCodexConfigToml(configToml: unknown): string | undefined {
  if (typeof configToml !== 'string' || !configToml) return undefined;
  const m = /\bapi_key\s*=\s*"([^"]+)"/.exec(configToml);
  return m ? m[1] : undefined;
}

function modelFromCodexConfigToml(configToml: unknown): string | undefined {
  if (typeof configToml !== 'string' || !configToml) return undefined;
  const m = /(?:^|\n)\s*model\s*=\s*"([^"]+)"/.exec(configToml);
  return m ? m[1] : undefined;
}

function modelHints(cfg: Record<string, unknown>, env: Record<string, unknown>): string[] | undefined {
  const raw: unknown[] = [];
  if (Array.isArray(cfg.models)) raw.push(...cfg.models);
  raw.push(cfg.model, cfg.defaultModel, cfg.default_model);
  raw.push(env.ANTHROPIC_MODEL, env.OPENAI_MODEL, env.GEMINI_MODEL, env.GOOGLE_MODEL);
  raw.push(modelFromCodexConfigToml(cfg.config));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const model = typeof value === 'string' ? value.trim().slice(0, 200) : '';
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
    if (out.length >= 100) break;
  }
  return out.length ? out : undefined;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Map one parsed CC Switch row → an import item, or undefined to skip. */
function mapRow(
  appType: string,
  id: string,
  name: string,
  category: string | null,
  settingsConfig: string,
  websiteUrl: string | null,
  notes: string | null,
): CcSwitchImportItem | undefined {
  if (category === 'official') return undefined;

  let cfg: Record<string, unknown>;
  try { cfg = asObject(JSON.parse(settingsConfig)); }
  catch { return undefined; }

  const env = asObject(cfg.env);
  const base = (k: string) => (typeof env[k] === 'string' ? (env[k] as string) : '');
  const models = modelHints(cfg, env);

  const common = {
    externalId: `${appType}:${id}`,
    name: name || id,
    ...(models ? { models } : {}),
    ...(notes ? { notes } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
  };

  if (appType === 'claude' || appType === 'claude-desktop') {
    const baseUrl = base('ANTHROPIC_BASE_URL');
    const apiKey = base('ANTHROPIC_AUTH_TOKEN') || base('ANTHROPIC_API_KEY');
    if (!baseUrl) return undefined; // no endpoint → nothing to import
    return { ...common, protocol: 'anthropic', baseUrl, apiKey, ...(apiKey ? {} : { needsKey: true }) };
  }

  if (appType === 'codex') {
    const auth = asObject(cfg.auth);
    const apiKey =
      (typeof auth.OPENAI_API_KEY === 'string' ? (auth.OPENAI_API_KEY as string) : '')
      || apiKeyFromCodexConfigToml(cfg.config)
      || '';
    const baseUrl = base('OPENAI_BASE_URL') || baseUrlFromCodexConfigToml(cfg.config) || '';
    // A third-party codex provider is identified by a custom base_url. The key
    // is often NOT stored by CC Switch (it uses env_key / OPENAI_API_KEY at
    // runtime), so we import with needsKey instead of dropping the row.
    if (!baseUrl) return undefined;
    return { ...common, protocol: 'openai', baseUrl, apiKey, ...(apiKey ? {} : { needsKey: true }) };
  }

  if (appType === 'gemini') {
    const apiKey = base('GEMINI_API_KEY') || base('GOOGLE_API_KEY');
    const baseUrl =
      base('GOOGLE_GEMINI_BASE_URL') || base('GEMINI_BASE_URL')
      || baseUrlFromCodexConfigToml(cfg.config) || '';
    if (!baseUrl) return undefined;
    return { ...common, protocol: 'gemini', baseUrl, apiKey, ...(apiKey ? {} : { needsKey: true }) };
  }

  return undefined;
}

/**
 * Read CC Switch's DB and return the importable third-party providers.
 * Never throws for expected conditions — returns `{ items: [] }` with a probe
 * reason via the accompanying probe when the DB is missing/unreadable/bad.
 */
export function readCcSwitchImportItems(
  home = os.homedir(),
): { ok: true; items: CcSwitchImportItem[]; skipped: CcSwitchSkippedItem[] } | { ok: false; reason: NonNullable<CcSwitchProbe['reason']> } {
  const probe = probeCcSwitch(home);
  if (!probe.available) return { ok: false, reason: probe.reason || 'not_installed' };

  let db: Database.Database | null = null;
  try {
    db = new Database(probe.dbPath, { readonly: true, fileMustExist: true });
    // Schema tolerance: verify the providers table + the columns we read.
    const cols = db.prepare(`PRAGMA table_info(providers)`).all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    const required = ['id', 'app_type', 'name', 'settings_config', 'category'];
    if (!required.every((c) => colNames.has(c))) {
      log.warn('cc-switch schema mismatch', { have: [...colNames] });
      return { ok: false, reason: 'bad_schema' };
    }

    const rows = db.prepare(
      `SELECT id, app_type, name, settings_config, website_url, category, notes
         FROM providers`,
    ).all() as Array<{
      id: string; app_type: string; name: string; settings_config: string;
      website_url: string | null; category: string | null; notes: string | null;
    }>;

    const items: CcSwitchImportItem[] = [];
    const skipped: CcSwitchSkippedItem[] = [];
    for (const r of rows) {
      const item = mapRow(r.app_type, r.id, r.name, r.category, r.settings_config, r.website_url, r.notes);
      if (item && String(item.apiKey || '').trim() && !item.needsKey) {
        items.push(item);
        continue;
      }
      let reason: CcSwitchSkippedItem['reason'] = item ? 'missing_api_key' : 'missing_base_url';
      if (r.category === 'official') reason = 'official';
      else if (!['claude', 'claude-desktop', 'codex', 'gemini'].includes(r.app_type)) reason = 'unsupported_protocol';
      else {
        try { JSON.parse(r.settings_config || '{}'); }
        catch { reason = 'invalid_config'; }
      }
      skipped.push({
        externalId: `${r.app_type}:${r.id}`,
        name: r.name || r.id,
        appType: r.app_type,
        reason,
      });
    }
    return { ok: true, items, skipped };
  } catch (err) {
    log.warn('cc-switch read failed', { error: (err as Error).message });
    return { ok: false, reason: 'unreadable' };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}
