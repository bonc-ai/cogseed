import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve('src/main/preload.js'), 'utf8');

describe('packaged Windows STT smoke integration', () => {
  it('configures file-backed fake audio before Electron becomes ready without bypassing permissions', () => {
    const fakeDevice = mainSource.indexOf("appendSwitch('use-fake-device-for-media-stream')");
    const fakeAudio = mainSource.indexOf("appendSwitch('use-file-for-fake-audio-capture'");
    const whenReady = mainSource.indexOf('app.whenReady()');

    expect(mainSource).toContain('COGSEED_PACKAGED_STT_SMOKE_FILE');
    expect(mainSource).toContain('COGSEED_PACKAGED_STT_SMOKE_WAV');
    expect(fakeDevice).toBeGreaterThanOrEqual(0);
    expect(fakeAudio).toBeGreaterThan(fakeDevice);
    expect(fakeAudio).toBeLessThan(whenReady);
    expect(mainSource).not.toContain('use-fake-ui-for-media-stream');
  });

  it('connects the hidden packaged renderer to a private STT marker handler', () => {
    expect(mainSource).toContain("'--cogseed-packaged-stt-smoke'");
    expect(mainSource).toContain("ipcMain.handle('cogseed.packagedSttSmokeReady'");
    expect(mainSource).toContain('event.sender !== mainRendererWebContents');
    expect(mainSource).toContain('permissionCheckCount');
    expect(mainSource).toContain('permissionRequestCount');
    expect(mainSource).toContain('schemaErrorCode');
    expect(mainSource).toContain('numericPayloadValid');
    expect(mainSource).not.toContain('Number(value) >= 0 ? Number(value) : 0');
    expect(mainSource).toContain('finalTextLength:');
    expect(preloadSource).toContain("process.argv.includes('--cogseed-packaged-stt-smoke')");
    expect(preloadSource).toContain("cogseedApi.invoke('stt.start'");
    expect(preloadSource).toContain("cogseedApi.stream('stt.results'");
    expect(preloadSource).toContain("cogseedApi.invoke('stt.pushAudio'");
    expect(preloadSource).toContain("cogseedApi.invoke('stt.stop'");
  });
});
