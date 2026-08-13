import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as paths from '../../../../src/main/paths';
import {
  MATE_AGENT_RUNTIME_PROTOCOL_VERSION,
  buildRuntimePrompt,
  normalizeRuntimeRunRequest,
} from '../../../../src/main/features/cogseed_runtime/protocol';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-runtime-protocol-'));
  cleanup.push(dir);
  return dir;
}

describe('CogSeed Runtime protocol normalization', () => {
  it('accepts only explicit task, context, attachments and generates runtime ids', () => {
    const root = tmpRoot();
    const allowedFile = path.join(root, 'notes.txt');
    fs.writeFileSync(allowedFile, 'hello');

    const result = normalizeRuntimeRunRequest('runtime-protocol-user', {
      task: 'Summarize this explicit input.',
      context: [{ type: 'text', content: 'Only this context.' }],
      attachments: [{ type: 'file', path: allowedFile, name: 'notes.txt' }],
      agent_id: 'agent_runtime',
      execution_kind: 'cogseed-native',
      allowed_skill_ids: ['skill-alpha', 'skill-beta', 'skill-alpha'],
    }, { allowedRoots: [root] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.request.protocol_version).toBe(MATE_AGENT_RUNTIME_PROTOCOL_VERSION);
    expect(result.request.request_id).toMatch(/^req-/);
    expect(result.request.runtime_session_id).toMatch(/^mruntime-/);
    expect(result.request.execution_kind).toBe('cogseed-native');
    expect(result.request.allowed_skill_ids).toEqual(['skill-alpha', 'skill-beta']);
    expect(result.request.task).toBe('Summarize this explicit input.');
    expect(result.request.context).toEqual([{ type: 'text', content: 'Only this context.' }]);
    expect(result.request.attachments?.[0].path).toBe(allowedFile);
    expect(result.request).not.toHaveProperty('cid');
  });

  it('rejects Backend-owned local CLI execution at the native Runtime boundary', () => {
    const result = normalizeRuntimeRunRequest('runtime-protocol-user', {
      task: 'Run through a local CLI.',
      execution_kind: 'local-cli',
    }, { allowedRoots: [] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected local CLI rejection');
    expect(result.error).toMatch(/backend|local CLI/i);
  });

  it('rejects caller supplied CogSeed conversation identity fields', () => {
    const root = tmpRoot();
    const result = normalizeRuntimeRunRequest('runtime-protocol-user', {
      task: 'Do not accept this.',
      cid: 'gconv-secret',
    }, { allowedRoots: [root] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.code).toBe('E_RUNTIME_FORBIDDEN_FIELD');
  });

  it('passes known capability grants through and rejects unknown ones', () => {
    const root = tmpRoot();
    const ok = normalizeRuntimeRunRequest('runtime-protocol-user', {
      task: 'Run with grants.',
      capabilities: ['messaging.proactive'],
    }, { allowedRoots: [root] });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.request.capabilities).toEqual(['messaging.proactive']);

    const bad = normalizeRuntimeRunRequest('runtime-protocol-user', {
      task: 'Fabricate grants.',
      capabilities: ['messaging.proactive', 'sudo.everything'],
    }, { allowedRoots: [root] });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected rejection');
    expect(bad.code).toBe('E_RUNTIME_INVALID_REQUEST');

    const bounded = normalizeRuntimeRunRequest('runtime-protocol-user', {
      task: 'Overflow grants.',
      capabilities: Array.from({ length: 9 }, () => 'messaging.proactive'),
    }, { allowedRoots: [root] });
    expect(bounded.ok).toBe(false);
    if (bounded.ok) throw new Error('expected rejection');
    expect(bounded.code).toBe('E_RUNTIME_INVALID_REQUEST');
  });

  it('rejects cloud chat and session transcript paths even when the caller passes a broad root', () => {
    const uid = 'runtime-protocol-transcript';
    const chatFile = path.join(paths.userChatsDir(uid), 'gconv-secret.jsonl');
    const sessionFile = paths.userSessionFile(uid, 'gconv-secret');
    fs.mkdirSync(path.dirname(chatFile), { recursive: true });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(chatFile, '{"role":"user","text":"secret"}\n');
    fs.writeFileSync(sessionFile, '{"role":"user","content":"secret"}\n');
    cleanup.push(paths.userRoot(uid));

    const chat = normalizeRuntimeRunRequest(uid, {
      task: 'Read this file.',
      attachments: [{ type: 'file', path: chatFile }],
    }, { allowedRoots: [paths.userRoot(uid)] });
    const session = normalizeRuntimeRunRequest(uid, {
      task: 'Read this file.',
      context: [{ type: 'file', path: sessionFile }],
    }, { allowedRoots: [paths.userRoot(uid)] });

    expect(chat.ok).toBe(false);
    expect(session.ok).toBe(false);
    if (chat.ok || session.ok) throw new Error('expected transcript path rejection');
    expect(chat.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
    expect(session.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
  });

  it('rejects local CogSeed Runtime session transcript paths even when the caller passes a broad root', () => {
    const uid = 'runtime-protocol-local-runtime-transcript';
    const runtimeSessionFile = paths.mateRuntimeSessionFile(uid, 'mruntime-secret');
    fs.mkdirSync(path.dirname(runtimeSessionFile), { recursive: true });
    fs.writeFileSync(runtimeSessionFile, '{"role":"assistant","content":"runtime secret"}\n');
    cleanup.push(paths.userRoot(uid));

    const result = normalizeRuntimeRunRequest(uid, {
      task: 'Read this runtime file.',
      attachments: [{ type: 'file', path: runtimeSessionFile }],
    }, { allowedRoots: [paths.userRoot(uid)] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected transcript path rejection');
    expect(result.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
  });

  it('rejects local core-agent session transcript paths as context even when the caller passes a broad root', () => {
    const uid = 'runtime-protocol-local-session-transcript';
    const localSessionFile = paths.userLocalSessionFile(uid, 'anon-secret');
    fs.mkdirSync(path.dirname(localSessionFile), { recursive: true });
    fs.writeFileSync(localSessionFile, '{"role":"assistant","content":"local secret"}\n');
    cleanup.push(paths.userRoot(uid));

    const result = normalizeRuntimeRunRequest(uid, {
      task: 'Read this local session file.',
      context: [{ type: 'file', path: localSessionFile }],
    }, { allowedRoots: [paths.userRoot(uid)] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected transcript path rejection');
    expect(result.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
  });

  it('rejects project-scoped cloud transcript paths even when the caller passes a broad root', () => {
    const uid = 'runtime-protocol-project-transcript';
    const chatFile = paths.projectChatJsonlFile(uid, 'project-secret', 'gconv-secret');
    const sessionFile = paths.projectSessionFile(uid, 'project-secret', 'gconv-secret');
    fs.mkdirSync(path.dirname(chatFile), { recursive: true });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(chatFile, '{"role":"user","text":"project chat secret"}\n');
    fs.writeFileSync(sessionFile, '{"role":"user","content":"project session secret"}\n');
    cleanup.push(paths.userRoot(uid));

    const chat = normalizeRuntimeRunRequest(uid, {
      task: 'Read this project chat file.',
      attachments: [{ type: 'file', path: chatFile }],
    }, { allowedRoots: [paths.userRoot(uid)] });
    const session = normalizeRuntimeRunRequest(uid, {
      task: 'Read this project session file.',
      context: [{ type: 'file', path: sessionFile }],
    }, { allowedRoots: [paths.userRoot(uid)] });

    expect(chat.ok).toBe(false);
    expect(session.ok).toBe(false);
    if (chat.ok || session.ok) throw new Error('expected transcript path rejection');
    expect(chat.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
    expect(session.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
  });

  it('rejects nested project group-chat visibility transcript slices even when the caller passes a broad root', () => {
    const uid = 'runtime-protocol-project-visibility-transcript';
    const visibilityFile = path.join(paths.projectGroupChatVisibilityDir(uid, 'project-secret', 'gconv-secret'), 'agent-a.jsonl');
    fs.mkdirSync(path.dirname(visibilityFile), { recursive: true });
    fs.writeFileSync(visibilityFile, '{"role":"assistant","content":"visibility secret"}\n');
    cleanup.push(paths.userRoot(uid));

    const attachment = normalizeRuntimeRunRequest(uid, {
      task: 'Read this project visibility file.',
      attachments: [{ type: 'file', path: visibilityFile }],
    }, { allowedRoots: [paths.userRoot(uid)] });
    const context = normalizeRuntimeRunRequest(uid, {
      task: 'Read this project visibility file.',
      context: [{ type: 'file', path: visibilityFile }],
    }, { allowedRoots: [paths.userRoot(uid)] });

    expect(attachment.ok).toBe(false);
    expect(context.ok).toBe(false);
    if (attachment.ok || context.ok) throw new Error('expected transcript path rejection');
    expect(attachment.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
    expect(context.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
  });

  it('rejects symlink aliases to project transcripts even when the alias sits outside transcript directories', () => {
    const uid = 'runtime-protocol-project-symlink-transcript';
    const realTranscript = paths.projectChatJsonlFile(uid, 'project-secret', 'gconv-secret');
    const alias = path.join(paths.userCloudRoot(uid), 'contexts', 'project-chat-alias.jsonl');
    fs.mkdirSync(path.dirname(realTranscript), { recursive: true });
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.writeFileSync(realTranscript, '{"role":"user","text":"project chat secret"}\n');
    try {
      fs.symlinkSync(realTranscript, alias);
    } catch (error) {
      cleanup.push(paths.userRoot(uid));
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') {
        return;
      }
      throw error;
    }
    cleanup.push(paths.userRoot(uid));

    const result = normalizeRuntimeRunRequest(uid, {
      task: 'Read this symlinked project chat file.',
      attachments: [{ type: 'file', path: alias }],
    }, { allowedRoots: [paths.userRoot(uid)] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected transcript path rejection');
    expect(result.code).toBe('E_RUNTIME_TRANSCRIPT_PATH');
  });

  it('allows non-jsonl files under project chat directories when they are explicitly sandboxed', () => {
    const uid = 'runtime-protocol-project-non-jsonl';
    const file = path.join(paths.projectGroupChatVisibilityDir(uid, 'project-secret', 'gconv-secret'), 'notes.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'non-transcript notes');
    cleanup.push(paths.userRoot(uid));

    const result = normalizeRuntimeRunRequest(uid, {
      task: 'Read this explicit non-transcript file.',
      attachments: [{ type: 'file', path: file }],
    }, { allowedRoots: [paths.userRoot(uid)] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.request.attachments[0].path).toBe(file);
  });

  it('rejects file context outside the explicit path sandbox', () => {
    const root = tmpRoot();
    const other = tmpRoot();
    const file = path.join(other, 'outside.txt');
    fs.writeFileSync(file, 'outside');

    const result = normalizeRuntimeRunRequest('runtime-protocol-user', {
      task: 'Use explicit file.',
      attachments: [{ type: 'file', path: file }],
    }, { allowedRoots: [root] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.code).toBe('E_RUNTIME_PATH_DENIED');
  });

  it('builds the model prompt from task and explicit context only', () => {
    const prompt = buildRuntimePrompt({
      task: 'Answer the question.',
      context: [{ type: 'text', content: 'Context A' }, { type: 'text', content: 'Context B', label: 'b' }],
      attachments: [{ type: 'file', path: '/tmp/file.txt', name: 'file.txt' }],
    } as any);

    expect(prompt).toContain('Answer the question.');
    expect(prompt).toContain('Context A');
    expect(prompt).toContain('Context B');
    expect(prompt).toContain('file.txt');
    expect(prompt).not.toContain('gconv-');
    expect(prompt).not.toContain('cloud/chats');
  });
});
