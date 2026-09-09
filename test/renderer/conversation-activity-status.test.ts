import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadStatusMapper(): (event: Record<string, unknown>) => Record<string, unknown> {
  const actionSource = extractFunction('_activityToolAction');
  const fnSource = extractFunction('_activityStatusFromEvent');
  return vm.runInNewContext(`(() => { ${actionSource}; return ${fnSource}; })()`, {});
}

function loadTerminalFormatter(): (
  message: Record<string, unknown>,
  state: string,
  detail?: string,
) => Record<string, unknown> {
  const durationSource = extractFunction('_activityDurationMs');
  const fnSource = extractFunction('_activityTerminalText');
  return vm.runInNewContext(`(() => {
    const _formatProcessDuration = () => '3s';
    const t = (key, vars = {}) => ({ key, ...vars });
    ${durationSource}
    return ${fnSource};
  })()`, {});
}

describe('conversation activity status mapping', () => {
  const statusFrom = loadStatusMapper();

  it('projects a tool start into a named tool call with its target', () => {
    expect(statusFrom({
      stream: 'tool',
      data: { phase: 'start', name: 'read_file', arguments: { path: 'src/main/index.ts' } },
    })).toEqual({
      key: 'tool_calling',
      toolName: 'read_file',
      detail: 'src/main/index.ts',
      action: 'read',
    });
  });

  it('keeps tool progress on the same current-action status', () => {
    expect(statusFrom({
      stream: 'tool',
      data: { phase: 'progress', name: 'generate_image', message: 'waiting for result' },
    })).toEqual({
      key: 'tool_calling',
      toolName: 'generate_image',
      detail: 'waiting for result',
      action: 'use',
    });
  });

  it('classifies common tools so the terminal summary can say what happened', () => {
    expect(statusFrom({
      stream: 'tool',
      data: { phase: 'end', name: 'read_file', arguments: { path: 'package.json' } },
    })).toMatchObject({
      key: 'tool_completed',
      toolName: 'read_file',
      detail: 'package.json',
      action: 'read',
      impact: 'unchanged',
    });
    expect(statusFrom({
      stream: 'tool',
      data: { phase: 'end', name: 'write_file', arguments: { path: 'package.json' } },
    })).toMatchObject({
      key: 'tool_completed',
      toolName: 'write_file',
      detail: 'package.json',
      action: 'write',
      impact: 'modified',
    });
    expect(statusFrom({
      stream: 'tool',
      data: { phase: 'done', name: 'read_file', arguments: { path: 'README.md' } },
    })).toMatchObject({
      key: 'tool_completed',
      action: 'read',
    });
    expect(statusFrom({
      stream: 'cli',
      data: {
        type: 'tool-event',
        tool: 'exec_command',
        phase: 'result',
        input: { command: 'npm run typecheck' },
      },
    })).toMatchObject({
      key: 'tool_completed',
      toolName: 'exec_command',
      detail: 'npm run typecheck',
      action: 'run',
    });
    expect(statusFrom({
      stream: 'cli',
      data: { type: 'tool-event', tool: 'Read', phase: 'use', input: { path: 'README.md' } },
    })).toMatchObject({ action: 'read' });
    expect(statusFrom({
      stream: 'cli',
      data: { type: 'tool-event', tool: 'Write', phase: 'use', input: { path: 'README.md' } },
    })).toMatchObject({ action: 'write' });
    expect(statusFrom({
      stream: 'cli',
      data: { type: 'tool-event', tool: 'Bash', phase: 'use', input: { command: 'npm test' } },
    })).toMatchObject({ action: 'run' });
  });

  it('distinguishes planning, permission wait, generation, and retry', () => {
    expect(statusFrom({ stream: 'plan', data: { phase: 'start' } })).toEqual({ key: 'planning' });
    expect(statusFrom({ stream: 'approval', data: { phase: 'request' } })).toEqual({ key: 'waiting_permission' });
    expect(statusFrom({ stream: 'assistant', data: { delta: 'hello' } })).toEqual({ key: 'generating' });
    expect(statusFrom({ stream: 'runtime', data: { phase: 'retrying', attempt: 2 } })).toEqual({
      key: 'retrying',
      attempt: 2,
    });
  });

  it('maps the real local CLI tool-event shape and preserves a useful target', () => {
    expect(statusFrom({
      stream: 'cli',
      data: {
        type: 'tool-event',
        tool: 'exec_command',
        phase: 'use',
        input: { command: 'npm run typecheck' },
      },
    })).toEqual({
      key: 'tool_calling',
      toolName: 'exec_command',
      detail: 'npm run typecheck',
      action: 'run',
    });
    expect(statusFrom({
      stream: 'cli',
      data: {
        type: 'tool-event',
        tool: 'exec_command',
        phase: 'result',
        isError: true,
        error: 'exit code 1',
      },
    })).toEqual({
      key: 'failed',
      toolName: 'exec_command',
      detail: 'exit code 1',
      action: 'run',
    });
  });

  it('projects CLI permission decisions without exposing raw input as reasoning', () => {
    expect(statusFrom({
      stream: 'cli',
      data: { type: 'permission-request', tool: 'write_file', autoDecided: 'allow' },
    })).toEqual({ key: 'permission_granted', toolName: 'write_file' });
    expect(statusFrom({
      stream: 'cli',
      data: { type: 'permission-request', tool: 'write_file', autoDecided: 'deny' },
    })).toEqual({ key: 'permission_denied', toolName: 'write_file' });
  });

  it('does not expose assistant text for unrecognised execution events', () => {
    expect(statusFrom({ stream: 'item', data: { text: 'private chain of thought' } })).toEqual({ key: 'working' });
    expect(statusFrom({ stream: 'unknown', data: { text: 'internal detail' } })).toEqual({ key: 'working' });
  });

  it('does not flatten arbitrary tool arguments into the always-visible line', () => {
    expect(statusFrom({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'call_connector_tool',
        arguments: { action: 'send', access_token: 'sensitive-token' },
      },
    })).toEqual({
      key: 'tool_calling',
      toolName: 'call_connector_tool',
      detail: '',
      action: 'use',
    });
    expect(statusFrom({
      stream: 'cli',
      data: {
        type: 'tool-event',
        tool: 'Bash',
        phase: 'use',
        input: { command: 'curl -H "Authorization: Bearer private-value" https://example.com' },
      },
    })).toEqual({
      key: 'tool_calling',
      toolName: 'Bash',
      detail: '',
      action: 'run',
    });
  });

  it('summarizes completion by the last concrete operation instead of a bare counter', () => {
    const terminalText = loadTerminalFormatter();
    expect(terminalText({
      _activitySummary: { toolName: 'read_file', detail: 'package.json', action: 'read' },
    }, 'completed')).toEqual({
      key: 'chat.activity_read_done',
      target: 'package.json',
      duration: '3s',
    });
    expect(terminalText({
      _activitySummary: { toolName: 'write_file', detail: 'src/app.js', action: 'write' },
    }, 'completed')).toEqual({
      key: 'chat.activity_write_done',
      target: 'src/app.js',
      duration: '3s',
    });
  });

  it('summarizes failure and cancellation with the affected operation', () => {
    const terminalText = loadTerminalFormatter();
    expect(terminalText({
      _activitySummary: { toolName: 'exec_command', detail: 'npm test', action: 'run' },
    }, 'failed', 'exit code 1')).toEqual({
      key: 'chat.activity_run_failed',
      target: 'npm test',
      duration: '3s',
    });
    expect(terminalText({
      _activitySummary: { toolName: 'write_file', detail: 'src/app.js', action: 'write' },
    }, 'cancelled')).toEqual({
      key: 'chat.activity_write_stopped',
      target: 'src/app.js',
    });
  });
});
