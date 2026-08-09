import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `async function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing function: ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

describe('conversation cognition capture', () => {
  it('keeps the click-time conversation while the lazy feature loads', async () => {
    let finishLoading: (() => void) | undefined;
    const featureLoaded = new Promise<void>((resolve) => { finishLoading = resolve; });
    const openCognitionCapture = vi.fn(() => true);
    const sandbox: Record<string, unknown> = {
      currentCid: 'cid-a',
      loadRendererFeature: vi.fn(async () => {
        await featureLoaded;
        (sandbox.window as Record<string, unknown>).openCognitionCapture = openCognitionCapture;
      }),
      _convLog: { warn: vi.fn() },
      window: {},
    };
    vm.runInNewContext(
      `${extractFunction('_openCognitionCaptureFromBubble')}\nthis.openCapture = _openCognitionCaptureFromBubble;`,
      sandbox,
    );
    const message = { dataset: { msgId: 'msg-1' } };
    const button = { disabled: false };

    const opening = (sandbox.openCapture as (
      source: typeof message,
      getContent: () => string,
      target: typeof button,
    ) => Promise<boolean>)(
      message,
      () => 'Reusable approach',
      button,
    );
    expect(button.disabled).toBe(true);
    sandbox.currentCid = 'cid-b';
    finishLoading?.();

    await expect(opening).resolves.toBe(true);
    expect(button.disabled).toBe(false);
    expect(openCognitionCapture).toHaveBeenCalledWith({
      conversationId: 'cid-a',
      messageId: 'msg-1',
    });
  });
});
