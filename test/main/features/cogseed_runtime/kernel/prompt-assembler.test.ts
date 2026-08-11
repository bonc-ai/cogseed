import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/cogseed_runtime/kernel/config';
import {
  assembleRuntimePrompt,
  buildRuntimeSystemPrompt,
  redactTranscriptPathHints,
} from '../../../../../src/main/features/cogseed_runtime/kernel/prompt-assembler';
import type { RuntimeKernelRequest } from '../../../../../src/main/features/cogseed_runtime/kernel/types';

function request(overrides: Partial<RuntimeKernelRequest> = {}): RuntimeKernelRequest {
  return {
    userId: 'u1',
    requestId: 'req-prompt',
    runtimeSessionId: 'mruntime-prompt',
    task: 'Summarize the explicit material.',
    context: [],
    attachments: [],
    readOnlyRoots: [],
    writableRoots: [],
    toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    ...overrides,
  };
}

describe('native Runtime prompt assembler', () => {
  it('builds a short stable system prompt with explicit-only rules', () => {
    expect(buildRuntimeSystemPrompt()).toContain('Mate Agent Runtime worker');
    expect(buildRuntimeSystemPrompt()).toContain('explicit task, context, and attachments');
    expect(buildRuntimeSystemPrompt()).not.toContain('/Users/');
  });

  it('formats an empty-context request without inventing history', () => {
    const prompt = assembleRuntimePrompt({ request: request() });
    expect(prompt.system).toContain('Mate Agent Runtime worker');
    expect(prompt.user).toContain('## Task');
    expect(prompt.user).toContain('Summarize the explicit material.');
    expect(prompt.user).toContain('No explicit context was provided.');
    expect(prompt.user).not.toContain('gconv');
    expect(prompt.user).not.toContain('group_chat');
  });

  it('includes explicit text context and opaque file references', () => {
    const prompt = assembleRuntimePrompt({
      request: request(),
      context: {
        textSections: [{ id: 'ctx-1', label: 'note', text: 'Alpha' }],
        fileRefs: [{ id: 'file-1', label: 'draft.md', kind: 'context_file', preview: 'Preview text' }],
        diagnostics: { inputContextCount: 1, inputAttachmentCount: 0, truncated: false },
      },
    });
    expect(prompt.user).toContain('Alpha');
    expect(prompt.user).toContain('file-1');
    expect(prompt.user).toContain('Preview text');
    expect(prompt.user).not.toContain('/tmp/draft.md');
  });

  it('includes optional memory summary as explicit runtime memory', () => {
    const prompt = assembleRuntimePrompt({ request: request(), memorySummary: 'Prefer concise answers.' });
    expect(prompt.user).toContain('## Runtime memory');
    expect(prompt.user).toContain('Prefer concise answers.');
  });


  it('preserves normal slash text and URLs while sanitizing prompt inputs', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Compare input/output, and/or choices, 1/2 ratios, https://example.com/docs, and GET /api/v1/users.' }),
      context: {
        textSections: [{ id: 'ctx-1', text: 'Keep alpha/beta and http://localhost/docs visible.' }],
        fileRefs: [{ id: 'file-1', label: 'safe.md', kind: 'attachment', preview: 'Use before/after notes from https://example.com/preview.' }],
        diagnostics: { inputContextCount: 1, inputAttachmentCount: 1, truncated: false },
      },
      memorySummary: 'User says yes/no and 3/4 should remain readable.',
    });

    expect(prompt.user).toContain('input/output');
    expect(prompt.user).toContain('and/or');
    expect(prompt.user).toContain('1/2');
    expect(prompt.user).toContain('https://example.com/docs');
    expect(prompt.user).toContain('GET /api/v1/users');
    expect(prompt.user).toContain('alpha/beta');
    expect(prompt.user).toContain('http://localhost/docs');
    expect(prompt.user).toContain('https://example.com/preview');
    expect(prompt.user).toContain('yes/no');
    expect(prompt.user).toContain('3/4');
    expect(prompt.user).not.toContain('[redacted-absolute-path]');
  });

  it('redacts obvious absolute filesystem paths from prompt inputs', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Do not reveal /Users/alice/private/file.txt' }),
      context: {
        textSections: [{ id: 'ctx-1', text: 'Temporary file /tmp/secret.txt is sensitive.' }],
        fileRefs: [{ id: 'file-1', label: 'safe.md', kind: 'attachment', preview: 'Runtime artifact /var/folders/x/session.jsonl' }],
        diagnostics: { inputContextCount: 1, inputAttachmentCount: 1, truncated: false },
      },
    });

    expect(prompt.user).toContain('[redacted-absolute-path]');
    expect(prompt.user).not.toContain('/Users/alice/private/file.txt');
    expect(prompt.user).not.toContain('/tmp/secret.txt');
    expect(prompt.user).not.toContain('/var/folders/x/session.jsonl');
  });



  it('redacts expanded Unix filesystem roots from task text context and memory', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Do not expose /Applications/App/foo.txt' }),
      context: {
        textSections: [{ id: 'ctx-1', text: 'Library path /Library/Application Support/x is private.' }],
        fileRefs: [],
        diagnostics: { inputContextCount: 1, inputAttachmentCount: 0, truncated: false },
      },
      memorySummary: 'Workspace path /workspace/project/file.txt should stay hidden.',
    });

    expect(prompt.user).toContain('[redacted-absolute-path]');
    expect(prompt.user).not.toContain('/Applications/App/foo.txt');
    expect(prompt.user).not.toContain('/Library/Application Support/x');
    expect(prompt.user).not.toContain('/workspace/project/file.txt');
  });


  it('redacts Windows absolute paths with spaces from task text context and memory without tail fragments', () => {
    const programFilesPath = 'C:\\Program Files\\App\\secret.txt';
    const userPath = 'C:\\Users\\Alice Smith\\secret.txt';
    const memoryPath = 'D:\\Work Items\\Project A\\notes.md';
    const prompt = assembleRuntimePrompt({
      request: request({ task: `Do not expose ${programFilesPath} in task text.` }),
      context: {
        textSections: [{ id: 'ctx-1', text: `Context contains ${userPath} here.` }],
        fileRefs: [],
        diagnostics: { inputContextCount: 1, inputAttachmentCount: 0, truncated: false },
      },
      memorySummary: `Memory references ${memoryPath} too.`,
    });

    expect(prompt.user).toContain('[redacted-absolute-path]');
    expect(prompt.user).not.toContain(programFilesPath);
    expect(prompt.user).not.toContain('Files\\App\\secret.txt');
    expect(prompt.user).not.toContain(userPath);
    expect(prompt.user).not.toContain('Smith\\secret.txt');
    expect(prompt.user).not.toContain(memoryPath);
    expect(prompt.user).not.toContain('Items\\Project A\\notes.md');
  });

  it('redacts embedded absolute filesystem paths from file labels and previews', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Use the listed file refs.' }),
      context: {
        textSections: [],
        fileRefs: [
          {
            id: 'file-1',
            label: 'path=/Users/alice/private/file.txt',
            kind: 'context_file',
            preview: 'source=C:\\Users\\alice\\secret.txt',
          },
        ],
        diagnostics: { inputContextCount: 0, inputAttachmentCount: 1, truncated: false },
      },
    });

    expect(prompt.user).toContain('path=[redacted-absolute-path]');
    expect(prompt.user).toContain('source=[redacted-absolute-path]');
    expect(prompt.user).not.toContain('/Users/alice/private/file.txt');
    expect(prompt.user).not.toContain('C:\\Users\\alice\\secret.txt');
  });


  it('redacts single-segment Unix root paths and UNC paths from embedded values', () => {
    const uncPath = String.raw`\\server\share\secret.txt`;
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Use provided refs.' }),
      context: {
        textSections: [],
        fileRefs: [
          {
            id: 'file-1',
            label: 'path=/tmp',
            kind: 'attachment',
            preview: `source=${uncPath}`,
          },
        ],
        diagnostics: { inputContextCount: 0, inputAttachmentCount: 1, truncated: false },
      },
    });

    expect(prompt.user).toContain('path=[redacted-absolute-path]');
    expect(prompt.user).toContain('source=[redacted-absolute-path]');
    expect(prompt.user).not.toContain('path=/tmp');
    expect(prompt.user).not.toContain(uncPath);
  });



  it('preserves API route text in file previews', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Review preview route text.' }),
      context: {
        textSections: [],
        fileRefs: [
          {
            id: 'file-1',
            label: 'routes.md',
            kind: 'attachment',
            preview: 'Endpoint example: GET /api/v1/users should remain visible.',
          },
        ],
        diagnostics: { inputContextCount: 0, inputAttachmentCount: 1, truncated: false },
      },
    });

    expect(prompt.user).toContain('GET /api/v1/users');
    expect(prompt.user).not.toContain('GET [redacted-absolute-path]');
  });


  it('preserves keyed API route text in file previews', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Review route metadata.' }),
      context: {
        textSections: [],
        fileRefs: [
          {
            id: 'file-1',
            label: 'routes.md',
            kind: 'attachment',
            preview: 'route metadata path=/api/v1/users remains an API route.',
          },
        ],
        diagnostics: { inputContextCount: 0, inputAttachmentCount: 1, truncated: false },
      },
    });

    expect(prompt.user).toContain('path=/api/v1/users');
    expect(prompt.user).not.toContain('path=[redacted-absolute-path]');
  });

  it('redacts uncommon Unix absolute paths from file labels and previews', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'GET /api/v1/users should remain in general task text.' }),
      context: {
        textSections: [],
        fileRefs: [
          {
            id: 'file-1',
            label: 'path=/Applications/App/foo.txt',
            kind: 'context_file',
            preview: 'source=/Library/Application Support/x',
          },
          {
            id: 'file-2',
            label: 'workspace.md',
            kind: 'attachment',
            preview: 'source=/workspace/project/file.txt',
          },
        ],
        diagnostics: { inputContextCount: 0, inputAttachmentCount: 2, truncated: false },
      },
    });

    expect(prompt.user).toContain('GET /api/v1/users');
    expect(prompt.user).toContain('path=[redacted-absolute-path]');
    expect(prompt.user).toContain('source=[redacted-absolute-path]');
    expect(prompt.user).not.toContain('/Applications/App/foo.txt');
    expect(prompt.user).not.toContain('/Library/Application Support/x');
    expect(prompt.user).not.toContain('/workspace/project/file.txt');
  });

  it('redacts transcript-shaped path hints from all prompt text inputs', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Read cloud/chats/gconv-secret.jsonl and local/mate_runtime/sessions/mruntime-secret.jsonl' }),
      context: {
        textSections: [{ id: 'ctx-1', text: 'Also see cloud/sessions/gmember-secret.jsonl' }],
        fileRefs: [{ id: 'file-1', label: 'safe.md', kind: 'attachment', preview: 'Project path cloud/projects/p1/chats/c1/visibility/a.jsonl' }],
        diagnostics: { inputContextCount: 1, inputAttachmentCount: 1, truncated: false },
      },
      memorySummary: 'Do not copy local/sessions/anon-secret.jsonl',
    });
    expect(prompt.user).toContain('[redacted-transcript-path]');
    expect(prompt.user).not.toContain('gconv-secret.jsonl');
    expect(prompt.user).not.toContain('gmember-secret.jsonl');
    expect(prompt.user).not.toContain('mruntime-secret.jsonl');
    expect(prompt.user).not.toContain('anon-secret.jsonl');
    expect(prompt.user).not.toContain('visibility/a.jsonl');
  });

  it('redacts transcript hints through the exported helper', () => {
    expect(redactTranscriptPathHints('open cloud/projects/p1/sessions/gmember-a.jsonl'))
      .toBe('open [redacted-transcript-path]');
  });

  it('reports diagnostics without raw content', () => {
    const prompt = assembleRuntimePrompt({ request: request() });
    expect(prompt.diagnostics).toEqual(expect.objectContaining({ textChars: expect.any(Number), fileRefCount: 0 }));
    expect(JSON.stringify(prompt.diagnostics)).not.toContain('Summarize the explicit material.');
  });
});
