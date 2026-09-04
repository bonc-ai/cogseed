import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');

/**
 * Regression guard for the security settings page status mapping.
 *
 * A build that intentionally ships without the bundled deep scanner reports
 * `scanner: 'absent_by_build'` from main. That is a supported product shape
 * (reduced coverage), not a malfunction: the page must render it as a warning
 * ("本构建未附带…") and must NOT reuse the `broken` label ("异常（应存在但缺失）"),
 * which is reserved for a scanner that should be present but is missing.
 */

class FakeBody {
  dataset: Record<string, string> = {};
  innerHTML = '';
  listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, handler: () => void) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  querySelector(_selector: string) {
    return null;
  }
}

function loadSecurityPage(status: unknown) {
  const body = new FakeBody();
  const document = {
    readyState: 'complete',
    querySelector(selector: string) {
      if (selector === '#settings-security-body') return body;
      return null;
    },
  };
  const invoke = (channel: string) => {
    if (channel === 'skills.security.status') return Promise.resolve({ status });
    if (channel === 'skills.trust.list') return Promise.resolve({ receipts: [] });
    if (channel === 'skills.list') return Promise.resolve({ skills: [] });
    return Promise.resolve(null);
  };
  const context: any = {
    document,
    console,
    Promise,
    window: {
      addEventListener: () => {},
      cogseed: { invoke },
    },
    // Return the i18n key itself: assertions pin the exact keys used.
    t: (key: string) => key,
  };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(root, 'src/renderer/modules/settings-security.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'settings-security.js' });
  return { window: context.window, body };
}

const absentStatus = {
  scanner: 'absent_by_build',
  scannerIntegrity: 'unreadable',
  sentryEngineVersion: '',
  sentryRulesetVersion: 'v1.0.0',
  declarationEngineVersion: '',
  declarationIntegrity: 'unreadable',
  scannerAbsentByBuild: true,
};

const brokenStatus = {
  scanner: 'broken',
  scannerIntegrity: 'unreadable',
  sentryEngineVersion: '',
  sentryRulesetVersion: 'v1.0.0',
  declarationEngineVersion: '',
  declarationIntegrity: 'unreadable',
  scannerAbsentByBuild: false,
};

const presentStatus = {
  scanner: 'present',
  scannerIntegrity: 'verified',
  sentryEngineVersion: '2.1.0',
  sentryRulesetVersion: 'v1.0.0',
  declarationEngineVersion: '1.1.1',
  declarationIntegrity: 'verified',
  scannerAbsentByBuild: false,
};

describe('settings security status mapping', () => {
  it('renders absent_by_build as a warning with the not-bundled label, not as broken', async () => {
    const { window, body } = loadSecurityPage(absentStatus);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.scanner_absent_build');
    expect(body.innerHTML).toContain('settings.security.scanner_not_present_sub');
    expect(body.innerHTML).not.toContain('settings.security.scanner_broken');
    expect(body.innerHTML).toContain('sec-pill warn');
    // Hero must be attention-level, not the tamper/alert wording.
    expect(body.innerHTML).toContain('settings.security.hero_attention');
    expect(body.innerHTML).toContain('settings.security.tag_attention');
    expect(body.innerHTML).not.toContain('settings.security.hero_alert');
  });

  it('renders a broken scanner as an alert with the broken label', async () => {
    const { window, body } = loadSecurityPage(brokenStatus);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.scanner_broken');
    expect(body.innerHTML).toContain('settings.security.card_scanner_note_broken');
    expect(body.innerHTML).toContain('settings.security.hero_alert');
    expect(body.innerHTML).toContain('settings.security.tag_alert');
    expect(body.innerHTML).not.toContain('settings.security.scanner_absent_build');
  });

  it('renders a present, fully verified scanner as healthy', async () => {
    const { window, body } = loadSecurityPage(presentStatus);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.scanner_present');
    expect(body.innerHTML).toContain('settings.security.hero_ok');
    expect(body.innerHTML).toContain('settings.security.tag_ok');
    expect(body.innerHTML).not.toContain('settings.security.tag_attention');
    expect(body.innerHTML).not.toContain('settings.security.tag_alert');
  });
});
