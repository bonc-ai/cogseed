/**
 * tts — pluggable text-to-speech backend for the `generate_speech`
 * runtime. Encapsulated so new user-configured backends slot in behind one
 * interface:
 *
 *   - 'openai-compatible' (PRIMARY): BYO user TTS API in the OpenAI
 *     `/audio/speech` shape — ElevenLabs / OpenAI / any compatible gateway.
 *     Config = a saved `TtsProfile` (base url, key, model, voice).
 *   - 'doubao': Volcengine V3 TTS (`/api/v3/tts/unidirectional`). NOT OpenAI-
 *     compatible — `X-Api-Key` + `X-Api-Resource-Id` auth (the API-key console
 *     method) and an NDJSON stream of base64 audio chunks. Routed by
 *     `profile.provider === 'doubao'`.
 *   - no configured provider: fail fast with a clear setup error. Speech
 *     generation never downloads or runs a local renderer implicitly.
 *
 * Additional user-owned backends can implement the same `TtsBackend`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { TtsProfile } from './auth';
import {
  DOUBAO_DEFAULT_VOICE,
  listTtsProfiles,
} from './tts_auth';
import { redactPaths } from '../util/redact';
import { createLogger } from '../logger';
import { resolveTtsSelection } from './tts_capabilities';

const log = createLogger('tts');

/** Cap on a synthesized-audio response so a misbehaving endpoint can't balloon
 *  memory. Speech of a sentence/paragraph is KB–low-MB; 50MB is very generous. */
const MAX_TTS_BYTES = 50 * 1024 * 1024;

export interface TtsParams {
  text: string;
  outputAbsPath: string;
  /** Stable configured route selected from the runtime capability catalog. */
  routeRef?: string;
  /** Stable route-bound voice reference selected from the capability catalog. */
  voiceRef?: string;
  /** BCP-47 narration language signed with the selected voice. */
  language?: string;
  /** Voice id (provider-specific). Falls back to the profile / backend default. */
  voice?: string;
  /** Speed multiplier (1.0 = normal). */
  speed?: number;
  /** Output container (mp3 | wav | opus | ...); falls back to the profile default. */
  format?: string;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string }) => void;
}

export type TtsResult =
  | { ok: true; path: string; bytes: number; backend: string }
  | {
    ok: false;
    errorCode: string;
    message: string;
    requestDisposition?: 'not_sent' | 'rejected_preflight' | 'sent';
    chargeStatus?: 'not_charged' | 'charged' | 'unknown';
    retryPolicy?: 'safe_after_plan_fix' | 'requires_user_action' | 'unknown';
    providerErrorCode?: string;
  };

interface TtsBackend {
  id: string;
  synthesize(p: TtsParams): Promise<TtsResult>;
}

/** Default request timeout for a synthesis call. Speech of a sentence is quick;
 *  generous enough for a paragraph without hanging forever. */
const TTS_TIMEOUT_MS = 120_000;

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ── Backend: OpenAI-compatible /audio/speech (BYO) ──────────────────────────

class OpenAICompatibleTtsBackend implements TtsBackend {
  readonly id = 'openai-compatible';
  constructor(private readonly profile: { baseUrl: string; apiKey: string; model: string; voice?: string; format?: string; label?: string }) {}

  async synthesize(p: TtsParams): Promise<TtsResult> {
    const base = this.profile.baseUrl.replace(/\/+$/, '');
    const url = `${base}/audio/speech`;
    const voice = p.voice || this.profile.voice;
    const format = (p.format || this.profile.format || 'mp3').toLowerCase();
    const body: Record<string, unknown> = {
      model: this.profile.model,
      input: p.text,
      ...(voice ? { voice } : {}),
      response_format: format,
      ...(typeof p.speed === 'number' ? { speed: p.speed } : {}),
    };

    p.onProgress?.({ phase: 'tts.request', message: `requesting speech from ${this.profile.label || base}` });
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.profile.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combineSignal(p.signal, TTS_TIMEOUT_MS),
      });
    } catch (err) {
      const aborted = p.signal?.aborted;
      // Don't echo the raw fetch error (it can embed the configured endpoint URL).
      if (!aborted) log.warn(`tts request failed: ${redactPaths((err as Error).message)}`);
      return { ok: false, errorCode: aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK', message: aborted ? 'TTS aborted.' : 'TTS request failed (network/endpoint error).' };
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 400);
      return { ok: false, errorCode: 'E_TTS_API_ERROR', message: `TTS API ${resp.status}: ${detail || resp.statusText}` };
    }
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > MAX_TTS_BYTES) {
      return { ok: false, errorCode: 'E_TTS_TOO_LARGE', message: `TTS response too large (${declared} bytes).` };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_TTS_BYTES) return { ok: false, errorCode: 'E_TTS_TOO_LARGE', message: `TTS response too large (${buf.length} bytes).` };
    if (!buf.length) return { ok: false, errorCode: 'E_TTS_EMPTY', message: 'TTS API returned empty audio.' };
    await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true }).catch(() => {});
    await fs.writeFile(p.outputAbsPath, buf);
    return { ok: true, path: p.outputAbsPath, bytes: buf.length, backend: this.id };
  }
}

// ── Backend: Doubao (Volcengine) V3 TTS ─────────────────────────────────────
//
// Not OpenAI-compatible: POST `/api/v3/tts/unidirectional` with `X-Api-Key` +
// `X-Api-Resource-Id` headers (the API-key console method). The response is an
// NDJSON stream — one JSON object per line; data lines carry base64 audio
// chunks (`code: 0`), `code: 20000000` terminates. See features/tts_auth.ts for
// the credential set (API key + resource id + voice).

/** Default synthesis model/voice family for the V3 endpoint. The resource id
 *  must match the voice family (2.0 official voices → seed-tts-2.0). */
const DOUBAO_DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
/** Doubao V3 success terminator event code (carries no audio). */
const DOUBAO_V3_DONE_CODE = 20000000;

/** Map a Doubao speaker id to its X-Api-Resource-Id family. The resource id MUST
 *  match the voice family or the V3 endpoint rejects the call, so we derive it
 *  from the speaker suffix — that way picking a different voice (per call or in
 *  settings) automatically uses the right resource id, no manual config. A
 *  profile's explicit `resourceId` overrides this. Pure → unit-tested.
 *    *_moon_* / *_mars_* / ICL_*       → seed-tts-1.0
 *    *_uranus_* / *_jupiter_* / saturn_* → seed-tts-2.0
 *    S_* (cloned voice)                 → seed-icl-2.0   (fallback seed-tts-2.0) */
export function deriveDoubaoResourceId(voice: string): string {
  const v = (voice || '').toLowerCase();
  if (v.startsWith('s_')) return 'seed-icl-2.0';
  if (/_(uranus|jupiter)_/.test(v) || v.startsWith('saturn_')) return 'seed-tts-2.0';
  if (/_(moon|mars)_/.test(v) || v.startsWith('icl_')) return 'seed-tts-1.0';
  return DOUBAO_DEFAULT_RESOURCE_ID;
}

/** Concatenate the base64 audio chunks from a Doubao V3 `/unidirectional`
 *  NDJSON response. Data events are `{code:0,data:"<base64>"}`; the stream ends
 *  with `{code:20000000}`; any other code is an error event. Pure → unit-tested. */
export function parseDoubaoV3Ndjson(raw: string): { ok: true; audio: Buffer } | { ok: false; message: string } {
  const chunks: Buffer[] = [];
  let error = '';
  for (const line of raw.split('\n')) {
    let s = line.trim();
    if (!s) continue;
    if (s.startsWith('data:')) s = s.slice(5).trim();
    let obj: { code?: number | string; data?: string; message?: string; msg?: string };
    try { obj = JSON.parse(s); } catch { continue; } // tolerate stray non-JSON lines
    const code = typeof obj.code === 'number'
      ? obj.code
      : (typeof obj.code === 'string' && /^-?\d+$/.test(obj.code.trim()) ? Number(obj.code) : undefined);
    if (code === 0 && typeof obj.data === 'string' && obj.data) {
      chunks.push(Buffer.from(obj.data, 'base64'));
    } else if (code !== undefined && code !== 0 && code !== DOUBAO_V3_DONE_CODE) {
      error = obj.message || obj.msg || `code ${code}`;
    }
  }
  if (error) return { ok: false, message: `Doubao TTS failed: ${error}` };
  if (!chunks.length) return { ok: false, message: 'Doubao TTS returned no audio.' };
  return { ok: true, audio: Buffer.concat(chunks) };
}

/** The V3 streaming endpoint uses provider-specific container names and does
 * not stream a WAV container. Request PCM for WAV and wrap it after parsing. */
export function normalizeDoubaoAudioFormat(format: string): string {
  const value = String(format || 'mp3').trim().toLowerCase();
  if (value === 'wav') return 'pcm';
  if (value === 'opus' || value === 'ogg') return 'ogg_opus';
  return 'mp3';
}

export function wrapPcm16MonoWav(audio: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + audio.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

class DoubaoTtsBackend implements TtsBackend {
  readonly id = 'doubao';
  constructor(private readonly profile: {
    baseUrl: string; apiKey: string; resourceId?: string;
    voice?: string; format?: string; label?: string;
  }) {}

  async synthesize(p: TtsParams): Promise<TtsResult> {
    const speaker = p.voice || this.profile.voice;
    if (!speaker) return { ok: false, errorCode: 'E_TTS_ARG', message: 'Doubao TTS requires a voice (speaker).' };
    const base = (this.profile.baseUrl || 'https://openspeech.bytedance.com').replace(/\/+$/, '');
    const url = `${base}/api/v3/tts/unidirectional`;
    const format = (p.format || this.profile.format || 'mp3').toLowerCase();
    const upstreamFormat = normalizeDoubaoAudioFormat(format);
    const resourceId = this.profile.resourceId?.trim() || deriveDoubaoResourceId(speaker);
    const body = {
      user: { uid: 'cogseed' },
      req_params: {
        text: p.text,
        speaker,
        audio_params: { format: upstreamFormat, sample_rate: 24000 },
      },
    };

    p.onProgress?.({ phase: 'tts.request', message: `requesting speech from ${this.profile.label || 'Doubao'}` });
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.profile.apiKey,
          'X-Api-Resource-Id': resourceId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combineSignal(p.signal, TTS_TIMEOUT_MS),
      });
    } catch (err) {
      const aborted = p.signal?.aborted;
      if (!aborted) log.warn(`doubao tts request failed: ${redactPaths((err as Error).message)}`);
      return { ok: false, errorCode: aborted ? 'E_TTS_ABORTED' : 'E_TTS_NETWORK', message: aborted ? 'TTS aborted.' : 'TTS request failed (network/endpoint error).' };
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 400);
      return { ok: false, errorCode: 'E_TTS_API_ERROR', message: `TTS API ${resp.status}: ${detail || resp.statusText}` };
    }
    const raw = await resp.text();
    // base64 inflates ~1.33×; a 50MB audio cap is ~67MB of NDJSON text.
    if (raw.length > MAX_TTS_BYTES * 2) return { ok: false, errorCode: 'E_TTS_TOO_LARGE', message: 'TTS response too large.' };
    const parsed = parseDoubaoV3Ndjson(raw);
    if (parsed.ok === false) return { ok: false, errorCode: 'E_TTS_API_ERROR', message: parsed.message };
    const buf = format === 'wav' ? wrapPcm16MonoWav(parsed.audio) : parsed.audio;
    if (buf.length > MAX_TTS_BYTES) return { ok: false, errorCode: 'E_TTS_TOO_LARGE', message: `TTS response too large (${buf.length} bytes).` };
    if (!buf.length) return { ok: false, errorCode: 'E_TTS_EMPTY', message: 'TTS API returned empty audio.' };
    await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true }).catch(() => {});
    await fs.writeFile(p.outputAbsPath, buf);
    return { ok: true, path: p.outputAbsPath, bytes: buf.length, backend: this.id };
  }
}

class UnconfiguredTtsBackend implements TtsBackend {
  readonly id = 'unconfigured';
  async synthesize(): Promise<TtsResult> {
    return {
      ok: false,
      errorCode: 'E_TTS_NOT_CONFIGURED',
      message: 'No TTS provider is configured. Configure Doubao or an OpenAI-compatible speech provider before generating narration.',
    };
  }
}

/** Resolve the active TTS backend: env override -> ordered saved profile list -> explicit setup error. */
function resolveTtsBackend(routeRef?: string): TtsBackend {
  const envBase = process.env.COGSEED_TTS_BASE_URL;
  const envKey = process.env.COGSEED_TTS_API_KEY;
  const envModel = process.env.COGSEED_TTS_MODEL;
  if (envBase && envKey && envModel && (!routeRef || routeRef === 'env:tts')) {
    return new OpenAICompatibleTtsBackend({
      baseUrl: envBase, apiKey: envKey, model: envModel,
      ...(process.env.COGSEED_TTS_VOICE ? { voice: process.env.COGSEED_TTS_VOICE } : {}),
      ...(process.env.COGSEED_TTS_FORMAT ? { format: process.env.COGSEED_TTS_FORMAT } : {}),
      label: 'env',
    });
  }
  let profiles: TtsProfile[] = [];
  try { profiles = listTtsProfiles(); } catch (err) { log.warn(`listTtsProfiles: ${(err as Error).message}`); }
  const p = routeRef ? profiles.find((profile) => profile.id === routeRef) : profiles[0];
  if (p) {
    if (p.provider === 'doubao') {
      return new DoubaoTtsBackend({
        baseUrl: p.baseUrl, apiKey: p.apiKey,
        ...(p.resourceId ? { resourceId: p.resourceId } : {}),
        ...(p.voice ? { voice: p.voice } : {}),
        ...(p.format ? { format: p.format } : {}),
        label: p.label,
      });
    }
    return new OpenAICompatibleTtsBackend(p);
  }
  return new UnconfiguredTtsBackend();
}

/** True when a BYO TTS provider is configured (env or saved profile). */
export function hasConfiguredTtsProvider(): boolean {
  if (process.env.COGSEED_TTS_BASE_URL && process.env.COGSEED_TTS_API_KEY && process.env.COGSEED_TTS_MODEL) return true;
  try { return listTtsProfiles().length > 0; } catch { return false; }
}

/** Non-secret active backend identity used to scope persisted duration
 * calibration. A provider change must never reuse another backend's observed
 * speaking pace. */
export function configuredTtsBackendId(): string {
  return resolveTtsBackend().id;
}

export async function generateSpeech(p: TtsParams): Promise<TtsResult> {
  if (!p.text.trim()) return { ok: false, errorCode: 'E_TTS_ARG', message: 'text is required' };
  const resolved = await resolveTtsSelection({
    ...(p.routeRef ? { routeRef: p.routeRef } : {}),
    ...(p.voiceRef ? { voiceRef: p.voiceRef } : {}),
    ...(p.voice ? { legacyVoice: p.voice } : {}),
    ...(p.language ? { language: p.language } : {}),
    ...(p.signal ? { signal: p.signal } : {}),
  });
  if (resolved.ok === false) {
    return {
      ok: false,
      errorCode: resolved.errorCode,
      message: resolved.message,
      requestDisposition: 'rejected_preflight',
      chargeStatus: 'not_charged',
      retryPolicy: 'safe_after_plan_fix',
    };
  }
  const res = await resolveTtsBackend(resolved.selection.routeRef).synthesize({
    ...p,
    routeRef: resolved.selection.routeRef,
    voiceRef: resolved.selection.voiceRef,
    voice: resolved.selection.providerVoiceId,
    language: resolved.selection.language,
  });
  return res;
}
