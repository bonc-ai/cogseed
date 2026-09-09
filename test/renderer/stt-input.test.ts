import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { sttMicrophonePermissionMessage } = require('../../src/renderer/modules/stt-input.js') as {
  sttMicrophonePermissionMessage: (platform?: string) => { key: string; fallback: string };
};

describe('speech input microphone permission guidance', () => {
  it('shows Windows settings guidance for both Chromium platform variants', () => {
    for (const platform of ['Windows', 'Win32']) {
      const message = sttMicrophonePermissionMessage(platform);
      expect(message.key).toBe('chat.stt.error_permission_windows');
      expect(message.fallback).toContain('设置 → 隐私和安全性 → 麦克风');
    }
  });

  it('keeps macOS guidance separate from Windows guidance', () => {
    const message = sttMicrophonePermissionMessage('MacIntel');
    expect(message.key).toBe('chat.stt.error_permission_macos');
    expect(message.fallback).toContain('系统设置 → 隐私与安全性 → 麦克风');
  });

  it('uses a platform-neutral fallback when the platform is unavailable', () => {
    expect(sttMicrophonePermissionMessage().key).toBe('chat.stt.error_permission_generic');
  });
});
