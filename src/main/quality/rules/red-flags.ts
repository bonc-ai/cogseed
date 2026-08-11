/**
 * EXTREME red-flag patterns scanned across skill scripts + SKILL.md embedded
 * code blocks + agent.json paths.
 *
 * Each rule = one regex against the textual content. The 9-rule list is the
 * sole authority; new rules append here, no other file changes.
 *
 * Why static patterns: deterministic, no LLM judgment, < 1ms per file. This
 * is a "block 60-80% of explicit malice" tool — runtime path-sandbox is the
 * sandbox layer that catches the rest.
 *
 * Scope:
 *   - 'script' files (scripts/<file>.{py,sh,ts,js,mjs,rb,bash,ps1,cmd,bat})
 *   - 'skill_md' embedded fenced code blocks (```bash / ```sh / ```python)
 *   - 'agent_json' path-string fields
 *   Prose in SKILL.md is NOT scanned — false-positive rate is too high
 *   ("this skill handles ssh config" ≠ "reads ssh private keys").
 */

import { RuleDef, ScanKind, Violation } from '../types';
import { adjustForContext, fileContext, isExplanatoryPosition, languageOf } from './context';

// ── Rule list ────────────────────────────────────────────────────────────

export const RED_FLAGS: ReadonlyArray<RuleDef> = [
  {
    id: 'no_credential_path_read',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md', 'agent_json'],
    // ~/.ssh, ~/.aws/credentials, ~/.gnupg, .env / .env.*, security find-generic-password
    pattern: /(~\/\.ssh\/|\.aws\/credentials|~\/\.gnupg\/|(?:^|[\s'"\/=:])\.env(?:\.[\w-]+)?(?:[\s'"]|$)|security\s+find-generic-password)/i,
    suggested_fix: 'Do not access credential files directly. Accept the relevant path or secret as an input argument from the user.',
  },
  {
    // Root-scope recursive deletion only. `rm -rf ./build` and `rm -rf "$TMPDIR/x"`
    // are ordinary cleanup and must stay clean — the engine already scores those
    // as `pass`, and promoting them here would break every build-tidying skill.
    // What this catches is deletion aimed at `/`, `$HOME`, `~`, or a bare glob,
    // which has no legitimate use inside a skill.
    //
    // Added because the engine blocks `rm -rf /` via a bare `DO_NOT_INSTALL`
    // recommendation carrying no rule id, so there was nothing for the override
    // gate to key on: the most obviously unsafe command in the corpus would have
    // become user-overridable for lack of an identifier.
    id: 'no_root_scope_destruction',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:\/|~|\$HOME|\*)(?:\s|$|;|&)|\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+(?:\/|~|\$HOME|\*)(?:\s|$|;|&)/,
    suggested_fix: 'Never delete recursively at / , ~ or $HOME. Scope the deletion to a specific relative path inside the working directory.',
  },
  {
    id: 'no_eval_with_external_input',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // eval( / new Function( / Python exec( / shell `eval "$VAR"`
    pattern: /\b(?:eval|exec)\s*\(\s*(?!['"][^'"]*['"]?\s*\))|new\s+Function\s*\(|eval\s+["']?\$[A-Z_]/,
    suggested_fix: 'Avoid eval / exec on non-literal input. Restructure to call specific functions explicitly.',
  },
  {
    id: 'no_download_then_execute',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // curl|bash / wget|sh / curl|powershell / curl|cmd / pip install <url-or-git>
    pattern: /(?:curl|wget)\b[^\n]*\|\s*(?:bash|sh|zsh|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?)\b|pip\s+install\s+(?:https?:\/\/|git\+)/i,
    suggested_fix: 'Do not pipe remote content into a shell. Require the user to install dependencies through normal package managers.',
  },
  {
    id: 'no_shell_init_or_persistence',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Write to ~/.bashrc / .zshrc / .profile / .bash_profile / LaunchAgents / cron / systemd unit
    pattern: /(?:>>?|tee|cat\s+>|cp\b[^\n]*?)\s*(?:~|\$HOME)\/\.(bashrc|zshrc|profile|bash_profile)|~\/Library\/LaunchAgents\/|\/etc\/cron|systemd\b[^\n]*?\.service/i,
    suggested_fix: 'Do not modify shell startup files or install persistence services. Skill code must not alter the user environment outside the workspace.',
  },
  {
    id: 'no_cross_agent_private_read',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md', 'agent_json'],
    // ~/.claude/projects/*/memory/ / paths into other agents' meta/ or other skills' SKILL.md
    pattern: /~\/\.claude\/projects\/[^\/\s]+\/memory\/|cloud\/agents\/[^\/\s]+\/meta\/|cloud\/skills\/[^\/\s]+\/SKILL\.md/,
    suggested_fix: 'Do not read other agents\' memory / metacognition or other skills\' SKILL.md. Each skill or agent only accesses its own data.',
  },
  {
    id: 'no_obfuscated_payload',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Three forms:
    //   1. `base64 -d | <interpreter>` shell pipeline
    //   2. `atob(...) ; eval(...)` (two separate calls in sequence)
    //   3. `eval(atob(...))` / `Function(atob(...))` (nested call)
    pattern: /base64\s+(?:-d|--decode)[^\n]*?\|\s*(?:bash|sh|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|python|python3|node|tsx)\b|atob\s*\([^)]*\)\s*[;,]?\s*(?:eval|new\s+Function)\s*\(|(?:eval|new\s+Function)\s*\(\s*atob\s*\(/i,
    suggested_fix: 'Do not decode and execute encoded payloads. Write the executable logic in clear text so it can be reviewed.',
  },
  {
    id: 'no_shell_history_read',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    pattern: /\.(bash|zsh|fish)_history\b/,
    suggested_fix: 'Do not read shell history files; they often contain ad-hoc credentials and per-user context outside the skill\'s scope.',
  },
  {
    id: 'no_spec_self_modification',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Shell redirect / shell write commands / JS write APIs targeting a spec file.
    // Each form requires syntactically valid usage so the rule doesn't false-positive
    // on prose mentions like `<capability> SKILL.md` or Python strings such as
    // `estimated_total_nodes > 100(SKILL.md ...)`.
    pattern: /(?:^|\s|;|&&|\|\|)(?:>>?)\s*['"]?(?:(?:\.{1,2}|~|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][\w.-]*|\/)[^'"\s;|&]*\/)?(?:SKILL\.md|agent\.json|_install\.json)\b|(?:^|\s|;|&&|\|\|)(?:tee|cp|mv)\s+[^\n;|&]*?(?:SKILL\.md|agent\.json|_install\.json)\b|(?:writeFileSync|fs\.writeFile|fs\.promises\.writeFile|open\s*\([^)]*['"](?:w|wb)['"])\s*[^\n;]*?(?:SKILL\.md|agent\.json|_install\.json)\b/i,
    suggested_fix: 'Skill or agent code must not mutate its own spec or another skill\'s spec. Spec changes go through the editor or the spec_patch_suggester evolution flow.',
  },
  {
    id: 'no_write_outside_workspace',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Common absolute writes outside obvious workspace / cache / tmp roots.
    // Conservative: only matches when an absolute path looks like it targets
    // user / system directories that a skill should never touch. The intent
    // is high precision, low recall — better miss a write than misflag.
    pattern: /(?:>>?|tee|cp\b|mv\b|writeFileSync\s*\(|fs\.writeFile|open\s*\([^)]*['"]w['"])[^\n]*?(?:\/etc\/|\/usr\/(?:bin|local|share)|\/System\/|\/Library\/(?!Caches\/))/,
    suggested_fix: 'Do not write to system directories. Skills must only write inside the workspace, the system temp directory, or a path the user explicitly provided.',
  },

  // ── Hardcoded credentials ──────────────────────────────────────────────
  // Ported from the standalone scanner, which had 20 secret patterns while this
  // validator had none. Provider-issued tokens are the lowest-false-positive
  // class available: the prefixes and lengths are vendor-fixed, so a match is
  // almost never coincidence.
  //
  // All are `neverDemote`: a live credential in `tests/` is still live. That is
  // the one class where "it's only a test file" is not mitigating.
  {
    id: 'no_hardcoded_provider_token',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md', 'agent_json'],
    neverDemote: true,
    // GitHub (ghp_/gho_/ghu_/ghs_/ghr_ + 36), fine-grained PAT, GitLab,
    // Slack bot/user tokens, Stripe live secret, SendGrid, PyPI upload,
    // Telegram bot, Discord bot, HashiCorp Vault.
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b|\bglpat-[A-Za-z0-9_-]{20}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bsk_live_[A-Za-z0-9]{20,}\b|\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b|\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b|\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b|\bhv[sb]\.[A-Za-z0-9_-]{24,}\b/,
    suggested_fix: 'Remove the hardcoded token and read it from an environment variable or an input parameter. Rotate the credential — anything committed must be considered compromised.',
  },
  {
    id: 'no_hardcoded_cloud_or_model_key',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md', 'agent_json'],
    neverDemote: true,
    // AWS access key id, OpenAI (sk-… / project keys), Anthropic, Google API key.
    // `sk-` requires ≥32 trailing chars so short placeholders like `sk-test` and
    // `sk-xxx` in documentation do not match.
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b|\bsk-ant-[A-Za-z0-9_-]{24,}\b|\bAIza[A-Za-z0-9_-]{35}\b/,
    suggested_fix: 'Remove the hardcoded key and read it from an environment variable or an input parameter. Rotate the credential — anything committed must be considered compromised.',
  },
  {
    id: 'no_private_key_material',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md', 'agent_json'],
    neverDemote: true,
    // PEM private key blocks of any flavour (RSA / EC / OPENSSH / PGP).
    pattern: /-----BEGIN\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----/,
    suggested_fix: 'Never embed private key material. Reference a key file path supplied by the user at runtime.',
  },
  {
    id: 'no_hardcoded_webhook_url',
    level: 'MEDIUM',
    appliesTo: ['script', 'skill_md', 'agent_json'],
    // Slack / Discord webhooks are both a credential and an egress channel:
    // possession of the URL is sufficient to post. MEDIUM rather than EXTREME
    // because legitimate skills do integrate with chat platforms — the URL just
    // must not be baked in.
    neverDemote: true,
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/_-]{20,}|https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/i,
    suggested_fix: 'Do not hardcode webhook URLs; accept the destination as a configured input. Rotate the webhook if it has been committed.',
  },

  // ── Persistence ────────────────────────────────────────────────────────
  // `no_shell_init_or_persistence` covers shell rc files, LaunchAgents and
  // `/etc/cron*` paths. Probing the vectors it misses turned up ten more, so
  // these fill measured gaps rather than duplicating existing coverage.
  //
  // Persistence is the step that turns a one-shot execution into a permanent
  // foothold, so these are EXTREME: a skill has no legitimate reason to arrange
  // for its own code to run again later outside the app.
  {
    id: 'no_scheduled_task_install',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // The `crontab` command itself was uncovered — the existing rule only
    // matched `/etc/cron` paths, so `crontab -` / `crontab file` slipped by.
    // `-l` is excluded: listing existing jobs is a read, and the common
    // read-modify-write idiom `(crontab -l; echo …) | crontab -` is still
    // caught by the trailing `crontab -`. Also covers systemd unit activation,
    // user-scope units, and the Windows equivalents.
    pattern: /\bcrontab\s+(?:-[eir]\b|-\s*$|(?!-)[^\s|;&]+)|\bsystemctl\s+(?:--user\s+)?enable\b|\.config\/systemd\/user\/|\bschtasks\s+\/create\b|\bat\s+(?:now|\d{1,2}:\d{2})\b/im,
    suggested_fix: 'Do not install scheduled tasks or services. A skill runs when the user invokes it; arranging for later execution is outside its scope.',
  },
  {
    id: 'no_login_item_or_autostart',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // macOS login items via AppleScript, LaunchDaemons/LaunchAgents install,
    // Windows Run keys and Startup folder.
    pattern: /make\s+login\s+item|\bosascript\b[^\n]*login\s+item|\/Library\/Launch(?:Agents|Daemons)\/|\breg(?:\.exe)?\s+add\b[^\n]*(?:\\|\/)(?:Run|RunOnce)\b|CurrentVersion\\+(?:Run|RunOnce)\b|Start\s+Menu[\\/]+Programs[\\/]+Startup/i,
    suggested_fix: 'Do not register login items, autostart entries, or system daemons. Persistence beyond the current invocation is not a skill capability.',
  },
  {
    id: 'no_shell_profile_variant_write',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // The existing rule lists .bashrc/.zshrc/.profile/.bash_profile but not
    // these variants, which load just as reliably.
    pattern: /(?:>>?|tee|cat\s+>|cp\b[^\n]*?|mv\b[^\n]*?)\s*(?:~|\$HOME)\/\.(?:zprofile|zshenv|zlogin|bash_login|kshrc|cshrc|tcshrc|config\/fish\/config\.fish)\b/i,
    suggested_fix: 'Do not modify shell startup files. Skill code must not alter the user environment outside the workspace.',
  },
  {
    id: 'no_git_hook_install',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // A git hook executes on ordinary developer actions (commit, checkout,
    // push), which makes `.git/hooks/` a persistence location that is easy to
    // overlook precisely because it lives inside the workspace.
    pattern: /\.git\/hooks\/(?:pre-commit|post-commit|pre-push|post-checkout|post-merge|prepare-commit-msg|commit-msg|pre-rebase|post-receive)\b/i,
    suggested_fix: 'Do not write git hooks. Hooks run on ordinary developer actions and amount to persistent code execution.',
  },

  // ── Dynamic execution & deserialization ────────────────────────────────
  // Severity here is calibrated against real usage in the builtin corpus:
  // `subprocess` appears in shipped skills as ordinary tool invocation, while
  // `shell=True` appears zero times. So running a subprocess is not by itself
  // suspicious — running one through a shell, or executing data as code, is.
  {
    id: 'no_unsafe_deserialization',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Loading a pickle/marshal stream, or a non-safe YAML load, is equivalent
    // to executing whatever produced it: these formats can instantiate
    // arbitrary objects. `yaml.safe_load` is deliberately excluded.
    pattern: /\bpickle\.loads?\s*\(|\bcPickle\.loads?\s*\(|\bmarshal\.loads?\s*\(|\bshelve\.open\s*\(|\byaml\.load\s*\((?![^)]*Safe(?:Loader)?)|\bjsonpickle\.decode\s*\(/,
    suggested_fix: 'Do not deserialize untrusted data with pickle/marshal/yaml.load — they can execute arbitrary code. Use JSON, or yaml.safe_load.',
  },
  {
    id: 'no_shell_string_execution',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Handing a command string to a shell reintroduces injection even when the
    // caller believes the input is safe. Distinct from `subprocess.run([...])`
    // with an argument list, which is the correct form and not matched here.
    pattern: /\bshell\s*=\s*True\b|\bos\.system\s*\(|\bos\.popen\s*\(|\bcommands\.getoutput\s*\(|\bchild_process\b[^\n]{0,40}\b(?:exec|execSync)\s*\(|\brequire\s*\(\s*['"]child_process['"]\s*\)\s*\.\s*(?:exec|execSync)\s*\(/,
    suggested_fix: 'Do not execute command strings through a shell. Pass an argument array (e.g. subprocess.run([...]) or execFile) so arguments cannot be reinterpreted.',
  },
  {
    id: 'no_runtime_code_construction',
    level: 'MEDIUM',
    appliesTo: ['script', 'skill_md'],
    // Building and running code at runtime. MEDIUM rather than EXTREME:
    // `importlib`/`__import__` have legitimate plugin-loading uses, and the
    // outright dangerous forms (`eval`, `exec`, decode-then-execute) are
    // already EXTREME via `no_eval_with_external_input` /
    // `no_obfuscated_payload`. This tier surfaces the rest for review.
    pattern: /\bcompile\s*\([^)]*['"]exec['"]\s*\)|\b__import__\s*\(\s*(?!['"])|\bimportlib\.import_module\s*\(\s*(?!['"])|\bvm\.run(?:InNewContext|InThisContext|InContext)\s*\(|\bnew\s+vm\.Script\s*\(/,
    suggested_fix: 'Avoid constructing code at runtime. Import known modules explicitly so the executable surface is visible to review.',
  },
  {
    id: 'no_powershell_inline_download_exec',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // The Windows counterpart of `curl | bash`, plus the encoded-command form
    // whose whole purpose is to keep the payload unreadable.
    pattern: /\b(?:IEX|Invoke-Expression)\b[^\n]*(?:DownloadString|DownloadFile|Invoke-WebRequest|iwr\b|curl\b)|(?:DownloadString|Invoke-WebRequest)[^\n]*\|\s*(?:IEX|Invoke-Expression)\b|-Enc(?:odedCommand)?\s+[A-Za-z0-9+\/=]{16,}/i,
    suggested_fix: 'Do not download and execute code in one step, and do not pass base64-encoded commands. Write the logic in clear text so it can be reviewed.',
  },

  // ── SSRF and data egress ───────────────────────────────────────────────
  // The highest-false-positive class, and the reason the context layer had to
  // land first. A defensive implementation must name what it blocks: the SEO
  // crawler's `url_safety.py` names the cloud-metadata address throughout, and
  // its test suite feeds that address in as an assertion input. Flagging those
  // is how a scanner ends up rating protective code as hostile.
  //
  // So every rule here sets `demoteInComments`, and severity is chosen on the
  // assumption that reaching the network is ordinary skill behaviour — only the
  // specific destinations and the exfiltration shape are notable.
  {
    id: 'no_cloud_metadata_access',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    demoteInComments: true,
    // The canonical SSRF target: link-local metadata endpoints that hand out
    // instance credentials. Also GCP/Azure's hostname forms, which need no IP.
    pattern: /169\.254\.169\.254|\bmetadata\.google\.internal\b|\[fd00:ec2::254\]|\bmetadata\.azure\.com\b/i,
    suggested_fix: 'Do not contact cloud instance-metadata endpoints; they return credentials. If you are implementing a guard, keep the address in a comment or a named constant used only for rejection.',
  },
  {
    id: 'no_exfiltration_of_local_files',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    demoteInComments: true,
    // The shape that matters is not "makes a request" but "sends local file
    // content outward": curl --data @file, -T/--upload-file, or a multipart
    // post built from an opened file.
    pattern: /\bcurl\b[^\n]*(?:--data(?:-binary|-raw)?|-d)\s*@|\bcurl\b[^\n]*(?:-T|--upload-file)\s|\brequests\.(?:post|put|patch)\s*\([^)]*files\s*=\s*\{[^}]*open\s*\(|\bfetch\s*\([^)]*body\s*:\s*(?:fs\.(?:createReadStream|readFileSync)|await\s+fs)/i,
    suggested_fix: 'Do not upload local files to a remote endpoint. If the user asked for an upload, take the destination as an explicit input rather than hardcoding it.',
  },
  {
    id: 'no_raw_ip_or_suspicious_tld_endpoint',
    level: 'MEDIUM',
    appliesTo: ['script', 'skill_md'],
    demoteInComments: true,
    // A hardcoded bare-IP endpoint or a free-DNS/tunnel host bypasses the
    // scrutiny a named domain invites. MEDIUM: legitimate skills do call APIs,
    // and localhost is normal in development, so this is worth a look rather
    // than a block.
    pattern: /https?:\/\/(?!127\.0\.0\.1|0\.0\.0\.0|localhost)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\/|https?:\/\/[^\s'"]*\.(?:tk|ml|ga|cf|gq|top|xyz|zip|mov)\/|https?:\/\/[^\s'"]*\.(?:ngrok(?:-free)?\.(?:io|app)|trycloudflare\.com|serveo\.net|localhost\.run)\b/i,
    suggested_fix: 'Prefer a named, documented endpoint over a bare IP or a tunnel/free-DNS host. Take the destination as configuration if it is meant to vary.',
  },
];

// ── Application ──────────────────────────────────────────────────────────

/**
 * Scan content + return violations from the matching rules.
 * `kind === 'other'` returns []; no scanning of prose / docs / assets.
 */
export function scanRedFlags(args: {
  content: string;
  kind: ScanKind;
  field: string;       // path-like locator for the report
  /**
   * Relative path used to classify file context. Defaults to `field`.
   * Pass the real path when `field` carries extra decoration (e.g. the
   * `SKILL.md:12 (```bash)` form used for embedded blocks).
   */
  relpath?: string;
}): Violation[] {
  if (args.kind === 'other') return [];
  const out: Violation[] = [];
  // Embedded code blocks in SKILL.md are authored inline, so they are always
  // first-party source regardless of the surrounding file's classification.
  const context = args.kind === 'skill_md'
    ? 'source'
    : fileContext(args.relpath ?? args.field, args.content);

  for (const rule of RED_FLAGS) {
    if (!rule.appliesTo.includes(args.kind)) continue;
    // Language gate: applying one language's semantics to another's syntax is a
    // misapplied rule, not a relaxed one. `unknown` languages still match, so
    // dangerous code pasted into docs is still surfaced.
    if (rule.langs) {
      const lang = languageOf(args.relpath ?? args.field);
      if (lang !== 'unknown' && !rule.langs.includes(lang)) continue;
    }
    const match = rule.pattern.exec(args.content);
    if (!match) continue;
    const lineNo = _lineNumberAt(args.content, match.index);
    const snippet = _excerpt(args.content, match.index, match[0].length);
    let adjusted = adjustForContext(rule.level, context, {
      ...(rule.neverDemote ? { neverDemote: true } : {}),
    });
    // A descriptive literal in a comment or docstring is documentation. This is
    // what let a defensive SSRF guard score as hostile for naming the address it
    // blocks. Reported, not dropped — the original level is preserved.
    if (
      rule.demoteInComments
      && !rule.neverDemote
      && isExplanatoryPosition(args.content, match.index, args.relpath ?? args.field)
    ) {
      const lowered = adjustForContext(adjusted.level, 'vendor');
      adjusted = {
        level: lowered.level,
        originalLevel: adjusted.originalLevel ?? rule.level,
        // Report `comment` as the context so a demotion always states its
        // reason. Leaving it as `source` would record "downgraded" with no
        // explanation, which is precisely the invisible-adjustment problem the
        // original-level field exists to avoid.
        context: adjusted.context === 'source' ? 'comment' : adjusted.context,
        demoted: true,
      };
    }
    out.push({
      level: adjusted.level,
      rule: rule.id,
      field: lineNo > 0 ? `${args.field}:${lineNo}` : args.field,
      snippet,
      suggested_fix: rule.suggested_fix,
      ...(adjusted.originalLevel ? { original_level: adjusted.originalLevel } : {}),
      ...(adjusted.context !== 'source' ? { context: adjusted.context } : {}),
    });
    // Reset stateful regex (`/g`) — we don't use /g but be safe across future
    // changes by zeroing lastIndex.
    rule.pattern.lastIndex = 0;
  }
  return out;
}

/**
 * Extract fenced code blocks of executable languages from a SKILL.md body
 * and yield each block paired with its kind for further scanning.
 *
 * Languages: bash / sh / zsh / powershell / ps1 / batch / bat / cmd /
 * python / py / js / ts / ruby / rb.
 * Code blocks of other languages (markdown / json / yaml / text / unspecified)
 * are skipped — they're documentation, not execution surface.
 */
export function extractExecutableBlocks(skillMdBody: string): Array<{
  lang: string;
  content: string;
  startLine: number;
}> {
  const out: Array<{ lang: string; content: string; startLine: number }> = [];
  const re = /```(bash|sh|zsh|powershell|ps1|batch|bat|cmd|python|py|js|javascript|ts|typescript|ruby|rb)\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skillMdBody)) !== null) {
    out.push({
      lang: m[1].toLowerCase(),
      content: m[2],
      startLine: _lineNumberAt(skillMdBody, m.index),
    });
  }
  return out;
}

function _lineNumberAt(text: string, byteIndex: number): number {
  if (byteIndex < 0 || byteIndex >= text.length) return 0;
  let n = 1;
  for (let i = 0; i < byteIndex; i++) if (text.charCodeAt(i) === 0x0a) n++;
  return n;
}

function _excerpt(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + len + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').slice(0, 200).trim();
}
