/** Read-streak heuristic only, never an execution/permission decision.
 * Deliberately accepts a small shell grammar and positive option lists.
 * Unknown syntax, substitutions, redirects, wrappers and executable sed/rg
 * options are barriers. This Core helper has no host/feature dependencies. */
export function isConservativeShellRead(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || command.length > 16_000) return false;
  const pipeline = tokenizeReadPipeline(command);
  return !!pipeline?.length && pipeline.every(isReadCommand);
}

function tokenizeReadPipeline(command: string): string[][] | undefined {
  const pipeline: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  const flush = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else {
        if (quote === '"' && /[$`\\]/.test(char)) return undefined;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/[\n\r\x00<>;&()$`\\#]/.test(char)) return undefined;
    if (char === "|") {
      flush();
      if (!words.length) return undefined;
      pipeline.push(words);
      words = [];
    } else if (/\s/.test(char)) flush();
    else { word += char; started = true; }
  }
  if (quote) return undefined;
  flush();
  if (!words.length) return undefined;
  pipeline.push(words);
  return pipeline;
}

const GREP_FLAGS = new Set([
  "--line-number", "--ignore-case", "--fixed-strings", "--extended-regexp",
  "--recursive", "--files-with-matches", "--count", "--invert-match", "--only-matching",
]);
const RG_FLAGS = new Set([
  ...GREP_FLAGS, "--files", "--hidden", "--no-ignore", "--no-heading",
  "--heading", "--with-filename", "--no-filename", "--word-regexp", "--line-regexp",
  "--case-sensitive", "--smart-case", "--multiline", "--pcre2", "--text",
]);
const GREP_VALUES = new Set(["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude"]);
const RG_VALUES = new Set([...GREP_VALUES, "--glob", "--iglob", "--type", "--type-not", "--max-depth", "--max-columns", "--encoding", "--color"]);

function isReadCommand([name, ...args]: string[]): boolean {
  if (name === "sed") {
    // Numeric print ranges only. No -i, -f, arbitrary -e, e/w/r commands,
    // substitution flags, or scripts that can launch subprocesses/write files.
    if (args[0] === "-n") args = args.slice(1);
    if (args[0] === "--") args = args.slice(1);
    return args.length > 0
      && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[0])
      && args.slice(1).every((arg) => !arg.startsWith("-"));
  }
  if (name === "cat") {
    return safeOptions(args, /^[AbensuvETet]+$/, new Set([
      "--number", "--number-nonblank", "--squeeze-blank", "--show-all",
      "--show-ends", "--show-tabs", "--show-nonprinting",
    ]), new Set(), new Set());
  }
  if (name === "grep") return safeOptions(args, /^[nriIlLcqsvwxEFGHoahRb]+$/, GREP_FLAGS, GREP_VALUES, new Set(["e", "f", "m", "A", "B", "C"]));
  if (name === "rg") return safeOptions(args, /^[niIlLcqsvwxFHoaUSuP]+$/, RG_FLAGS, RG_VALUES, new Set(["e", "f", "m", "A", "B", "C", "g", "t", "T"]));
  return false;
}

function safeOptions(args: string[], shortFlags: RegExp, flags: Set<string>, values: Set<string>, shortValues: Set<string>): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return true;
    if (arg === "-" || !arg.startsWith("-")) continue;
    const equals = arg.indexOf("=");
    const option = equals < 0 ? arg : arg.slice(0, equals);
    if (flags.has(arg)) continue;
    if (values.has(option)) {
      if (equals < 0 && ++i >= args.length) return false;
      continue;
    }
    if (arg.startsWith("--")) return false;
    if (shortValues.has(arg[1])) {
      if (arg.length === 2 && ++i >= args.length) return false;
      continue;
    }
    if (!shortFlags.test(arg.slice(1))) return false;
  }
  return true;
}
