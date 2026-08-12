import type { RuntimeKernelRequest } from './types';

export interface RuntimePromptTextSection {
  id: string;
  label?: string;
  text: string;
}

export interface RuntimePromptFileRef {
  id: string;
  label: string;
  kind: 'context_file' | 'attachment';
  preview?: string;
}

export interface AssembledRuntimeContext {
  textSections: RuntimePromptTextSection[];
  fileRefs: RuntimePromptFileRef[];
  diagnostics: {
    inputContextCount: number;
    inputAttachmentCount: number;
    truncated: boolean;
  };
}

export interface RuntimePromptAssemblyResult {
  system: string;
  user: string;
  diagnostics: {
    textChars: number;
    fileRefCount: number;
    truncated: boolean;
  };
}

const REDACTED_TRANSCRIPT_PATH = '[redacted-transcript-path]';
const REDACTED_ABSOLUTE_PATH = '[redacted-absolute-path]';

const TRANSCRIPT_PATH_PATTERN =
  /(?:(?:[A-Za-z]:[\\/]|\/)[^\s`"'<>]*?)?(?:(?:cloud\/(?:projects\/[^\s`"'<>/]+\/)?(?:chats|sessions)\/[^\s`"'<>]*?\.jsonl)|(?:local\/(?:mate_runtime\/)?sessions\/[^\s`"'<>]*?\.jsonl))/g;
const UNIX_FILESYSTEM_ROOTS = [
  'Users',
  'home',
  'tmp',
  'var',
  'private',
  'etc',
  'opt',
  'Volumes',
  'mnt',
  'run',
  'usr',
  'Applications',
  'Library',
  'workspace',
] as const;

const ABSOLUTE_PATH_BOUNDARY_PATTERN = "(^|[\\s([{<=:\"'`;,])";
const PATH_END_BOUNDARY_PATTERN = "(?=$|[\\s`\"'<>),.?!\\]}])";
const PATH_SEGMENT_PATTERN = "[^\\s`\"'<>/\\\\]+";
const PATH_SEGMENT_WITH_INTERNAL_SPACES_PATTERN = `${PATH_SEGMENT_PATTERN}(?: ${PATH_SEGMENT_PATTERN})*`;
const UNIX_FILESYSTEM_ROOT_PATTERN = UNIX_FILESYSTEM_ROOTS.join('|');
const UNIX_ABSOLUTE_PATH_PATTERN = new RegExp(
  ABSOLUTE_PATH_BOUNDARY_PATTERN
    + `\\/(?:${UNIX_FILESYSTEM_ROOT_PATTERN})(?:\\/${PATH_SEGMENT_WITH_INTERNAL_SPACES_PATTERN})*${PATH_END_BOUNDARY_PATTERN}`,
  'g',
);
const WINDOWS_DRIVE_PATH_SEGMENT_PATTERN = "[^\\\\/\\r\\n`\\\"'<>]+";
const WINDOWS_DRIVE_FINAL_SEGMENT_PATTERN = "[^\\\\/\\s\\r\\n`\\\"'<>),.?!;\\]}]+(?:\\.[^\\\\/\\s\\r\\n`\\\"'<>),.?!;\\]}]+)?";
const WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN = new RegExp(
  ABSOLUTE_PATH_BOUNDARY_PATTERN
    + `[A-Za-z]:[\\\\/](?:${WINDOWS_DRIVE_PATH_SEGMENT_PATTERN}[\\\\/])+${WINDOWS_DRIVE_FINAL_SEGMENT_PATTERN}`,
  'g',
);
const WINDOWS_UNC_ABSOLUTE_PATH_PATTERN = new RegExp(
  ABSOLUTE_PATH_BOUNDARY_PATTERN + `\\\\\\\\${PATH_SEGMENT_PATTERN}\\\\${PATH_SEGMENT_PATTERN}(?:\\\\${PATH_SEGMENT_PATTERN})*`,
  'g',
);

const FILE_METADATA_WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN = new RegExp(
  ABSOLUTE_PATH_BOUNDARY_PATTERN + "[A-Za-z]:[\\\\/][^\\r\\n`\\\"'<>),;\\]}]+",
  'g',
);
const FILE_METADATA_WINDOWS_UNC_ABSOLUTE_PATH_PATTERN = new RegExp(
  ABSOLUTE_PATH_BOUNDARY_PATTERN + "\\\\\\\\[^\\r\\n`\\\"'<>),;\\]}]+",
  'g',
);

export function buildRuntimeSystemPrompt(): string {
  return [
    'You are the CogSeed Runtime worker.',
    'Use only the explicit task, context, and attachments provided in this prompt.',
    'Do not infer hidden conversation history, private filesystem locations, or unavailable files.',
    'When information is missing, say what is missing and proceed from the explicit material only.',
  ].join('\n');
}

export function redactTranscriptPathHints(text: string): string {
  return text.replace(TRANSCRIPT_PATH_PATTERN, REDACTED_TRANSCRIPT_PATH);
}

function redactGeneralAbsolutePathHints(text: string): string {
  return text
    .replace(WINDOWS_UNC_ABSOLUTE_PATH_PATTERN, (_match, boundary: string) => `${boundary}${REDACTED_ABSOLUTE_PATH}`)
    .replace(WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN, (_match, boundary: string) => `${boundary}${REDACTED_ABSOLUTE_PATH}`)
    .replace(UNIX_ABSOLUTE_PATH_PATTERN, (_match, boundary: string) => `${boundary}${REDACTED_ABSOLUTE_PATH}`);
}

function safeText(text: string): string {
  return redactGeneralAbsolutePathHints(redactTranscriptPathHints(text));
}

function redactFileMetadataAbsolutePathHints(text: string): string {
  return text
    .replace(FILE_METADATA_WINDOWS_UNC_ABSOLUTE_PATH_PATTERN, (_match, boundary: string) => `${boundary}${REDACTED_ABSOLUTE_PATH}`)
    .replace(FILE_METADATA_WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN, (_match, boundary: string) => `${boundary}${REDACTED_ABSOLUTE_PATH}`)
    .replace(UNIX_ABSOLUTE_PATH_PATTERN, (_match, boundary: string) => `${boundary}${REDACTED_ABSOLUTE_PATH}`);
}

function safeFileMetadataText(text: string): string {
  return redactFileMetadataAbsolutePathHints(redactTranscriptPathHints(text));
}

function renderTextSection(section: RuntimePromptTextSection): string {
  const headerParts = [`- id: ${safeText(section.id)}`];
  if (section.label) {
    headerParts.push(`label: ${safeText(section.label)}`);
  }

  return `${headerParts.join(', ')}\n${safeText(section.text)}`;
}

function renderFileRef(fileRef: RuntimePromptFileRef): string {
  const lines = [
    `- id: ${safeFileMetadataText(fileRef.id)}`,
    `  label: ${safeFileMetadataText(fileRef.label)}`,
    `  kind: ${fileRef.kind}`,
  ];

  if (fileRef.preview) {
    lines.push(`  preview: ${safeFileMetadataText(fileRef.preview)}`);
  }

  return lines.join('\n');
}

export function assembleRuntimePrompt(input: {
  request: RuntimeKernelRequest;
  context?: AssembledRuntimeContext;
  memorySummary?: string;
}): RuntimePromptAssemblyResult {
  const system = buildRuntimeSystemPrompt();
  const textSections = input.context?.textSections ?? [];
  const fileRefs = input.context?.fileRefs ?? [];
  const userSections = ['## Task', safeText(input.request.task), '## Explicit context'];

  if (textSections.length === 0 && fileRefs.length === 0) {
    userSections.push('No explicit context was provided.');
  } else {
    if (textSections.length > 0) {
      userSections.push(textSections.map(renderTextSection).join('\n\n'));
    }

    if (fileRefs.length > 0) {
      userSections.push('## Explicit files', fileRefs.map(renderFileRef).join('\n\n'));
    }
  }

  if (input.memorySummary) {
    userSections.push('## Runtime memory', safeText(input.memorySummary));
  }

  const user = userSections.join('\n\n');

  return {
    system,
    user,
    diagnostics: {
      textChars: system.length + user.length,
      fileRefCount: fileRefs.length,
      truncated: input.context?.diagnostics.truncated ?? false,
    },
  };
}
