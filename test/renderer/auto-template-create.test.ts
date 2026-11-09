import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// S5：用 Hub 任务模板新建定时任务（spec US2）。源码级契约，风格同
// workspace-template-create.test.ts；真实交互留给 Chromium fixture 与真机走查。

const root = path.join(__dirname, '../../src/renderer');
const auto = fs.readFileSync(path.join(root, 'modules/auto.js'), 'utf8');
const locales = Object.fromEntries(['zh', 'en', 'ja', 'pt'].map((lang) => [
  lang, JSON.parse(fs.readFileSync(path.join(root, `locales/${lang}.json`), 'utf8')) as Record<string, string>,
]));

describe('S5 › 从 Hub 任务模板新建', () => {
  it('merges platform templates into the starter grid without a source label and keeps the built-ins', () => {
    // 平台卡片进同一个 `auto-tpl-grid`，用 `data-auto-tpl="hub:<id>"` 区分，不加标签。
    expect(auto).toContain('_autoHubCardsHtml()');
    // 内置模板与平台模板共用一个卡片 helper，平台卡片靠 `hub:<id>` 前缀区分来源。
    expect(auto).toContain('_autoTemplateCardHtml({');
    expect(auto).toContain('id: `hub:${id}`');
    expect(auto).toContain('auto-tpl-grid ui-resource-grid">${cards}${_autoHubCardsHtml()}');
    // 7 个内置示例 + 空白保持不变。
    expect(auto).toMatch(/tech_news[\s\S]*daily_wrapup[\s\S]*meeting_prep[\s\S]*meeting_digest[\s\S]*weekly_report[\s\S]*project_health[\s\S]*monthly_admin[\s\S]*blank/);
    expect(auto).not.toMatch(/auto-tpl-card-source/);
  });

  it('prefills content, Agent and Skill chips without inventing a task-level connector dependency', () => {
    expect(auto).toContain('chatUseTextFromMessageParts(parts)');
    expect(auto).toContain("kind: r.kind === 'agent' ? 'agent' : 'skill', id: r.id, name: r.id");
    expect(auto).not.toContain("...(tpl.connector_types || []).map");
    expect(auto).toContain('const content = _autoTemplateDisplayText(tpl, tpl.content);');
    expect(auto).toContain('_autoSetComposerValue(text || content)');
    expect(auto).toContain('`【${_autoHubFillLabel(tpl, id)}】`');
  });

  it('blocks create while the template still has fill-ins and selects the first one', () => {
    expect(auto).toContain('const _AUTO_FILL_RE = /【[^】]*】/g;');
    // 只拦模板声明过的标签；正文里的普通【…】不误伤。
    expect(auto).toContain('const declaredFillLabels = Array.isArray(tpl.fill_ins)');
    expect(auto).toContain('declaredFillLabels.length === 0 || declaredFillLabels.includes(label)');
    expect(auto).toContain('if (left.length) {');
    expect(auto).toContain("_autoSetFormError(t('auto.fill_required', { label: left[0] }), ta);");
    expect(auto).toContain('_autoSelectFillIn(ta, left[0]);');
    expect(auto).toContain('ta.setSelectionRange(at, at + label.length + 2);');
  });

  it('leaves a one-time template date empty and blocks a missing or past date', () => {
    expect(auto).toContain("if (sched.type === 'one_time')");
    expect(auto).toContain('if (dateInput) dateInput.value = \'\';');
    expect(auto).toContain("_autoSetFormError(t('auto.pick_date'), dateInput);");
    expect(auto).toContain("_autoSetFormError(t('auto.pick_future_date'), dateInput);");
    expect(auto).toContain('if (target.getTime() <= Date.now())');
  });

  it('does not render or gate task templates on connectors', () => {
    expect(auto).not.toContain("const notReady = (resolved.connectors || []).filter");
    expect(auto).not.toContain("_autoSetFormError(t('auto.connector_needed'), ta);");
    expect(auto).toContain("window.cogseed.invoke('templates.refs.resolve', { refs })");
    expect(auto).not.toMatch(/data-auto-add-connector|connector-picker-add/);
  });

  it('lets the user create without Hub content that has been disabled', () => {
    expect(auto).toContain('window.TemplateInstall.confirmDropUnavailable(split.unavailable, { what })');
    expect(auto).toContain('const dropRefs = new Set(split.unavailable.map((u) => `${u.ref.kind}:${u.ref.id}`));');
    expect(auto).toContain('refs = refs.filter((r) => !dropRefs.has(`${r.kind}:${r.id}`));');
  });

  it('marks risky template text from the catalog detail', () => {
    expect(auto).toContain("t('auto.hub_risk', { count: risk.length })");
    expect(auto).toContain("el.className = 'auto-hub-risk';");
  });

  it('creates once with the template origin and derived requirements', () => {
    expect(auto).toContain("request_id: ctx.requestId");
    expect(auto).toContain('...(hubExtra.template_origin ? { template_origin: hubExtra.template_origin } : {})');
    expect(auto).toContain('...(hubExtra.requirements ? { requirements: hubExtra.requirements } : {})');
    expect(auto).toContain('skills: refs.filter((r) => r !== executionAgent),');
    expect(auto).not.toContain('connector_types: connectorTypes,');
  });

  it('persists only dependencies still selected when the form is saved', () => {
    expect(auto).toContain("s.kind === 'skill' || s.kind === 'agent'");
    expect(auto).toContain("selectedDependencyKeys.has(`${r.kind === 'agent' ? 'agent' : 'skill'}:${String(r.id || '')}`)");
    expect(auto).not.toContain('(tpl.connector_types || []).filter');
    expect(auto).toContain('useState.selections, _autoCurrentRecipient');
  });

  it('restores template requirements while editing and keeps extra Agent chips out of message invocations', () => {
    expect(auto).toContain('if (task && task.template_origin && task.requirements)');
    expect(auto).toContain('requestId: task.template_origin.request_id');
    expect(auto).toContain('const messageParts = _autoPersistableMessageParts(parsedMessageParts);');
    expect(auto).toContain("part.kind === 'agent'");
  });

  it('prefills the execution Agent and drops its requirement after switching recipient', () => {
    expect(auto).toContain("_autoCurrentRecipient = tpl.execution_agent");
    expect(auto).toContain("recipient.kind === 'agent'");
    expect(auto).toContain("String(recipient.id || '') === String(tpl.execution_agent.id || '')");
  });

  it('adds no extra summary row for the next run or requirements', () => {
    // 评审会 M4：不加「下次执行 / 需要」展示行。
    expect(auto).not.toMatch(/auto\.next_run|auto\.requirements_row/);
    expect(auto).not.toContain('auto-tpl-next-run');
  });

  it('every new string exists in all four locales', () => {
    const keys = [
      'auto.hub_login_hint', 'auto.hub_error', 'auto.hub_cached', 'auto.hub_unusable',
      'auto.hub_risk', 'auto.hub_template_failed', 'auto.tpl_client_too_old', 'auto.tpl_too_long',
      'auto.fill_required', 'auto.pick_date', 'auto.pick_future_date', 'auto.install_incomplete',
      'auto.what_task',
    ];
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      for (const key of keys) {
        expect(locales[lang][key], `${lang}:${key}`).toBeTruthy();
      }
    }
  });

  it('shows why the last run was skipped and lists missing items on rejection', () => {
    expect(auto).toContain("parts.push(t('auto.skip_reason'");
    expect(auto).toContain("if (error === 'requirements_not_ready')");
    expect(auto).toContain('_autoShowRequirementIssues(result.items);');
    expect(auto).toContain("res.error === 'requirements_not_ready'");
    expect(auto).toContain('_autoShowRequirementIssues(res.items);');
    // 缺项讲清是什么、什么状态，不只丢一句「失败」。
    expect(auto).toContain("t('auto.req_skill')");
    expect(auto).toContain("t('auto.req_connector')");
    expect(auto).toContain("t('auto.req_not_installed')");
    expect(auto).toContain("t('auto.req_disabled')");
  });

  it('has the skip copy in all four locales', () => {
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      expect(locales[lang]['auto.skip_reason']).toBeTruthy();
      expect(locales[lang]['auto.req_blocked_body']).toBeTruthy();
      expect(locales[lang]['auto.req_connector']).toBeTruthy();
    }
  });

  it('classifies Hub failures and keeps the built-in examples usable', () => {
    expect(auto).toContain("case 'offline': return t('auto.hub_offline')");
    expect(auto).toContain("case 'forbidden': return t('auto.hub_forbidden')");
    expect(auto).toContain("case 'invalid_template': return t('auto.hub_tpl_invalid')");
    expect(auto).toContain("t('auto.hub_cached_with_reason'");
    expect(auto).toContain('if (st.hidden) return');
    expect(auto).toContain("t('auto.need_online')");
  });

  it('treats unknown refs and withdrawn templates as update-client cases', () => {
    expect(auto).toContain("filter((i) => i.state === 'unknown')");
    expect(auto).toContain("t('auto.req_unknown_client')");
    expect(auto).toContain("t('auto.hub_tpl_gone')");
    expect(auto).toContain('void _ensureTaskTemplates(true);');
    expect(auto).toContain("res.creatable === false && res.blocked_reason === 'disabled'");
    expect(auto).toContain("t('auto.hub_tpl_needs_update')");
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      expect(locales[lang]['auto.hub_tpl_gone']).toBeTruthy();
      expect(locales[lang]['auto.req_unknown_client']).toBeTruthy();
      expect(locales[lang]['auto.need_online']).toBeTruthy();
    }
  });
});
