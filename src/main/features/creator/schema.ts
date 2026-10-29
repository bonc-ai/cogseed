import type {
  CreatorAgentInput,
  CreatorAgentInputOption,
  CreatorAgentInputType,
  CreatorPresetManifestV1,
  CreatorSchemaIssue,
  CreatorSchemaResult,
} from './types';

const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const AGENT_INPUT_TYPES = ['text', 'textarea', 'select', 'multiselect', 'number', 'boolean', 'file', 'directory'] as const;
const AGENT_INPUT_KEYS = [
  'id', 'label', 'description', 'type', 'required', 'default', 'default_by_ui_language',
  'options', 'placeholder', 'min', 'max', 'multiple', 'accept',
] as const;
const AGENT_INPUT_OPTION_KEYS = ['value', 'label'] as const;
const AGENT_INPUT_UI_LANGS = ['zh', 'en', 'ja', 'pt'] as const;
const MAX_AGENT_INPUTS = 32;
const MAX_AGENT_INPUT_OPTIONS = 64;
const MAX_INPUT_DEFAULT_ITEMS = 64;
const MAX_NUMERIC_INPUT_VALUE = 1_000_000_000_000;
const ACCEPT_LIST = /^(?:\.[A-Za-z0-9]+|[A-Za-z0-9.+-]+\/(?:[A-Za-z0-9.+-]+|\*))(?:,(?:\.[A-Za-z0-9]+|[A-Za-z0-9.+-]+\/(?:[A-Za-z0-9.+-]+|\*)))*$/;
const SAFE_ISSUE_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const MAX_RECURSIVE_COLLECTION_ITEMS = 256;
const MAX_RECURSIVE_NODES = 4_096;
const MAX_RECURSIVE_BYTES = 262_144;
const MAX_STRUCTURED_OUTPUT_NODES = 512;
const MAX_STRUCTURED_OUTPUT_STRING = 8_000;
const MAX_STRUCTURED_OUTPUT_KEY = 256;
const SENSITIVE_OUTPUT_KEY = /(?:api[_-]?key|access[_-]?key|token|secret|password|passphrase|private[_-]?key|authorization|credential|endpoint|base[_-]?url|path|uri|url|cookie|set[_-]?cookie|headers?[_-]?cookie|session(?:[_-]?(?:id|token|key))?|^sid$|csrf(?:[_-]?token)?|refresh[_-]?token)/i;
// Mirrors `validateAgentInputs` in features/agents.ts (INPUT_ID_RE): an id that
// passes the manifest but fails this regex would be silently dropped at
// materialization, so reject it here instead.
const AGENT_INPUT_ID_RE = /^[a-z_][a-z0-9_]{0,31}$/;
// Human-authored fields are data, never executable references. These patterns
// deliberately target concrete unsafe shapes rather than ordinary vocabulary:
// prose may discuss a network or contain semicolons, while URLs, credentials,
// absolute paths, traversal, controls, and command payloads remain forbidden.
const UNSAFE_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const UNSAFE_URL = /(?:\b(?:https?|ftp|file|ssh|git|mailto|data):|\bwww\.)/i;
const UNSAFE_ABSOLUTE_PATH = /(?:~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|(?:^|[^A-Za-z0-9_])\/(?![\/\s]))/;
const CATALOG_UNSAFE_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
const CATALOG_UNSAFE_URL = /(?:\b[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/)?[^\s]|\bwww\.)/i;
const CATALOG_UNSAFE_ABSOLUTE_PATH = /(?:~[\\/]|[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/\/[^/\s]+\/|(?:^|[^A-Za-z0-9_])\/(?![\/\s])|(?:^|[\s("'`])\\(?![\\\s]))/;
const UNSAFE_SECRET_ASSIGNMENT = /(?:api[_\s-]?key|access[_\s-]?key|token|secret|password|passphrase|private[_\s-]?key|authorization)\s*[:\uff1a=\uff1d]/i;
const CATALOG_UNSAFE_SECRET_ASSIGNMENT = /(?:api[_\s-]?key|access[_\s-]?key|token|secret|password|passphrase|private[_\s-]?key|authorization|cookie|set[_\s-]?cookie|headers?[_\s-]?cookie|session(?:[_\s-]?(?:id|token|key))?|sid|csrf(?:[_\s-]?token)?|refresh[_\s-]?token)\s*[:\uff1a=\uff1d]/i;
const COMMAND_SUBSTITUTION = /(?:`|\$\()/;
const LINE_BOUNDARY = /\r\n?|\n|\u2028|\u2029/;
const CLAUSE_DELIMITER = /\s*;\s*/;
const PIPELINE_DELIMITER = /\s*(?:&&|\|\||\|)\s*/;
const BOUNDED_MARKDOWN_MARKER = /^\s{0,3}(?:(?:[-+*>]|\d{1,3}[.)])\s+)(?:\[[ xX]\]\s+)?/;
const EXPLICIT_COMMAND_PREFIXES = [
  /^(?:please\s+)?(?:run|execute|exec|launch|invoke|spawn)\s*:\s*/i,
  /^(?:please\s+)?(?:run|execute|exec|launch|invoke|spawn)\s+(?:the\s+)?command\s*:\s*/i,
  /^(?:\u8bf7\s*)?(?:\u6267\u884c|\u8fd0\u884c|\u542f\u52a8)\s*:\s*/,
] as const;
const SOFT_COMMAND_PREFIX = /^(?:please\s+)?(?:run|execute|exec|launch|invoke|spawn)\s+/i;
const EXECUTABLE_TOKEN = /^(?:[a-z0-9_][a-z0-9_.+-]*|\.\/\S+)$/i;
const ARGUMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S+$/;
const CLI_FLAG = /^--?[A-Za-z0-9][A-Za-z0-9_-]*(?:=\S+)?$/;
const REDIRECTION = /(?:\d*>>?|<<?|&>)/g;
const HYPHENATED_EXECUTABLE = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+(?:\.[A-Za-z0-9_+-]+)*$/;
const CONTEXTUAL_NO_ARGUMENT_COMMAND = /^(?:whoami|pwd|hostname|id|uname)$/i;
const UNAMBIGUOUS_OPERAND_COMMAND = /^(?:touch|rm|rmdir|mkdir|mktemp)$/i;
const PIPELINE_NO_ARGUMENT_COMMAND = /^(?:ls|ps|wc|sort|head|tail|uniq)$/i;
const PIPELINE_OPERAND_COMMAND = /^(?:echo|printf|grep)$/i;
const GIT_COMMAND_ACTION = /^(?:apply|checkout|clean|clone|fetch|pull|push|reset|restore)$/i;
const NETWORK_COMMAND = /^(?:curl|wget|ssh|scp|sftp)$/i;
const DOCKER_DIRECT_NO_ARGUMENT_ACTION = /^(?:images|info|ps|version)$/i;
const DOCKER_DIRECT_OPERAND_ACTION = /^(?:build|create|exec|inspect|kill|logs|pull|push|restart|rm|run|start|stop|tag|top)$/i;
const DOCKER_COMPOSE_ACTION = /^(?:build|config|create|down|exec|images|kill|logs|pause|port|ps|pull|push|restart|rm|run|start|stop|top|unpause|up)$/i;
const KUBECTL_ACTION = /^(?:annotate|apply|attach|auth|autoscale|cordon|create|delete|describe|diff|drain|edit|exec|explain|get|label|logs|patch|port-forward|replace|rollout|scale|set|taint|top|uncordon|wait)$/i;
const EXTENSIONLESS_SHELL_RUNTIME = /^(?:(?:ba|da|k|z)?sh|cmd|pwsh|powershell)$/i;
const ASSIGNMENT_NOTATION_MARKER = /^(?:examples?|pairs?|notation|mapping)$/i;
const ASSIGNMENT_PREDICATE = /^(?:is|are|means|indicates|represents|remains)$/i;
const CLI_OPERAND_PLACEHOLDER = /^(?:args?|arguments?|operands?)$/i;
const COMPARISON_PROSE_VERB = /^(?:compare|ensure|keep)$/i;
const SHELL_PROSE_TOPIC = /^(?:documentation|examples?|guide|overview|reference|syntax|tutorial)$/i;
const SCRIPT_RUNTIME_CLASSES = [
  { executable: /^(?:ba|da|k|z)?sh$/i, operand: /\.(?:sh|bash|zsh)$/i },
  { executable: /^fish$/i, operand: /\.fish$/i },
  { executable: /^(?:cmd|command)$/i, operand: /\.(?:bat|cmd)$/i },
  { executable: /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/i, operand: /\.(?:py|pyw)$/i },
  { executable: /^(?:node|deno|bun)$/i, operand: /\.(?:[cm]?js|jsx|ts|tsx)$/i },
  { executable: /^perl$/i, operand: /\.(?:pl|pm)$/i },
  { executable: /^ruby$/i, operand: /\.rb$/i },
  { executable: /^(?:php|lua)$/i, operand: /\.(?:php|lua)$/i },
  { executable: /^(?:pwsh|powershell)$/i, operand: /\.ps1$/i },
] as const;
const UNSAFE_RAW_CREDENTIAL = /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b|\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const CATALOG_UNSAFE_RAW_CREDENTIAL = /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bpypi-[A-Za-z0-9_-]{20,}\b|\bya29\.[A-Za-z0-9_-]{20,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b|\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export type CreatorUnsafeTextIssue = Pick<CreatorSchemaIssue, 'code' | 'message'>;

/** Enumerate only own enumerable keys, with a scan cap that also bounds hostile prototypes. */
export function forEachOwnEnumerableCreatorKey(
  value: object,
  limit: number,
  visit: (key: string) => void,
): boolean {
  let scanned = 0;
  try {
    for (const key in value) {
      if (++scanned > limit) return false;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      visit(key);
    }
    return true;
  } catch {
    return false;
  }
}

export function isSensitiveCreatorKey(value: string): boolean {
  return SENSITIVE_OUTPUT_KEY.test(value.replace(/[^A-Za-z0-9]/g, '').toLowerCase());
}

type CommandShape = 'none' | 'weak' | 'strong';

interface CommandClauseContext {
  afterBoundary?: boolean;
  afterDelimiter?: boolean;
  executionPrefix?: boolean;
  listItem?: boolean;
  pipeline?: boolean;
}

function stripBoundedMarkdownMarker(value: string): { text: string; hadMarker: boolean } {
  const hadMarker = BOUNDED_MARKDOWN_MARKER.test(value);
  return { text: value.replace(BOUNDED_MARKDOWN_MARKER, '').trim(), hadMarker };
}

function tokenizeCommandClause(value: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(value)) !== null) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function isExecutableToken(value: string): boolean {
  return EXECUTABLE_TOKEN.test(value);
}

function hasConcreteCliFlag(tokens: readonly string[]): boolean {
  return tokens.length >= 2 && tokens.slice(1).some((token) => CLI_FLAG.test(token));
}

function hasScriptRuntimeEvidence(tokens: readonly string[]): boolean {
  const executable = tokens[0] ?? '';
  if (SCRIPT_RUNTIME_CLASSES.some(({ executable: runtime, operand }) => (
    runtime.test(executable)
    && tokens.slice(1).some((token) => operand.test(token.replace(/[.,;:!?]+$/, '')))
  ))) return true;
  if (!EXTENSIONLESS_SHELL_RUNTIME.test(executable) || tokens.length < 2) return false;
  if (tokens.length === 2 && SHELL_PROSE_TOPIC.test(stripTerminalPunctuation(tokens[1]))) return false;
  return isExecutableToken(stripTerminalPunctuation(tokens[1]));
}

function hasGitCommandEvidence(tokens: readonly string[]): boolean {
  return /^git$/i.test(tokens[0] ?? '') && GIT_COMMAND_ACTION.test(tokens[1] ?? '') && tokens.length >= 3;
}

function hasNetworkCommandEvidence(tokens: readonly string[]): boolean {
  return NETWORK_COMMAND.test(tokens[0] ?? '') && tokens.length >= 2;
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[.,;:!?\u3002\uff01\uff1f]+$/, '');
}

function hasAssignmentProseContinuation(tokens: readonly string[], commandIndex: number): boolean {
  const continuation = tokens.slice(commandIndex).map(stripTerminalPunctuation);
  if (continuation.length === 0) return false;
  if (ASSIGNMENT_NOTATION_MARKER.test(continuation[0])) return true;
  if (continuation.length < 2 || !ASSIGNMENT_PREDICATE.test(continuation[0])) return false;
  return !CLI_OPERAND_PLACEHOLDER.test(continuation[1])
    && !CLI_FLAG.test(continuation[1]);
}

function isAssignmentNotationProse(tokens: readonly string[], commandIndex: number, envPrefix: boolean): boolean {
  return !envPrefix && commandIndex === 1 && hasAssignmentProseContinuation(tokens, commandIndex);
}

function hasEnvironmentCommandEvidence(tokens: readonly string[]): boolean {
  const envPrefix = /^env$/i.test(tokens[0] ?? '');
  let index = envPrefix ? 1 : 0;
  const assignmentStart = index;
  while (ARGUMENT_ASSIGNMENT.test(tokens[index] ?? '')) index += 1;
  if (index === assignmentStart || !isExecutableToken(tokens[index] ?? '')) return false;
  // Primitive/metasyntactic assignments followed by grammatical prose are
  // data descriptions. An explicit `env` prefix always remains executable.
  return !isAssignmentNotationProse(tokens, index, envPrefix);
}

function hasMultiwordCliFamilyEvidence(tokens: readonly string[]): boolean {
  if (/^docker$/i.test(tokens[0] ?? '')) {
    if (/^compose$/i.test(tokens[1] ?? '')) return DOCKER_COMPOSE_ACTION.test(tokens[2] ?? '');
    if (DOCKER_DIRECT_NO_ARGUMENT_ACTION.test(tokens[1] ?? '')) return tokens.length === 2;
    return DOCKER_DIRECT_OPERAND_ACTION.test(tokens[1] ?? '') && tokens.length >= 3;
  }
  return /^kubectl$/i.test(tokens[0] ?? '')
    && KUBECTL_ACTION.test(tokens[1] ?? '')
    && tokens.length >= 3;
}

function isTouchBaseProse(tokens: readonly string[]): boolean {
  return /^touch$/i.test(tokens[0] ?? '')
    && /^base$/i.test(stripTerminalPunctuation(tokens[1] ?? ''));
}

function hasOperandCommandEvidence(tokens: readonly string[]): boolean {
  return tokens.length >= 2
    && UNAMBIGUOUS_OPERAND_COMMAND.test(tokens[0] ?? '')
    && !isTouchBaseProse(tokens);
}

function hasPipelineCommandEvidence(tokens: readonly string[]): boolean {
  if (tokens.length === 1) {
    return CONTEXTUAL_NO_ARGUMENT_COMMAND.test(tokens[0]) || PIPELINE_NO_ARGUMENT_COMMAND.test(tokens[0]);
  }
  return PIPELINE_OPERAND_COMMAND.test(tokens[0] ?? '');
}

function hasCommandEvidenceBeforeRedirection(tokens: readonly string[]): boolean {
  return hasPipelineCommandEvidence(tokens)
    || hasNetworkCommandEvidence(tokens)
    || hasOperandCommandEvidence(tokens)
    || hasConcreteCliFlag(tokens)
    || hasScriptRuntimeEvidence(tokens)
    || hasGitCommandEvidence(tokens)
    || hasMultiwordCliFamilyEvidence(tokens);
}

function isComparisonOrArrowOperator(clause: string, redirection: RegExpExecArray): boolean {
  const operator = redirection[0];
  if (operator !== '>' && operator !== '<') return false;
  const before = clause[redirection.index - 1] ?? '';
  const after = clause[redirection.index + operator.length] ?? '';
  return /[-=<>]/.test(before) || /[-=<>]/.test(after);
}

function hasStrongStreamOperandSyntax(before: readonly string[], after: readonly string[]): boolean {
  if (before.length < 2 || after.length < 1 || !isExecutableToken(before[0] ?? '')) return false;
  const source = stripTerminalPunctuation(before[before.length - 1] ?? '');
  const target = stripTerminalPunctuation(after[0] ?? '');
  const sourceRole = /^(?:(?:std)?in(?:put)?|source|origin)$/i.test(source);
  const targetRole = /^(?:(?:std)?out(?:put)?|destination|sink|target)$/i.test(target);
  return sourceRole && targetRole;
}

function findShellRedirection(clause: string): RegExpExecArray | null {
  REDIRECTION.lastIndex = 0;
  let redirection: RegExpExecArray | null;
  while ((redirection = REDIRECTION.exec(clause)) !== null) {
    if (!isComparisonOrArrowOperator(clause, redirection)) return redirection;
  }
  return null;
}

function isComparisonProse(clause: string, redirection: RegExpExecArray): boolean {
  if (redirection[0] !== '>' && redirection[0] !== '<') return false;
  const before = tokenizeCommandClause(clause.slice(0, redirection.index));
  const after = tokenizeCommandClause(clause.slice(redirection.index + redirection[0].length));
  return before.length >= 2
    && after.length >= 1
    && COMPARISON_PROSE_VERB.test(before[0] ?? '')
    && before.slice(1).every((token) => isExecutableToken(stripTerminalPunctuation(token)))
    && after.every((token) => isExecutableToken(stripTerminalPunctuation(token)));
}

function hasRedirectionCommandEvidence(clause: string, executionPrefix = false): boolean {
  const redirection = findShellRedirection(clause);
  if (!redirection) return false;
  if (!executionPrefix && isComparisonProse(clause, redirection)) return false;
  const before = tokenizeCommandClause(clause.slice(0, redirection.index));
  const after = tokenizeCommandClause(clause.slice(redirection.index + redirection[0].length));
  if (after.length < 1) return false;
  const hasCommandEvidence = executionPrefix
    ? isExecutableToken(before[0] ?? '')
    : hasCommandEvidenceBeforeRedirection(before) || hasStrongStreamOperandSyntax(before, after);
  if (!hasCommandEvidence) return false;
  const target = after[0];
  return isExecutableToken(target) && !/^\d+(?:\.\d+)?$/.test(target);
}

function markdownTableCells(line: string): string[] | null {
  let row = line.trim();
  if (!row.includes('|')) return null;
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  const cells = row.split('|').map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => cell.length > 0) ? cells : null;
}

function validatedMarkdownTableLines(lines: readonly string[]): Set<number> {
  const tableLines = new Set<number>();
  for (let separatorIndex = 1; separatorIndex + 1 < lines.length; separatorIndex += 1) {
    const separator = markdownTableCells(lines[separatorIndex]);
    if (!separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const header = markdownTableCells(lines[separatorIndex - 1]);
    const firstRow = markdownTableCells(lines[separatorIndex + 1]);
    if (!header || !firstRow || header.length !== separator.length || firstRow.length !== separator.length) continue;
    tableLines.add(separatorIndex - 1);
    tableLines.add(separatorIndex);
    for (let rowIndex = separatorIndex + 1; rowIndex < lines.length; rowIndex += 1) {
      const row = markdownTableCells(lines[rowIndex]);
      if (!row || row.length !== separator.length) break;
      tableLines.add(rowIndex);
    }
  }
  return tableLines;
}

function classifyCommandClause(
  value: string,
  context: CommandClauseContext = {},
  allowSoftPrefix = true,
): CommandShape {
  const stripped = stripBoundedMarkdownMarker(value);
  const clause = stripped.text;
  if (!clause) return 'none';
  for (const prefix of EXPLICIT_COMMAND_PREFIXES) {
    const match = prefix.exec(clause);
    if (match) {
      const command = tokenizeCommandClause(stripBoundedMarkdownMarker(clause.slice(match[0].length)).text)[0] ?? '';
      if (isExecutableToken(command)) return 'strong';
    }
  }
  if (allowSoftPrefix) {
    const match = SOFT_COMMAND_PREFIX.exec(clause);
    if (match) {
      const remainder = stripBoundedMarkdownMarker(clause.slice(match[0].length)).text;
      const remainderTokens = tokenizeCommandClause(remainder);
      const remainderShape = classifyCommandClause(remainder, { executionPrefix: true }, false);
      if (
        (remainderTokens.length === 1 && CONTEXTUAL_NO_ARGUMENT_COMMAND.test(remainderTokens[0]))
        || HYPHENATED_EXECUTABLE.test(remainderTokens[0] ?? '')
        || hasNetworkCommandEvidence(remainderTokens)
        || remainderShape === 'strong'
      ) return 'strong';
    }
  }

  const tokens = tokenizeCommandClause(clause);
  const executable = tokens[0] ?? '';
  const contextualCommand = context.afterBoundary || context.afterDelimiter || context.listItem || stripped.hadMarker;
  if (hasEnvironmentCommandEvidence(tokens)) return 'strong';
  if (hasRedirectionCommandEvidence(clause, context.executionPrefix)) return 'strong';
  if (!isExecutableToken(executable)) return 'none';
  if (
    hasConcreteCliFlag(tokens)
    || hasScriptRuntimeEvidence(tokens)
    || hasGitCommandEvidence(tokens)
    || hasNetworkCommandEvidence(tokens)
    || hasOperandCommandEvidence(tokens)
    || hasMultiwordCliFamilyEvidence(tokens)
  ) return 'strong';

  if (hasPipelineCommandEvidence(tokens)) {
    if (contextualCommand && !context.pipeline) return 'strong';
    return 'weak';
  }
  if (tokens.slice(1).some((token) => ARGUMENT_ASSIGNMENT.test(token))) return 'weak';
  // A bare two-token clause is ambiguous on its own. Keep it weak so ordinary
  // prose/file references pass, but two adjacent weak clauses still establish
  // a command-shaped pipeline unless they belong to a validated Markdown table.
  return tokens.length === 2 ? 'weak' : 'none';
}

function hasUnsafeCommandShape(value: string): boolean {
  if (COMMAND_SUBSTITUTION.test(value)) return true;
  const lines = value.split(LINE_BOUNDARY);
  const markdownTableLines = validatedMarkdownTableLines(lines);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const independentClauses = line.split(CLAUSE_DELIMITER);
    for (let clauseIndex = 0; clauseIndex < independentClauses.length; clauseIndex += 1) {
      const independentClause = independentClauses[clauseIndex];
      const segments = independentClause.split(PIPELINE_DELIMITER);
      const shapes = segments.map((segment) => classifyCommandClause(segment, {
        afterBoundary: lineIndex > 0,
        afterDelimiter: clauseIndex > 0,
        pipeline: segments.length > 1,
      }));
      if (shapes.includes('strong')) return true;
      if (markdownTableLines.has(lineIndex)) continue;
      for (let index = 1; index < shapes.length; index += 1) {
        if (shapes[index - 1] !== 'none' && shapes[index] !== 'none') return true;
      }
    }
  }
  return false;
}

function validateCreatorText(
  value: string,
  strictCatalogPolicy: boolean,
): CreatorUnsafeTextIssue | null {
  const analyzed = value.normalize('NFKC');
  const controlChars = strictCatalogPolicy ? CATALOG_UNSAFE_CONTROL_CHARS : UNSAFE_CONTROL_CHARS;
  if (controlChars.test(analyzed)) {
    return { code: 'creator_invalid_value', message: 'control characters are forbidden' };
  }
  const unsafeUrl = strictCatalogPolicy ? CATALOG_UNSAFE_URL : UNSAFE_URL;
  if (unsafeUrl.test(analyzed)) {
    return { code: 'creator_invalid_reference', message: 'URLs are forbidden' };
  }
  const unsafePath = strictCatalogPolicy ? CATALOG_UNSAFE_ABSOLUTE_PATH : UNSAFE_ABSOLUTE_PATH;
  if (unsafePath.test(analyzed) || analyzed.split(/[\\/]/).includes('..')) {
    return { code: 'creator_invalid_reference', message: 'absolute paths and traversal are forbidden' };
  }
  const unsafeCredential = strictCatalogPolicy ? CATALOG_UNSAFE_RAW_CREDENTIAL : UNSAFE_RAW_CREDENTIAL;
  if ((strictCatalogPolicy ? CATALOG_UNSAFE_SECRET_ASSIGNMENT : UNSAFE_SECRET_ASSIGNMENT).test(analyzed)
    || unsafeCredential.test(analyzed)) {
    return { code: 'creator_secret_field', message: 'credentials and secret assignments are forbidden' };
  }
  if (hasUnsafeCommandShape(analyzed)) {
    return { code: 'creator_invalid_value', message: 'commands and shell operators are forbidden' };
  }
  return null;
}

/** Approved manifest-prose policy. Keep this default stable for Task 3 contracts. */
export function validateSafeCreatorText(value: string): CreatorUnsafeTextIssue | null {
  return validateCreatorText(value, false);
}

/** Preserve useful structural paths while never echoing untrusted object keys. */
export function safeCreatorIssuePathSegment(value: string): string {
  return SAFE_ISSUE_PATH_SEGMENT.test(value) && validateSafeCreatorText(value) === null
    ? value
    : '[untrusted-key]';
}

/** Strict policy for bounded provider-controlled strings projected by the catalog. */
export function validateCreatorCatalogText(value: string): CreatorUnsafeTextIssue | null {
  return validateCreatorText(value, true);
}

/** Redacts an arbitrary provider/host text value without returning unsafe bytes. */
export function sanitizeCreatorCatalogText(value: string): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  return validateCreatorCatalogText(normalized) ? '[REDACTED]' : normalized;
}

function sanitizeStructuredOutputValue(
  value: unknown,
  depth: number,
  state: { nodes: number; bytes: number; maxBytes: number },
  sensitive = false,
): unknown {
  if (++state.nodes > MAX_STRUCTURED_OUTPUT_NODES || depth > 20) return '[REDACTED]';
  if (sensitive) return '[REDACTED]';
  if (typeof value === 'string') {
    if (value.length > MAX_STRUCTURED_OUTPUT_STRING) return '[REDACTED]…';
    const bytes = Buffer.byteLength(value, 'utf8');
    if (state.bytes + bytes > state.maxBytes) return '[REDACTED]…';
    state.bytes += bytes;
    return sanitizeCreatorCatalogText(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return '[REDACTED]';
  if (Array.isArray(value)) {
    let length: number;
    try { length = value.length; } catch { return '[REDACTED]'; }
    if (!Number.isSafeInteger(length) || length > MAX_RECURSIVE_COLLECTION_ITEMS) return '[REDACTED]';
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return '[REDACTED]';
      output.push(sanitizeStructuredOutputValue(value[index], depth + 1, state));
    }
    return output;
  }
  const output: Record<string, unknown> = {};
  let invalid = false;
  const complete = forEachOwnEnumerableCreatorKey(value, MAX_RECURSIVE_COLLECTION_ITEMS, (key) => {
    if (key.length > MAX_STRUCTURED_OUTPUT_KEY || state.bytes + Buffer.byteLength(key, 'utf8') > state.maxBytes) {
      invalid = true;
      return;
    }
    state.bytes += Buffer.byteLength(key, 'utf8');
    const entry = (value as Record<string, unknown>)[key];
    const keyIsSensitive = isSensitiveCreatorKey(key);
    const safeKey = keyIsSensitive || validateCreatorCatalogText(key) ? '[REDACTED]' : key;
    output[safeKey] = sanitizeStructuredOutputValue(
      entry,
      depth + 1,
      state,
      keyIsSensitive,
    );
  });
  return complete && !invalid ? output : '[REDACTED]';
}

function embeddedJsonEnd(text: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
}

function sanitizeEmbeddedJsonLine(
  line: string,
  state: { nodes: number; bytes: number; maxBytes: number },
): string {
  let cursor = 0;
  let segmentStart = 0;
  let output = '';
  let found = false;
  let fragments = 0;
  while (cursor < line.length) {
    if (line[cursor] !== '{' && line[cursor] !== '[') {
      cursor += 1;
      continue;
    }
    const end = embeddedJsonEnd(line, cursor);
    if (end === undefined) {
      cursor += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(cursor, end)) as unknown;
    } catch {
      cursor += 1;
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      cursor = end;
      continue;
    }
    if (++fragments > MAX_RECURSIVE_COLLECTION_ITEMS) return '[REDACTED]';
    const safe = JSON.stringify(sanitizeStructuredOutputValue(parsed, 0, state)) ?? '[REDACTED]';
    output += sanitizeCreatorCatalogText(line.slice(segmentStart, cursor));
    output += safe;
    segmentStart = end;
    cursor = end;
    found = true;
  }
  return found
    ? `${output}${sanitizeCreatorCatalogText(line.slice(segmentStart))}`
    : sanitizeCreatorCatalogText(line);
}

/** Sanitize flat or JSON-structured host output without exposing sensitive fields. */
export function sanitizeCreatorStructuredOutput(value: unknown, maxBytes = 8_000): string {
  if (value === undefined) return '';
  let text: string;
  if (typeof value === 'string') {
    if (value.length > MAX_STRUCTURED_OUTPUT_STRING || Buffer.byteLength(value, 'utf8') > maxBytes) return '[REDACTED]…';
    const state = { nodes: 0, bytes: 0, maxBytes };
    const lines = value.split(/\r\n?|\n/);
    if (lines.length > MAX_RECURSIVE_COLLECTION_ITEMS) return '[REDACTED]';
    text = lines.map((line) => sanitizeEmbeddedJsonLine(line, state)).join('\n');
  }
  else {
    try {
      text = JSON.stringify(sanitizeStructuredOutputValue(value, 0, { nodes: 0, bytes: 0, maxBytes })) ?? '';
    } catch { return '[REDACTED]'; }
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return '[REDACTED]…';
  let safe = sanitizeCreatorCatalogText(text);
  if (typeof value === 'string') try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      safe = JSON.stringify(sanitizeStructuredOutputValue(parsed, 0, { nodes: 0, bytes: 0, maxBytes })) ?? '[REDACTED]';
    }
  } catch {
    // Plain text is already handled by the shared strict catalog policy.
  }
  const bytes = Buffer.from(safe, 'utf8');
  if (bytes.length <= maxBytes) return safe;
  return `${bytes.subarray(0, maxBytes).toString('utf8')}…`;
}

function isForbiddenFieldName(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (normalized === 'maxtokens') return false;
  return /api.*key|token|secret|password|private.*key|authorization|endpoint|base.*url|command|shell|import.*path|file.*path|path|remote|peer|network|transport|url|uri/.test(normalized);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasDenseIndexes(value: unknown[], length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

class Validator {
  readonly issues: CreatorSchemaIssue[] = [];

  issue(code: CreatorSchemaIssue['code'], path: string, message: string): void {
    if (this.issues.some((issue) => issue.code === code && issue.path === path && issue.message === message)) return;
    this.issues.push({ code, path, message });
  }

  object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      this.issue('creator_invalid_type', path, 'expected a plain object');
      return null;
    }
    const allowed = new Set(keys);
    const complete = forEachOwnEnumerableCreatorKey(value, MAX_RECURSIVE_COLLECTION_ITEMS, (key) => {
      const fieldPath = path
        ? `${path}.${safeCreatorIssuePathSegment(key)}`
        : safeCreatorIssuePathSegment(key);
      if (allowed.has(key)) return;
      if (isForbiddenFieldName(key)) {
        this.issue('creator_secret_field', fieldPath, 'secret, path, remote, network, command, or transport fields are forbidden');
      } else {
        this.issue('creator_unknown_field', fieldPath, 'unknown field');
      }
    });
    if (!complete) this.issue('creator_out_of_range', path, 'object contains too many fields or could not be inspected');
    return value;
  }

  string(value: unknown, path: string, options: { min?: number; max?: number; pattern?: RegExp; code?: CreatorSchemaIssue['code'] } = {}): string | null {
    if (typeof value !== 'string') {
      this.issue('creator_invalid_type', path, 'expected a string');
      return null;
    }
    const min = options.min ?? 1;
    const max = options.max ?? 4_000;
    if (value.length < min || value.length > max) {
      this.issue('creator_out_of_range', path, `string length must be ${min}..${max}`);
      return null;
    }
    if (options.pattern && !options.pattern.test(value)) {
      this.issue(options.code ?? 'creator_invalid_value', path, 'invalid string format');
      return null;
    }
    return value;
  }

  id(value: unknown, path: string): string | null {
    return this.string(value, path, { max: 128, pattern: LOGICAL_ID, code: 'creator_invalid_id' });
  }

  reference(value: unknown, path: string): string | null {
    const result = this.string(value, path, { max: 128, pattern: LOGICAL_ID, code: 'creator_invalid_reference' });
    if (typeof value === 'string' && (value.includes('://') || value.startsWith('/') || value.startsWith('~') || value.split(/[\\/]/).includes('..'))) {
      if (result !== null || !this.issues.some((issue) => issue.path === path)) {
        this.issue('creator_invalid_reference', path, 'only logical references are allowed');
      }
      return null;
    }
    return result;
  }

  /**
   * Validates a bounded, human-authored prompt/workflow section. Unlike
   * `reference`, this deliberately accepts Unicode prose and whitespace so
   * config-sheet workflows are preserved verbatim.
   */
  promptText(value: unknown, path: string, max = 12_000): string | null {
    const result = this.string(value, path, { max });
    if (result === null) return null;
    const unsafe = validateSafeCreatorText(result);
    if (unsafe) this.issue(unsafe.code, path, unsafe.message);
    return result;
  }

  enum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | null {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      this.issue('creator_invalid_value', path, `expected one of: ${allowed.join(', ')}`);
      return null;
    }
    return value as T;
  }

  boolean(value: unknown, path: string): boolean | null {
    if (typeof value !== 'boolean') {
      this.issue('creator_invalid_type', path, 'expected a boolean');
      return null;
    }
    return value;
  }

  number(value: unknown, path: string, options: { min: number; max: number; integer?: boolean }): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || (options.integer && !Number.isInteger(value))) {
      this.issue('creator_invalid_type', path, options.integer ? 'expected a finite integer' : 'expected a finite number');
      return null;
    }
    if (value < options.min || value > options.max) {
      this.issue('creator_out_of_range', path, `number must be ${options.min}..${options.max}`);
      return null;
    }
    return value;
  }

  array<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T | null, max = 64): T[] | null {
    if (!Array.isArray(value)) {
      this.issue('creator_invalid_type', path, 'expected an array');
      return null;
    }
    let length: number;
    try { length = value.length; } catch {
      this.issue('creator_invalid_type', path, 'array could not be inspected');
      return null;
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      this.issue('creator_invalid_type', path, 'array length is invalid');
      return null;
    }
    if (length > max) {
      this.issue('creator_out_of_range', path, `array may contain at most ${max} items`);
      return null;
    }
    if (!hasDenseIndexes(value, length)) {
      this.issue('creator_sparse_array', path, 'sparse arrays are forbidden');
    }
    const output: T[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) continue;
      const parsed = parse(value[index], `${path}.${index}`);
      if (parsed !== null) output.push(parsed);
    }
    return output;
  }
}

function recursivelyRejectUnsafeValues(
  v: Validator,
  value: unknown,
  path = '',
  depth = 0,
  seen = new WeakSet<object>(),
  budget = { nodes: 0, bytes: 0 },
): void {
  if (++budget.nodes > MAX_RECURSIVE_NODES) {
    v.issue('creator_out_of_range', path, 'manifest contains too many nested values');
    return;
  }
  if (depth > 20) {
    v.issue('creator_out_of_range', path, 'nested values may be at most 20 levels deep');
    return;
  }
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > MAX_RECURSIVE_BYTES) {
      v.issue('creator_out_of_range', path, 'manifest contains too much nested text');
      return;
    }
    const unsafe = validateSafeCreatorText(value);
    if (unsafe) v.issue(unsafe.code, path, unsafe.message);
    return;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    v.issue('creator_invalid_type', path, 'value must be JSON-compatible');
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) {
    v.issue('creator_invalid_value', path, 'cyclic objects are forbidden');
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    let length: number;
    try { length = value.length; } catch {
      v.issue('creator_invalid_type', path, 'array could not be inspected');
      return;
    }
    if (!Number.isSafeInteger(length) || length > MAX_RECURSIVE_COLLECTION_ITEMS) {
      v.issue('creator_out_of_range', path, 'nested collections exceed the validation bound');
      return;
    }
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) continue;
      recursivelyRejectUnsafeValues(v, value[index], `${path}.${index}`, depth + 1, seen, budget);
    }
    return;
  }
  const complete = forEachOwnEnumerableCreatorKey(value, MAX_RECURSIVE_COLLECTION_ITEMS, (key) => {
      budget.bytes += Buffer.byteLength(key, 'utf8');
      if (budget.bytes > MAX_RECURSIVE_BYTES) {
        v.issue('creator_out_of_range', path, 'manifest contains too much nested text');
        return;
      }
      const entry = value[key];
      const fieldPath = path
        ? `${path}.${safeCreatorIssuePathSegment(key)}`
        : safeCreatorIssuePathSegment(key);
      if (isForbiddenFieldName(key)) {
        v.issue('creator_secret_field', fieldPath, 'secret, path, remote, network, command, or transport fields are forbidden');
      }
      recursivelyRejectUnsafeValues(v, entry, fieldPath, depth + 1, seen, budget);
  });
  if (!complete) {
    v.issue('creator_invalid_value', path, 'nested value could not be inspected');
  }
}

function safelyMatchesEmptyFileDefault(value: unknown, expected: unknown): boolean {
  try {
    if (expected === '') return value === '';
    if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || value[index] !== expected[index]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasOwnEnumerableKey(value: object): boolean {
  let found = false;
  forEachOwnEnumerableCreatorKey(value, 1, () => { found = true; });
  return found;
}

/**
 * Validates `options` for select/multiselect agent inputs, mirroring the
 * option semantics of `validateAgentInputs` in features/agents.ts (non-empty
 * string values, unique values, optional string labels). Unlike the sibling,
 * malformed entries are reported as schema issues instead of silently
 * dropped.
 */
function parseAgentInputOptions(v: Validator, options: unknown, path: string): CreatorAgentInputOption[] | null {
  const seen = new Set<string>();
  const parsed = v.array(options, path, (entry, optionPath) => {
    const raw = v.object(entry, optionPath, AGENT_INPUT_OPTION_KEYS);
    if (!raw) return null;
    const optionValue = v.string(raw.value, `${optionPath}.value`, { max: 200 })?.trim();
    const label = (raw.label === undefined
      ? optionValue
      : v.promptText(raw.label, `${optionPath}.label`, 200))?.trim();
    if (!optionValue) {
      v.issue('creator_invalid_value', `${optionPath}.value`, 'option value must not be blank');
      return null;
    }
    if (!label) {
      v.issue('creator_invalid_value', `${optionPath}.label`, 'option label must not be blank');
      return null;
    }
    if (seen.has(optionValue)) {
      v.issue('creator_invalid_value', `${optionPath}.value`, 'duplicate option value');
      return null;
    }
    seen.add(optionValue);
    return { value: optionValue, label };
  }, MAX_AGENT_INPUT_OPTIONS);
  if (!parsed || parsed.length === 0) {
    v.issue('creator_invalid_value', path, 'select/multiselect inputs require non-empty options');
    return null;
  }
  return parsed;
}

/**
 * Strictly normalize one input into the current Agent runtime contract.
 */
function parseAgentInput(
  v: Validator,
  value: unknown,
  path: string,
  seenInputIds: Set<string>,
): CreatorAgentInput | null {
  const raw = v.object(value, path, AGENT_INPUT_KEYS);
  if (!raw) return null;
  const normalizedId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = AGENT_INPUT_ID_RE.test(normalizedId) ? normalizedId : null;
  if (!id) {
    v.issue('creator_invalid_id', `${path}.id`, 'input id must match /^[a-z_][a-z0-9_]{0,31}$/');
  }
  const type = v.enum(raw.type, `${path}.type`, AGENT_INPUT_TYPES);
  if (!id || !type) return null;
  if (seenInputIds.has(id)) {
    v.issue('creator_invalid_id', `${path}.id`, 'duplicate input id');
    return null;
  }
  seenInputIds.add(id);

  const labelRaw = raw.label === undefined ? id : v.promptText(raw.label, `${path}.label`, 200);
  const label = labelRaw?.trim();
  if (!label) {
    if (labelRaw !== null) v.issue('creator_invalid_value', `${path}.label`, 'label must not be blank');
    return null;
  }
  const description = raw.description === undefined ? undefined : v.promptText(raw.description, `${path}.description`, 2_000)?.trim();
  const placeholder = raw.placeholder === undefined ? undefined : v.promptText(raw.placeholder, `${path}.placeholder`, 500)?.trim();
  const required = raw.required === undefined ? undefined : v.boolean(raw.required, `${path}.required`);

  let options: CreatorAgentInputOption[] | undefined;
  if (type === 'select' || type === 'multiselect') {
    options = parseAgentInputOptions(v, raw.options, `${path}.options`) ?? undefined;
  } else if (raw.options !== undefined) {
    v.issue('creator_invalid_value', `${path}.options`, 'options are allowed only for select inputs');
  }

  let min: number | undefined;
  let max: number | undefined;
  if (type === 'number') {
    min = raw.min === undefined ? undefined : v.number(raw.min, `${path}.min`, { min: -MAX_NUMERIC_INPUT_VALUE, max: MAX_NUMERIC_INPUT_VALUE });
    max = raw.max === undefined ? undefined : v.number(raw.max, `${path}.max`, { min: -MAX_NUMERIC_INPUT_VALUE, max: MAX_NUMERIC_INPUT_VALUE });
    if (min !== undefined && min !== null && max !== undefined && max !== null && min > max) {
      v.issue('creator_invalid_value', `${path}.min`, 'min must be less than or equal to max');
    }
  } else if (raw.min !== undefined || raw.max !== undefined) {
    v.issue('creator_invalid_value', path, 'min and max are allowed only for number inputs');
  }

  const multiple = raw.multiple === undefined ? undefined : v.boolean(raw.multiple, `${path}.multiple`);
  if (raw.multiple !== undefined && type !== 'file') {
    v.issue('creator_invalid_value', `${path}.multiple`, 'multiple is allowed only for file inputs');
  }
  let accept: string | undefined;
  if (raw.accept !== undefined) {
    if (type !== 'file') {
      v.issue('creator_invalid_value', `${path}.accept`, 'accept is allowed only for file inputs');
    } else {
      const candidate = v.string(raw.accept, `${path}.accept`, { max: 256 })?.trim();
      if (candidate && ACCEPT_LIST.test(candidate)) accept = candidate;
      else if (candidate) v.issue('creator_invalid_value', `${path}.accept`, 'invalid file accept list');
    }
  }

  let defaultValue: CreatorAgentInput['default'];
  if (type === 'text' || type === 'textarea') {
    defaultValue = raw.default === undefined ? '' : (v.promptText(raw.default, `${path}.default`, 4_000) ?? '');
  } else if (type === 'number') {
    const candidate = typeof raw.default === 'string' && raw.default.trim() !== ''
      ? Number(raw.default)
      : raw.default;
    const parsed = v.number(candidate, `${path}.default`, { min: -MAX_NUMERIC_INPUT_VALUE, max: MAX_NUMERIC_INPUT_VALUE });
    defaultValue = parsed ?? 0;
    if (parsed !== null && min !== undefined && parsed < min) v.issue('creator_invalid_value', `${path}.default`, 'default is below min');
    if (parsed !== null && max !== undefined && parsed > max) v.issue('creator_invalid_value', `${path}.default`, 'default is above max');
  } else if (type === 'boolean') {
    if (raw.default === undefined) defaultValue = false;
    else if (raw.default === true || raw.default === 'true' || raw.default === 1) defaultValue = true;
    else if (raw.default === false || raw.default === 'false' || raw.default === 0) defaultValue = false;
    else {
      v.issue('creator_invalid_value', `${path}.default`, 'invalid boolean default');
      defaultValue = false;
    }
  } else if (type === 'select') {
    const candidate = raw.default === undefined ? options?.[0]?.value : raw.default;
    if (typeof candidate !== 'string' || !options?.some((option) => option.value === candidate)) {
      v.issue('creator_invalid_value', `${path}.default`, 'select default must reference an option');
      defaultValue = options?.[0]?.value ?? '';
    } else defaultValue = candidate;
  } else if (type === 'multiselect') {
    const parsed = raw.default === undefined
      ? []
      : v.array(raw.default, `${path}.default`, (entry, entryPath) => v.string(entry, entryPath, { max: 200 }), MAX_INPUT_DEFAULT_ITEMS) ?? [];
    const seenDefaults = new Set<string>();
    for (let index = 0; index < parsed.length; index += 1) {
      if (!options?.some((option) => option.value === parsed[index]) || seenDefaults.has(parsed[index])) {
        v.issue('creator_invalid_value', `${path}.default.${index}`, 'multiselect default must uniquely reference an option');
      }
      seenDefaults.add(parsed[index]);
    }
    defaultValue = parsed;
  } else if (type === 'file') {
    const expected = multiple === true ? [] : '';
    if (raw.default !== undefined && !safelyMatchesEmptyFileDefault(raw.default, expected)) {
      v.issue('creator_invalid_value', `${path}.default`, 'file defaults must be empty');
    }
    defaultValue = expected;
  } else {
    if (raw.default !== undefined && raw.default !== '') {
      v.issue('creator_invalid_value', `${path}.default`, 'directory defaults must be empty');
    }
    defaultValue = '';
  }

  let defaultsByLanguage: Partial<Record<(typeof AGENT_INPUT_UI_LANGS)[number], string>> | undefined;
  if (raw.default_by_ui_language !== undefined) {
    if (type !== 'select') {
      v.issue('creator_invalid_value', `${path}.default_by_ui_language`, 'localized defaults are allowed only for select inputs');
    } else {
      const localized = v.object(raw.default_by_ui_language, `${path}.default_by_ui_language`, AGENT_INPUT_UI_LANGS);
      if (localized) {
        defaultsByLanguage = {};
        for (const language of AGENT_INPUT_UI_LANGS) {
          if (localized[language] === undefined) continue;
          const optionValue = v.string(localized[language], `${path}.default_by_ui_language.${language}`, { max: 200 });
          if (optionValue && options?.some((option) => option.value === optionValue)) defaultsByLanguage[language] = optionValue;
          else if (optionValue) v.issue('creator_invalid_value', `${path}.default_by_ui_language.${language}`, 'localized default must reference an option');
        }
        if (Object.keys(defaultsByLanguage).length === 0) defaultsByLanguage = undefined;
      }
    }
  }

  return {
    id,
    label,
    ...(description ? { description } : {}),
    type: type as CreatorAgentInputType,
    ...(required === true ? { required: true } : {}),
    default: defaultValue,
    ...(defaultsByLanguage ? { default_by_ui_language: defaultsByLanguage } : {}),
    ...(options ? { options } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(min !== undefined && min !== null ? { min } : {}),
    ...(max !== undefined && max !== null ? { max } : {}),
    ...(type === 'file' && multiple === true ? { multiple: true } : {}),
    ...(accept ? { accept } : {}),
  };
}

/** Strictly validates and normalizes a Creator manifest without mutating input. */
function validateCreatorPresetManifestInternal(input: unknown): CreatorSchemaResult {
  const v = new Validator();
  recursivelyRejectUnsafeValues(v, input);
  const root = v.object(input, '', [
    'schemaVersion', 'presetId', 'version', 'parentVersion', 'displayName', 'description',
    'presetType', 'agent', 'model', 'capabilities', 'prompt', 'runtime', 'permissions', 'provenance',
  ]);
  if (!root) return { ok: false, issues: v.issues };

  if (root.schemaVersion !== 1) v.issue('creator_invalid_value', 'schemaVersion', 'schemaVersion must be 1');
  const presetId = v.id(root.presetId, 'presetId');
  const version = v.string(root.version, 'version', { max: 64, pattern: VERSION });
  const parentVersion = root.parentVersion === undefined
    ? undefined
    : v.string(root.parentVersion, 'parentVersion', { max: 64, pattern: VERSION });
  const displayName = v.string(root.displayName, 'displayName', { max: 120 });
  const description = v.promptText(root.description, 'description', 2_000);
  const presetType = v.enum(root.presetType, 'presetType', ['cogseed-agent'] as const);

  const agentRaw = root.agent === undefined
    ? undefined
    : v.object(root.agent, 'agent', [
        'category', 'icon', 'color', 'interactive', 'description_zh', 'description_en',
        'knowhow', 'standards', 'inputs',
      ]);
  if (agentRaw && !hasOwnEnumerableKey(agentRaw)) {
    v.issue('creator_invalid_value', 'agent', 'agent section must not be empty');
  }
  const seenInputIds = new Set<string>();
  const agent = agentRaw ? {
    category: agentRaw.category === undefined ? undefined : v.id(agentRaw.category, 'agent.category'),
    icon: agentRaw.icon === undefined ? undefined : v.id(agentRaw.icon, 'agent.icon'),
    color: agentRaw.color === undefined ? undefined : v.id(agentRaw.color, 'agent.color'),
    interactive: agentRaw.interactive === undefined ? undefined : v.boolean(agentRaw.interactive, 'agent.interactive'),
    description_zh: agentRaw.description_zh === undefined ? undefined : v.promptText(agentRaw.description_zh, 'agent.description_zh', 2_000),
    description_en: agentRaw.description_en === undefined ? undefined : v.promptText(agentRaw.description_en, 'agent.description_en', 2_000),
    knowhow: agentRaw.knowhow === undefined ? undefined : v.array(agentRaw.knowhow, 'agent.knowhow', (item, path) => v.promptText(item, path, 4_000), 32),
    standards: agentRaw.standards === undefined ? undefined : v.array(agentRaw.standards, 'agent.standards', (item, path) => v.promptText(item, path, 4_000), 32),
    inputs: agentRaw.inputs === undefined ? undefined : v.array(agentRaw.inputs, 'agent.inputs', (item, path) => parseAgentInput(v, item, path, seenInputIds), MAX_AGENT_INPUTS),
  } : undefined;

  const modelRaw = v.object(root.model, 'model', ['providerId', 'modelId', 'reasoningProfile']);
  const model = modelRaw ? {
    providerId: v.id(modelRaw.providerId, 'model.providerId'),
    modelId: v.reference(modelRaw.modelId, 'model.modelId'),
    reasoningProfile: modelRaw.reasoningProfile === undefined ? undefined : v.reference(modelRaw.reasoningProfile, 'model.reasoningProfile'),
  } : null;

  const capabilities = v.array(root.capabilities, 'capabilities', (item, path) => {
    const raw = v.object(item, path, ['capabilityId', 'version', 'configRef']);
    if (!raw) return null;
    const capabilityId = v.id(raw.capabilityId, `${path}.capabilityId`);
    const capabilityVersion = v.string(raw.version, `${path}.version`, { max: 64, pattern: VERSION });
    const configRef = raw.configRef === undefined ? undefined : v.reference(raw.configRef, `${path}.configRef`);
    return capabilityId && capabilityVersion ? { capabilityId, version: capabilityVersion, ...(configRef ? { configRef } : {}) } : null;
  });

  const promptRaw = v.object(root.prompt, 'prompt', ['systemSections', 'locale']);
  const prompt = promptRaw ? {
    systemSections: v.array(promptRaw.systemSections, 'prompt.systemSections', (item, path) => v.promptText(item, path), 32),
    locale: promptRaw.locale === undefined ? undefined : v.string(promptRaw.locale, 'prompt.locale', { max: 32, pattern: LOCALE }),
  } : null;

  const runtimeRaw = v.object(root.runtime, 'runtime', [
    'sessionPolicy', 'memoryPolicy', 'loopPolicy', 'sandboxProfile', 'timeoutMs', 'budget',
  ]);
  const budgetRaw = runtimeRaw ? v.object(runtimeRaw.budget, 'runtime.budget', ['maxCost', 'maxTokens']) : null;
  const runtime = runtimeRaw && budgetRaw ? {
    sessionPolicy: v.enum(runtimeRaw.sessionPolicy, 'runtime.sessionPolicy', ['new-per-run', 'resume-explicit'] as const),
    memoryPolicy: v.enum(runtimeRaw.memoryPolicy, 'runtime.memoryPolicy', ['none', 'read-only'] as const),
    loopPolicy: v.enum(runtimeRaw.loopPolicy, 'runtime.loopPolicy', ['single-agent'] as const),
    sandboxProfile: v.enum(runtimeRaw.sandboxProfile, 'runtime.sandboxProfile', ['creator-read-only-v1'] as const),
    timeoutMs: v.number(runtimeRaw.timeoutMs, 'runtime.timeoutMs', { min: 1_000, max: MAX_TIMEOUT_MS, integer: true }),
    budget: {
      maxCost: budgetRaw.maxCost === undefined ? undefined : v.number(budgetRaw.maxCost, 'runtime.budget.maxCost', { min: 0, max: 10_000 }),
      maxTokens: budgetRaw.maxTokens === undefined ? undefined : v.number(budgetRaw.maxTokens, 'runtime.budget.maxTokens', { min: 1, max: 10_000_000, integer: true }),
    },
  } : null;

  const permissionsRaw = v.object(root.permissions, 'permissions', [
    'tools', 'files', 'sideEffects', 'approvalMode',
  ]);
  const permissions = permissionsRaw ? {
    tools: v.array(permissionsRaw.tools, 'permissions.tools', (item, path) => v.id(item, path)),
    files: v.array(permissionsRaw.files, 'permissions.files', (item, path) => v.reference(item, path)),
    sideEffects: v.array(permissionsRaw.sideEffects, 'permissions.sideEffects', (item, path) => v.id(item, path)),
    approvalMode: v.enum(permissionsRaw.approvalMode, 'permissions.approvalMode', ['always', 'on-risk', 'preapproved'] as const),
  } : null;



  const provenanceRaw = v.object(root.provenance, 'provenance', [
    'createdBy', 'sourceSessionId', 'sourceAssetRefs', 'verificationRunId',
  ]);
  const provenance = provenanceRaw ? {
    createdBy: v.enum(provenanceRaw.createdBy, 'provenance.createdBy', ['user', 'creator-agent'] as const),
    sourceSessionId: v.reference(provenanceRaw.sourceSessionId, 'provenance.sourceSessionId'),
    sourceAssetRefs: v.array(provenanceRaw.sourceAssetRefs, 'provenance.sourceAssetRefs', (item, path) => v.reference(item, path)),
    verificationRunId: provenanceRaw.verificationRunId === undefined ? undefined : v.reference(provenanceRaw.verificationRunId, 'provenance.verificationRunId'),
  } : null;

  if (v.issues.length > 0 || !presetId || !version || !displayName || !description || !presetType || !model || !capabilities || !prompt || !runtime || !permissions || !provenance) {
    return { ok: false, issues: v.issues };
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      presetId,
      version,
      ...(parentVersion ? { parentVersion } : {}),
      displayName,
      description,
      presetType,
      ...(agent ? {
        agent: {
          ...(agent.category ? { category: agent.category } : {}),
          ...(agent.icon ? { icon: agent.icon } : {}),
          ...(agent.color ? { color: agent.color } : {}),
          ...(agent.interactive !== undefined && agent.interactive !== null ? { interactive: agent.interactive } : {}),
          ...(agent.description_zh ? { description_zh: agent.description_zh } : {}),
          ...(agent.description_en ? { description_en: agent.description_en } : {}),
          ...(agent.knowhow ? { knowhow: agent.knowhow } : {}),
          ...(agent.standards ? { standards: agent.standards } : {}),
          ...(agent.inputs ? { inputs: agent.inputs } : {}),
        },
      } : {}),
      model: {
        providerId: model.providerId!,
        modelId: model.modelId!,
        ...(model.reasoningProfile ? { reasoningProfile: model.reasoningProfile } : {}),
      },
      capabilities,
      prompt: {
        systemSections: prompt.systemSections!,
        ...(prompt.locale ? { locale: prompt.locale } : {}),
      },
      runtime: {
        sessionPolicy: runtime.sessionPolicy!,
        memoryPolicy: runtime.memoryPolicy!,
        loopPolicy: runtime.loopPolicy!,
        sandboxProfile: runtime.sandboxProfile!,
        timeoutMs: runtime.timeoutMs!,
        budget: {
          ...(runtime.budget.maxCost !== undefined ? { maxCost: runtime.budget.maxCost! } : {}),
          ...(runtime.budget.maxTokens !== undefined ? { maxTokens: runtime.budget.maxTokens! } : {}),
        },
      },
      permissions: {
        tools: permissions.tools!,
        files: permissions.files!,
        sideEffects: permissions.sideEffects!,
        approvalMode: permissions.approvalMode!,
      },
      provenance: {
        createdBy: provenance.createdBy!,
        sourceSessionId: provenance.sourceSessionId!,
        sourceAssetRefs: provenance.sourceAssetRefs!,
        ...(provenance.verificationRunId ? { verificationRunId: provenance.verificationRunId } : {}),
      },
    },
  };
}

export function validateCreatorPresetManifest(input: unknown): CreatorSchemaResult {
  try {
    return validateCreatorPresetManifestInternal(input);
  } catch {
    return {
      ok: false,
      issues: [{ code: 'creator_invalid_value', path: '', message: 'manifest could not be inspected' }],
    };
  }
}
