/**
 * User preferences bag — `<uid>/cloud/config/preferences.json`.
 *
 * Cross-device user preferences (cloud-synced), including language,
 * appearance, feature toggles, and notification preferences.
 *
 * History: the old `data/config/config.json` also held legacy
 * `provider` / `model` fields (the default model pair written by
 * `auth.saveConfig`). That fallback is deprecated — the default model
 * is solely determined by the priority entries in
 * `auth-profiles.json` (`auth.getConfig()` reads `entries[0]`). The
 * migration drops those two fields.
 *
 * Writes merge into the existing file; explicit `undefined` values are
 * ignored (equivalent to no-op).
 */

import { app } from 'electron';

import { userPreferencesFile } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';
import { getActiveUserId } from './users';
import {
  type Lang,
  type UiLang,
  SUPPORTED_LANGS,
  UI_LANGS,
  isLang,
  isUiLang,
  detectSystemLang,
  setCurrentLang,
  setCurrentUiLang,
} from '../i18n';

export interface CommanderAvatar {
  icon: string;
  color: string;
}

export type CommanderBackendKind = 'cogseed-core-agent';

export interface CommanderBackendSettings {
  backend: CommanderBackendKind;
  /** Optional auth entry override for CogSeed Core Agent. Missing/null uses the existing priority chain. */
  authEntryId?: string | null;
  /** Reserved for legacy preference compatibility. The commander no longer uses local CLI backends. */
  localCli?: null;
}

export const DEFAULT_COMMANDER_BACKEND_SETTINGS: CommanderBackendSettings = Object.freeze({
  backend: 'cogseed-core-agent' as const,
  authEntryId: null,
  localCli: null,
});

export interface UserPreferences {
  /** Preferred Commander/Agent response language. */
  language?: Lang;
  /** Product interface language. Intentionally independent from Agent replies. */
  ui_language?: UiLang;
  /** Per-user commander avatar (icon id + color id). Tokens come from
   * `renderer/modules/avatar.js`. Missing → renderer falls back to the
   * commander default (crown + gold). */
  commander_avatar?: CommanderAvatar;
  /** Metacognition-level agent self-evolution toggle. undefined / any
   * non-false value → treated as enabled (preserving the historical
   * default); explicit false → disabled. The env var
   * `COGSEED_METACOGNITION='0'` remains a higher-priority kill switch.
   * Reads go through `features/metacognition.isFeatureEnabled`. */
  metacognition_enabled?: boolean;
  /** Thinking strength for chat model calls: 'auto' (model default),
   *  'off' | 'low' | 'high' forwarded to the runner's thinkingLevel. */
  thinking_level?: 'auto' | 'off' | 'low' | 'high';
  /** Whether machine-global skill roots such as ~/.codex/skills are visible
   * to commander open-tier skill search. Missing means enabled, preserving
   * the historical open-source behavior. */
  global_skill_roots_enabled?: boolean;
  /** Commander role backend binding. Missing means CogSeed Core Agent with the existing auth priority chain. */
  commander_backend?: CommanderBackendSettings;
  /** Per-field update clocks used by cloud-sync to merge independent
   * preference changes without treating the whole JSON file as one blob. */
  _field_updated_at?: Record<string, number>;
  [key: string]: unknown;
}

// Avatar tokens reuse the same catalog (src/main/data/avatars.json).
import { isKnownIcon, isKnownColor } from './avatars';

function preferencesFile(): string {
  return userPreferencesFile(getActiveUserId());
}

function systemLanguage(): Lang {
  let locale = '';
  try { locale = app.getLocale() || ''; } catch { /* pre-ready or test stub */ }
  return detectSystemLang(locale);
}

export function readPreferences(): UserPreferences {
  return readJsonSync<UserPreferences>(preferencesFile());
}

/** Merge `partial` into the on-disk preferences and atomically rewrite. */
export function writePreferences(partial: Partial<UserPreferences>): UserPreferences {
  const current = readPreferences();
  const next: UserPreferences = { ...current };
  const updatedKeys: string[] = [];
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined || k === '_field_updated_at') continue;
    next[k] = v;
    updatedKeys.push(k);
  }
  if (updatedKeys.length > 0) {
    const prevClocks = (current._field_updated_at && typeof current._field_updated_at === 'object')
      ? current._field_updated_at
      : {};
    const clocks: Record<string, number> = { ...prevClocks };
    const maxExisting = Math.max(0, ...Object.values(clocks).map((v) => Number(v) || 0));
    let ts = Math.max(Date.now(), maxExisting + 1);
    for (const key of updatedKeys) {
      clocks[key] = ts;
      ts += 1;
    }
    next._field_updated_at = clocks;
  }
  writeJsonSync(preferencesFile(), next);
  return next;
}

// ── Back-compat aliases for older callers ────────────────────────────────
// New code should use read/writePreferences directly. These aliases
// remain for call sites that haven't been migrated yet.
export const readConfig = readPreferences;
export const writeConfig = writePreferences;
export type AppConfig = UserPreferences;

// ── Commander backend binding ────────────────────────────────────────────

function normalizeCommanderBackendSettings(value: unknown, strict = false): CommanderBackendSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_COMMANDER_BACKEND_SETTINGS };
  const raw = value as Partial<CommanderBackendSettings> & Record<string, unknown>;
  const backend = raw.backend;
  if (backend !== 'cogseed-core-agent') {
    if (strict) throw new Error('invalid commander backend');
    return { ...DEFAULT_COMMANDER_BACKEND_SETTINGS };
  }
  const authEntryId = typeof raw.authEntryId === 'string' && raw.authEntryId.trim()
    ? raw.authEntryId.trim()
    : null;

  return { backend, authEntryId, localCli: null };
}

export function getCommanderBackendSettings(): CommanderBackendSettings {
  return normalizeCommanderBackendSettings(readPreferences().commander_backend);
}

export function setCommanderBackendSettings(settings: CommanderBackendSettings): CommanderBackendSettings {
  const next = normalizeCommanderBackendSettings(settings, true);
  writePreferences({ commander_backend: next });
  return next;
}

// ── Commander/Agent language ─────────────────────────────────────────────

export function getLanguage(): Lang {
  const v = readPreferences().language;
  const lang = isLang(v) ? v : systemLanguage();
  setCurrentLang(lang);
  return lang;
}

export function getLanguageForUser(uid: string): Lang {
  const v = readJsonSync<UserPreferences>(userPreferencesFile(uid)).language;
  const lang = isLang(v) ? v : systemLanguage();
  setCurrentLang(lang);
  return lang;
}

export function setLanguage(lang: Lang): Lang {
  if (!isLang(lang)) throw new Error(`unsupported language: ${String(lang)}`);
  writePreferences({ language: lang });
  setCurrentLang(lang);
  return lang;
}

export function refreshCurrentLanguageFromPreferences(): Lang {
  const lang = getLanguage();
  setCurrentLang(lang);
  return lang;
}

/**
 * Boot-time language resolution:
 *   - If preferences.json has a valid `language` → use it, sync to i18n.
 *   - Otherwise detect from the given system-locale string, persist, and
 *     sync to i18n.
 *
 * Takes `systemLocale` explicitly so tests can exercise the branches without
 * pulling in Electron's `app`. Production caller is `initLanguageFromApp`.
 */
export function initLanguage(systemLocale: string): Lang {
  const pref = readPreferences();
  if (isLang(pref.language)) {
    setCurrentLang(pref.language);
    return pref.language;
  }
  const lang = detectSystemLang(systemLocale);
  writePreferences({ language: lang });
  setCurrentLang(lang);
  return lang;
}

// ── Product interface language ──────────────────────────────────────────

export function getUiLanguage(): UiLang {
  const value = readPreferences().ui_language;
  const lang: UiLang = isUiLang(value) ? value : 'zh';
  setCurrentUiLang(lang);
  return lang;
}

export function setUiLanguage(lang: UiLang): UiLang {
  if (!isUiLang(lang)) throw new Error(`unsupported UI language: ${String(lang)}`);
  writePreferences({ ui_language: lang });
  setCurrentUiLang(lang);
  return lang;
}

export function refreshCurrentUiLanguageFromPreferences(): UiLang {
  const lang = getUiLanguage();
  setCurrentUiLang(lang);
  return lang;
}

/**
 * Resolve the UI language at boot. The first release intentionally defaults
 * to Simplified Chinese rather than inheriting the operating-system locale.
 */
export function initUiLanguage(): UiLang {
  const pref = readPreferences();
  if (isUiLang(pref.ui_language)) {
    setCurrentUiLang(pref.ui_language);
    return pref.ui_language;
  }
  writePreferences({ ui_language: 'zh' });
  setCurrentUiLang('zh');
  return 'zh';
}

// ── Commander avatar ─────────────────────────────────────────────────────

export function getCommanderAvatar(): CommanderAvatar | null {
  const v = readPreferences().commander_avatar;
  if (!v || typeof v !== 'object') return null;
  const icon = (v as CommanderAvatar).icon;
  const color = (v as CommanderAvatar).color;
  if (!isKnownIcon(icon) || !isKnownColor(color)) return null;
  return { icon, color };
}

export function setCommanderAvatar(avatar: CommanderAvatar): CommanderAvatar {
  if (!isKnownIcon(avatar?.icon) || !isKnownColor(avatar?.color)) {
    throw new Error('invalid avatar tokens');
  }
  const next: CommanderAvatar = { icon: avatar.icon, color: avatar.color };
  writePreferences({ commander_avatar: next });
  return next;
}

// ── Thinking strength (model reasoning effort) ───────────────────────────
// 'auto' = no override (let the model/provider decide). Missing preference is
// treated as 'auto', so never-written configs behave exactly as before.

export type ThinkingLevelPreference = 'auto' | 'off' | 'low' | 'high';

export function getThinkingLevel(): ThinkingLevelPreference {
  const v = readPreferences().thinking_level;
  return v === 'off' || v === 'low' || v === 'high' ? v : 'auto';
}

export function setThinkingLevel(level: unknown): ThinkingLevelPreference {
  const next: ThinkingLevelPreference =
    level === 'off' || level === 'low' || level === 'high' ? level : 'auto';
  writePreferences({ thinking_level: next });
  return next;
}

// ── Metacognition (self-evolution) toggle ────────────────────────────────
// Defaults to ON: never-written = undefined → treated as true, matching
// historical behavior. Only an explicit false disables it. Reads go
// through features/metacognition.isFeatureEnabled, which additionally
// layers the env `COGSEED_METACOGNITION='0'` kill switch on top.

export function getMetacognitionEnabled(): boolean {
  const v = readPreferences().metacognition_enabled;
  return v !== false;
}

export function setMetacognitionEnabled(enabled: boolean): boolean {
  writePreferences({ metacognition_enabled: !!enabled });
  return !!enabled;
}

export function getGlobalSkillRootsEnabled(): boolean {
  return readPreferences().global_skill_roots_enabled !== false;
}

export function setGlobalSkillRootsEnabled(enabled: boolean): boolean {
  writePreferences({ global_skill_roots_enabled: !!enabled });
  return !!enabled;
}


// ── Native task notifications ───────────────────────────────────────────
// Defaults to ON. Notification permission/support remain OS-owned; this is
// the user's CogSeed-level preference and gates the single notification outlet.

export function getTaskNotificationsEnabled(): boolean {
  return readPreferences().task_notifications_enabled !== false;
}

export function setTaskNotificationsEnabled(enabled: boolean): boolean {
  writePreferences({ task_notifications_enabled: !!enabled });
  return !!enabled;
}

/** Production wrapper: reads the system locale from Electron's `app`. */
export function initLanguageFromApp(): Lang {
  let locale = '';
  try { locale = app.getLocale() || ''; } catch { /* pre-ready or test stub */ }
  return initLanguage(locale);
}

/** Re-export for callers that need it without pulling i18n directly. */
export { SUPPORTED_LANGS, UI_LANGS, type Lang, type UiLang };
