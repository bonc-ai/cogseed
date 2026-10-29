/** Pure tool contract shared by the in-process SDK and isolated Runtime.
 * No glossary storage, model client or Electron imports may enter this module.
 * Correction evidence travels separately from model-visible text and survives caps. */
export interface TranscriptCorrectionEvidence {
  state: 'scanned' | 'applied' | 'blocked' | 'needs_confirmation';
  docId: string;
  sourceHash: string;
  /** The `path` input exactly as passed, when the source was read from a file. */
  source?: string;
  confirmationItems?: Array<{ wrong: string; correct: string; context: string; count: number }>;
}
export interface TranscriptToolResult {
  content: string;
  isError?: boolean;
  correction?: TranscriptCorrectionEvidence;
}
export const GLOSSARY_KINDS = ['product', 'people', 'org', 'term', 'venue', 'course', 'filler'] as const;
export const TRANSCRIPT_TOOL_DEFINITIONS = [
  { name: 'transcript_glossary_scan' as const,
    description: 'Scan a meeting transcript against the user\'s correction glossary and report matches\n'
      + 'WITHOUT changing the text. Run right after fetching a transcript, before writing minutes.\n'
      + 'Pass the transcript file `path` (or, if it is not a file yet, the text verbatim).\n'
      + 'Reports auto-applicable vs needs-confirmation separately.\n'
      + 'By default a model ALSO reads the text and proposes corrections the glossary cannot\n'
      + 'match (misspellings that sound/look nothing like the right word) — ASR errors are an\n'
      + 'open set, so a pure lookup always misses some. Model suggestions are shown in a card\n'
      + 'for explicit user confirmation. Apply reuses the exact scanned candidates and decisions.\n'
      + 'Pass includeReview:false only when you want rule-only\n'
      + 'results right now.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path of a transcript file in the task workspace. Preferred over `text`:\n'
            + 'the host reads the file, so you never retype the transcript, and derives docId from the file.\n'
            + 'Pass the SAME path to scan and apply.',
        },
        text: {
          type: 'string',
          description: 'Only when the transcript is not a file yet: the text to scan, verbatim.',
        },
        docId: {
          type: 'string',
          description: 'Stable id of this transcript document (scope + audit ledger). Required with `text`;\n'
            + 'ignored with `path`.',
        },
        outputPath: {
          type: 'string',
          description: 'Where the host will write the corrected transcript once it is fully applied. Name it\n'
            + 'here: apply, including the automatic continuation after the user confirms, reuses it.',
        },
        rawOutputPath: {
          type: 'string',
          description: 'Where the host saves the untouched source transcript, right away. It never\n'
            + 'overwrites an existing file with different content. Use this instead of write_file.',
        },
        scenarioTags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional scenario tags; entries scoped to a scenario only apply when matched.',
        },
        includeDelete: {
          type: 'boolean',
          description: 'Also scan filler/verbal-tic deletion rules. Default false (P1 rules).',
        },
        includeReview: {
          type: 'boolean',
          description:
            'Let a model also read the text and propose corrections the glossary cannot match\n'
            + '(misspellings that sound/look nothing like the right word). Default TRUE — a pure\n'
            + 'lookup cannot cover an open error set. Pass false to skip it (rule-only, faster).\n'
            + 'Model suggestions are shown for explicit user confirmation before application.',
        },
      },
      required: [],
    },
  },
  { name: 'transcript_glossary_apply' as const,
    description: 'Apply glossary corrections. Only risk=low|medium is applied automatically. If the result is\n'
      + '`status: draft`, an inline card asks the user to confirm the remaining items — you MUST NOT write\n'
      + 'minutes until the user answers. Once applied, the host writes the corrected transcript itself\n'
      + '(see outputPath) and returns its path; do not rewrite it with write_file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path of a transcript file in the task workspace. Preferred over `text`:\n'
            + 'the host reads the file, so you never retype the transcript, and derives docId from the file.\n'
            + 'Pass the SAME path to scan and apply.',
        },
        text: {
          type: 'string',
          description: 'Only when the transcript is not a file yet: the text to correct, verbatim.',
        },
        docId: {
          type: 'string',
          description: 'Stable id of this transcript document (scope + audit ledger). Required with `text`;\n'
            + 'ignored with `path`.',
        },
        outputPath: {
          type: 'string',
          description: 'Where the host writes the corrected transcript once fully applied. Defaults to the\n'
            + 'one named at scan, else (with `path`) a sibling `<name>.corrected<ext>` file. When the file\n'
            + 'is written the result returns its path and the changes, not the corrected text.',
        },
        rawOutputPath: {
          type: 'string',
          description: 'Optional: where the host saves the untouched source transcript. It never overwrites\n'
            + 'an existing file with different content.',
        },
        scenarioTags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional scenario tags, same meaning as in scan.',
        },
        acceptRiskLevels: {
          type: 'array',
          items: { type: 'string', enum: ['low', 'medium', 'high'] },
          description:
            'Risk levels to apply automatically. Default ["low","medium"].\n'
            + 'Only add "high" when the user has explicitly confirmed those specific replacements.',
        },
        includeDelete: {
          type: 'boolean',
          description: 'Also apply filler/verbal-tic deletion rules. Default false.',
        },
        confirmation_token: {
          type: 'string',
          description:
            'Pass the token from a previous call that returned `needs_user_confirmation` to apply the\n'
            + 'items the user actually ticked on the inline card. Omit it on the first call.\n'
            + 'The token is one-shot and bound to the exact transcript text; if the text changed you get\n'
            + '`stale` and must scan again.',
        },
      },
      required: [],
    },
  },
  { name: 'transcript_glossary_upsert' as const,
    description: 'Add or update one glossary entry so future transcripts are corrected automatically. Use after\n'
      + 'the user confirms a replacement or names a mangled person/proper noun. Risk level is derived\n'
      + 'by the engine and can only be raised, never lowered. Never add common words unprompted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        wrong: {
          type: 'string',
          description: 'The mangled form as it appears in transcripts (as the user typed/said it).',
        },
        correct: {
          type: 'string',
          description: 'The authoritative spelling to replace it with.',
        },
        kind: {
          type: 'string',
          enum: [...GLOSSARY_KINDS],
          description: 'Entry category. Default "term"; use "person" for names, "product" for product names.',
        },
        riskLevel: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            'Optional hint. The engine may raise it (never lower it): 2-char Chinese forms become high.',
        },
        docId: {
          type: 'string',
          description:
            'Document this term was seen in. When the user has NOT confirmed global use, pass it so the\n'
            + 'entry is scoped to this transcript instead of becoming a global rule.',
        },
        partial: {
          type: 'boolean',
          description: 'Mark the entry as valid only in a specific context → forces risk=high.',
        },
      },
      required: ['wrong', 'correct'],
    },
  },
  { name: 'transcript_glossary_list' as const,
    description: 'List entries in the user\'s correction glossary (people, products, domain terms, and the\n'
      + 'mangled forms they replace). Use this to answer "what words do you correct?", to check\n'
      + 'whether a term is already known before adding it, and to show the user what was seeded.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: [...GLOSSARY_KINDS],
          description: 'Optional: restrict to one category.',
        },
        riskLevel: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Optional: restrict to one risk level.',
        },
        search: {
          type: 'string',
          description: 'Optional: case-insensitive substring match on the mangled form or the correct form.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum entries to return. Default 80.',
        },
      },
      required: [],
    },
  }
];
export type TranscriptToolName = typeof TRANSCRIPT_TOOL_DEFINITIONS[number]['name'];
export function isTranscriptToolName(name: string): name is TranscriptToolName {
  return TRANSCRIPT_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

/** Feature-owned executable tool shape; the SDK adapter is structural only. */
export interface TranscriptTool {
  name: TranscriptToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  executionMode: 'parallel' | 'sequential';
  execute(input: Record<string, unknown>, context?: unknown): Promise<TranscriptToolResult>;
}
