#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SPEECH_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'stt', 'sherpa-onnx-zh-0.wav');
const DEFAULT_SPEECH_FIXTURE_SHA256 = '668bf8df51a10027b84d5d8816a1ce11ae93545538dc05cfe2aa6811d399c250';
const DEFAULT_SPEECH_SAMPLE_COUNT = 89_784;
const DEFAULT_SMOKE_TIMEOUT_MS = 240_000;
const MARKER_FIELDS = Object.freeze([
  'schemaErrorCode',
  'appIsPackaged',
  'permissionCheckCount',
  'permissionRequestCount',
  'audioTrackLive',
  'sampleCount',
  'nonZeroSampleCount',
  'rms',
  'pushAcknowledgements',
  'sessionCreated',
  'stopAcknowledged',
  'finalEventObserved',
  'finalTextLength',
  'failureCount',
]);

function expectedWindowsExecutable(root = ROOT) {
  return path.join(root, 'dist', 'win-unpacked', 'CogSeed.exe');
}

function verifySpeechFixture(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`[E_STT_SMOKE_FIXTURE] missing Mandarin speech fixture: ${file}`);
  }
  const wav = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(wav).digest('hex');
  if (hash !== DEFAULT_SPEECH_FIXTURE_SHA256) {
    throw new Error(`[E_STT_SMOKE_FIXTURE] Mandarin speech fixture hash mismatch: ${file}`);
  }
  let dataBytes = -1;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (wav.subarray(offset, offset + 4).toString('ascii') === 'data') dataBytes = chunkSize;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (wav.length !== 179_646
      || wav.subarray(0, 4).toString('ascii') !== 'RIFF'
      || wav.subarray(8, 12).toString('ascii') !== 'WAVE'
      || wav.readUInt16LE(20) !== 1
      || wav.readUInt16LE(22) !== 1
      || wav.readUInt32LE(24) !== 16_000
      || wav.readUInt16LE(34) !== 16
      || dataBytes !== DEFAULT_SPEECH_SAMPLE_COUNT * 2) {
    throw new Error(`[E_STT_SMOKE_FIXTURE] Mandarin speech fixture WAV contract mismatch: ${file}`);
  }
}

function verifySttSmokeMarker(marker) {
  const errors = [];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return ['smoke marker must be an object'];
  }
  if (marker.schemaErrorCode !== 0) {
    return ['[E_STT_SMOKE_SCHEMA] invalid numeric smoke marker payload'];
  }
  for (const field of Object.keys(marker)) {
    if (!MARKER_FIELDS.includes(field)) errors.push(`unexpected marker field: ${field}`);
  }
  if (marker.appIsPackaged !== true) errors.push('marker must confirm packaged execution');
  if (!Number.isInteger(marker.permissionCheckCount) || marker.permissionCheckCount < 1) {
    errors.push('marker must observe a media permission check');
  }
  if (!Number.isInteger(marker.permissionRequestCount) || marker.permissionRequestCount < 1) {
    errors.push('marker must observe a media permission request');
  }
  if (marker.audioTrackLive !== true) errors.push('marker must observe a live audio track');
  if (marker.sampleCount !== DEFAULT_SPEECH_SAMPLE_COUNT) {
    errors.push(`marker sample count must exactly match the ${DEFAULT_SPEECH_SAMPLE_COUNT}-sample fixture`);
  }
  if (!Number.isInteger(marker.nonZeroSampleCount) || marker.nonZeroSampleCount < 1) {
    errors.push('marker must capture non-zero audio samples');
  }
  if (typeof marker.rms !== 'number' || !Number.isFinite(marker.rms) || marker.rms <= 0) {
    errors.push('marker must report positive finite RMS');
  }
  if (marker.pushAcknowledgements !== 22) {
    errors.push('marker must receive exactly 22 push acknowledgements');
  }
  if (marker.sessionCreated !== true) errors.push('marker must create an STT session');
  if (marker.stopAcknowledged !== true) errors.push('marker must acknowledge stt.stop');
  if (marker.finalEventObserved !== true) errors.push('marker must observe the final STT event');
  if (!Number.isInteger(marker.finalTextLength) || marker.finalTextLength < 1) {
    errors.push('marker must observe a non-empty transcript');
  }
  if (!Number.isInteger(marker.failureCount) || marker.failureCount !== 0) {
    errors.push('marker must report zero smoke failures');
  }
  return errors;
}

function configuredSmokeTimeoutMs(env = process.env) {
  const raw = Number(env.COGSEED_PACKAGED_STT_SMOKE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_SMOKE_TIMEOUT_MS;
}

function waitForMarker(markerPath, child, timeoutMs = configuredSmokeTimeoutMs()) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer;
    let timeoutTimer;
    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const readMarker = () => {
      if (fs.existsSync(markerPath)) {
        try { settle(resolve, JSON.parse(fs.readFileSync(markerPath, 'utf8'))); }
        catch (error) { settle(reject, new Error(`invalid smoke marker: ${error.message || error}`)); }
        return true;
      }
      return false;
    };
    const check = () => {
      if (readMarker()) return;
      if (child.exitCode != null) {
        settle(reject, new Error(`packaged app exited before writing the STT smoke marker (status ${child.exitCode})`));
      }
    };
    const onError = (error) => {
      settle(reject, new Error(`packaged app process error: ${error?.message || error}`));
    };
    const onClose = (code) => {
      if (!readMarker()) {
        settle(reject, new Error(`packaged app exited before writing the STT smoke marker (status ${code})`));
      }
    };

    child.once('error', onError);
    child.once('close', onClose);
    pollTimer = setInterval(check, 200);
    timeoutTimer = setTimeout(() => {
      settle(reject, new Error(`timed out after ${timeoutMs}ms waiting for packaged STT smoke`));
    }, timeoutMs);
  });
}

function terminateChild(child, graceMs = 5_000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let forceTimer;
    const onClose = () => {
      if (forceTimer) clearTimeout(forceTimer);
      child.off('close', onClose);
      resolve();
    };
    child.once('close', onClose);
    forceTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    }, graceMs);
    try { child.kill('SIGTERM'); } catch (_) {}
  });
}

async function launchSmoke(executable) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-packaged-stt-'));
  const markerPath = path.join(tempRoot, 'stt-smoke.json');
  const wavPath = DEFAULT_SPEECH_FIXTURE;
  verifySpeechFixture(wavPath);
  const launchEnv = { ...process.env };
  delete launchEnv.COGSEED_WORKSPACE_ROOT;
  delete launchEnv.COGSEED_RUNTIME_CONTAINER;
  const child = spawn(executable, [], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...launchEnv,
      USERPROFILE: tempRoot,
      LOCALAPPDATA: path.join(tempRoot, 'local-app-data'),
      APPDATA: path.join(tempRoot, 'app-data'),
      COGSEED_PACKAGED_STT_SMOKE_FILE: markerPath,
      COGSEED_PACKAGED_STT_SMOKE_WAV: wavPath,
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
  try {
    const marker = await waitForMarker(markerPath, child, configuredSmokeTimeoutMs());
    const errors = verifySttSmokeMarker(marker);
    if (errors.length) throw new Error(`${errors.join('; ')}${stderr ? `\n${stderr}` : ''}`);
    return marker;
  } finally {
    await terminateChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('verify:package:stt:win is supported only on Windows');
  const executable = process.argv[2] ? path.resolve(process.argv[2]) : expectedWindowsExecutable();
  if (!fs.existsSync(executable)) throw new Error(`missing packaged executable: ${executable}`);
  const marker = await launchSmoke(executable);
  process.stdout.write(`${JSON.stringify({ ok: true, executable, smoke: marker }, null, 2)}\n`);
}

module.exports = {
  MARKER_FIELDS,
  DEFAULT_SPEECH_FIXTURE,
  DEFAULT_SPEECH_FIXTURE_SHA256,
  DEFAULT_SPEECH_SAMPLE_COUNT,
  DEFAULT_SMOKE_TIMEOUT_MS,
  configuredSmokeTimeoutMs,
  expectedWindowsExecutable,
  verifySpeechFixture,
  verifySttSmokeMarker,
  waitForMarker,
  terminateChild,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[verify-packaged-stt-win] ${error.message || error}\n`);
    process.exitCode = 1;
  });
}
