/* Generated from ui_kits/enterprise-app/AutomationScreen.jsx by tools/build.cjs. */
(() => {
  const { PageFrame, PageHeader, PageScroll, AutomationSchedule: Schedule } = window;
  const { ResourceCard, CardGrid, GroupHeading, StatusDot, EmptyState, Button, Icon, Dialog, Composer, Field, Input, Select, Checkbox } = window.CogSeedDesignSystem_f581b5;
  const AUTOMATION_TEMPLATES = [
    {
      "id": "tech_news",
      "icon": "fileText",
      "title": "\u79D1\u6280\u65E9\u62A5",
      "description": "\u65E9\u6668\u6C47\u603B\u79D1\u6280\u3001AI \u548C\u4EA7\u54C1\u52A8\u6001\uFF0C\u7B5B\u51FA\u9002\u5408\u529E\u516C\u4EBA\u7FA4\u5FEB\u901F\u6D4F\u89C8\u7684\u91CD\u70B9\u3002",
      "message": "\u6C47\u603B\u8FC7\u53BB 24 \u5C0F\u65F6\u79D1\u6280\u3001AI \u548C\u4EA7\u54C1\u9886\u57DF\u7684\u91CD\u8981\u52A8\u6001\uFF0C\u6309\u4E3B\u9898\u5206\u7EC4\uFF0C\u6BCF\u6761\u9644\u4E00\u53E5\u8981\u70B9\u548C\u6765\u6E90\uFF0C\u8F93\u51FA\u9002\u5408\u5FEB\u901F\u6D4F\u89C8\u7684\u7B80\u62A5\u3002",
      "schedule": {
        "type": "daily",
        "hour": 8,
        "minute": 30,
        "weekday": 5,
        "day": 25
      }
    },
    {
      "id": "daily_wrapup",
      "icon": "file",
      "title": "\u6BCF\u65E5\u5DE5\u4F5C\u6536\u5C3E",
      "description": "\u4E0B\u73ED\u524D\u6574\u7406\u5F53\u5929\u8FDB\u5C55\u3001\u98CE\u9669\u548C\u660E\u65E5\u5F85\u529E\uFF0C\u9002\u5408\u4E2A\u4EBA\u590D\u76D8\u6216\u56E2\u961F\u540C\u6B65\u3002",
      "message": "\u5E2E\u6211\u6574\u7406\u4ECA\u5929\u7684\u5DE5\u4F5C\u6536\u5C3E\uFF1A\u5217\u51FA\u4ECA\u65E5\u4E3B\u8981\u8FDB\u5C55\u3001\u9047\u5230\u7684\u98CE\u9669\u6216\u963B\u585E\u3001\u4EE5\u53CA\u660E\u5929\u9700\u8981\u4F18\u5148\u5904\u7406\u7684\u5F85\u529E\u4E8B\u9879\u3002",
      "schedule": {
        "type": "daily",
        "hour": 18,
        "minute": 0,
        "weekday": 5,
        "day": 25
      }
    },
    {
      "id": "meeting_prep",
      "icon": "calendar",
      "title": "\u4F1A\u8BAE\u51C6\u5907",
      "description": "\u6BCF\u5929\u5F00\u59CB\u524D\u68B3\u7406\u4F1A\u8BAE\u76EE\u6807\u3001\u5F85\u786E\u8BA4\u95EE\u9898\u548C\u9700\u8981\u63D0\u524D\u51C6\u5907\u7684\u6750\u6599\u3002",
      "message": "\u5E2E\u6211\u51C6\u5907\u4ECA\u5929\u7684\u4F1A\u8BAE\uFF1A\u68B3\u7406\u4F1A\u8BAE\u76EE\u6807\u3001\u9700\u8981\u786E\u8BA4\u7684\u5173\u952E\u95EE\u9898\u6E05\u5355\uFF0C\u4EE5\u53CA\u5E94\u63D0\u524D\u51C6\u5907\u7684\u6750\u6599\u548C\u6570\u636E\u3002",
      "schedule": {
        "type": "daily",
        "hour": 8,
        "minute": 45,
        "weekday": 5,
        "day": 25
      }
    },
    {
      "id": "weekly_report",
      "icon": "file",
      "title": "\u5468\u62A5\u8349\u7A3F",
      "description": "\u6BCF\u5468\u4E94\u751F\u6210\u4E00\u4EFD\u7ED3\u6784\u5316\u5468\u62A5\u8349\u7A3F\uFF0C\u51CF\u5C11\u4E34\u4E0B\u73ED\u8865\u6750\u6599\u7684\u6210\u672C\u3002",
      "message": "\u5E2E\u6211\u751F\u6210\u672C\u5468\u5468\u62A5\u8349\u7A3F\uFF0C\u6309\u300C\u672C\u5468\u5B8C\u6210\u300D\u300C\u8FDB\u884C\u4E2D\u300D\u300C\u4E0B\u5468\u8BA1\u5212\u300D\u300C\u98CE\u9669\u4E0E\u9700\u8981\u652F\u6301\u300D\u56DB\u90E8\u5206\u7EC4\u7EC7\uFF0C\u4FDD\u6301\u7B80\u6D01\u7684\u8981\u70B9\u5F0F\u8868\u8FBE\u3002",
      "schedule": {
        "type": "weekly",
        "hour": 17,
        "minute": 30,
        "weekday": 5,
        "day": 25
      }
    },
    {
      "id": "project_health",
      "icon": "automation",
      "title": "\u9879\u76EE\u5065\u5EB7\u5DE1\u68C0",
      "description": "\u5B9A\u671F\u68C0\u67E5\u9879\u76EE\u72B6\u6001\u3001\u8FD1\u671F\u53D8\u66F4\u548C\u6F5C\u5728\u98CE\u9669\uFF0C\u9002\u5408\u7814\u53D1\u6216\u8FD0\u8425\u9879\u76EE\u3002",
      "message": "\u5BF9\u5F53\u524D\u9879\u76EE\u505A\u4E00\u6B21\u5065\u5EB7\u5DE1\u68C0\uFF1A\u6982\u8FF0\u6574\u4F53\u72B6\u6001\u3001\u8FD1\u671F\u5173\u952E\u53D8\u66F4\u3001\u6F5C\u5728\u98CE\u9669\u70B9\uFF0C\u5E76\u7ED9\u51FA\u5EFA\u8BAE\u7684\u5904\u7406\u4F18\u5148\u7EA7\u3002",
      "schedule": {
        "type": "daily",
        "hour": 10,
        "minute": 0,
        "weekday": 5,
        "day": 25
      }
    },
    {
      "id": "monthly_admin",
      "icon": "calendar",
      "title": "\u6708\u5EA6\u884C\u653F\u63D0\u9192",
      "description": "\u6708\u5E95\u524D\u63D0\u9192\u6574\u7406\u53D1\u7968\u3001\u62A5\u9500\u3001\u7EED\u8D39\u3001\u5408\u540C\u548C\u5E38\u89C4\u884C\u653F\u5F85\u529E\u3002",
      "message": "\u5E2E\u6211\u68B3\u7406\u672C\u6708\u7684\u884C\u653F\u5F85\u529E\u6E05\u5355\uFF1A\u53D1\u7968\u3001\u62A5\u9500\u3001\u8BA2\u9605\u7EED\u8D39\u3001\u5408\u540C\u5230\u671F\u7B49\u9700\u8981\u5728\u6708\u5E95\u524D\u5904\u7406\u7684\u4E8B\u9879\uFF0C\u5E76\u6309\u7D27\u6025\u7A0B\u5EA6\u6392\u5E8F\u3002",
      "schedule": {
        "type": "monthly",
        "hour": 10,
        "minute": 0,
        "weekday": 5,
        "day": 25
      }
    }
  ];
  const AUTOMATION_REFERENCES = [
    { id: "cogseed", kind: "agent", name: "cogseed", description: "\u9ED8\u8BA4\u667A\u80FD\u4F53" },
    { id: "research", kind: "skill", name: "\u6DF1\u5EA6\u7814\u7A76", description: "\u67E5\u627E\u5E76\u6574\u7406\u4E3B\u9898\u8D44\u6599" },
    { id: "calendar", kind: "connector", name: "\u65E5\u5386", description: "\u4F1A\u8BAE\u4E0E\u65E5\u7A0B" },
    { id: "report", kind: "library", name: "\u5468\u62A5\u6A21\u677F.md", description: "\u8D44\u6599\u5E93\u6587\u4EF6" }
  ];
  const INITIAL_AUTOMATIONS = [{ id: "tech-news", title: "\u79D1\u6280\u65E9\u62A5", message: AUTOMATION_TEMPLATES[0].message, enabled: false, schedule: { ...Schedule.defaults(), ...AUTOMATION_TEMPLATES[0].schedule }, mentions: [AUTOMATION_REFERENCES[0]], attachments: [], device: "\u672C\u673A", runs: [] }];
  function newAutomationDraft(template) {
    return { title: template?.title || "", message: template?.message || "", enabled: true, schedule: { ...Schedule.defaults(), ...template?.schedule }, mentions: [{ ...AUTOMATION_REFERENCES[0] }], attachments: [], runs: [] };
  }
  function AutomationEditor({ initial, onCancel, onSave }) {
    const [draft, setDraft] = React.useState(() => initial ? { ...initial, schedule: { ...initial.schedule }, mentions: initial.mentions.map((item) => ({ ...item })), attachments: initial.attachments.map((item) => ({ ...item })) } : newAutomationDraft());
    const [error, setError] = React.useState("");
    const fileInput = React.useRef(null);
    const update = (patch) => {
      setDraft((d) => ({ ...d, ...patch }));
      setError("");
    };
    const updateSchedule = (patch) => {
      setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }));
      setError("");
    };
    const save = () => {
      const invalid = !draft.message.trim() ? "\u8BF7\u586B\u5199\u4EFB\u52A1\u5185\u5BB9" : Schedule.validate(draft.schedule);
      if (invalid) {
        setError(invalid);
        return;
      }
      onSave(Schedule.makeTask(draft, draft.id || `automation-${Date.now()}`));
    };
    return /* @__PURE__ */ React.createElement(Dialog, { title: draft.id ? "\u7F16\u8F91\u81EA\u52A8\u5316\u4EFB\u52A1" : "\u65B0\u5EFA\u81EA\u52A8\u5316\u4EFB\u52A1", width: 640, cancelLabel: "\u53D6\u6D88", confirmLabel: draft.id ? "\u4FDD\u5B58" : "\u521B\u5EFA", onCancel, onConfirm: save, initialFocus: "first", showClose: true }, /* @__PURE__ */ React.createElement("div", { className: "cs-automation-form" }, /* @__PURE__ */ React.createElement("div", { className: "cs-automation-content-field" }, /* @__PURE__ */ React.createElement("div", { className: "cs-automation-field-label", id: "automation-content-label" }, "\u4EFB\u52A1\u5185\u5BB9 ", /* @__PURE__ */ React.createElement("span", null, "\u5FC5\u586B")), /* @__PURE__ */ React.createElement(Composer, { placement: "automation", value: draft.message, onChange: (message) => update({ message }), placeholder: "\u8F93\u5165 @ \u9009\u62E9\u667A\u80FD\u4F53\u3001\u6280\u80FD\u3001\u8FDE\u63A5\u5668\u6216\u8D44\u6599\u5E93\u6587\u4EF6", mentionItems: AUTOMATION_REFERENCES, selectedMentions: draft.mentions, onMentionsChange: (mentions) => update({ mentions }), onAttach: () => fileInput.current?.click(), width: "100%" }), /* @__PURE__ */ React.createElement("input", { ref: fileInput, type: "file", multiple: true, hidden: true, onChange: (event) => {
      const selected = Array.from(event.target.files || []).map((file) => ({ name: file.name, size: file.size, type: file.type }));
      update({ attachments: [...draft.attachments, ...selected] });
      event.target.value = "";
    } }), draft.attachments.length > 0 && /* @__PURE__ */ React.createElement("ul", { className: "cs-automation-attachments" }, draft.attachments.map((file, index) => /* @__PURE__ */ React.createElement("li", { key: `${file.name}-${index}` }, /* @__PURE__ */ React.createElement(Icon, { name: "file", size: 14 }), /* @__PURE__ */ React.createElement("span", null, file.name), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", "aria-label": `\u79FB\u9664\u9644\u4EF6 ${file.name}`, onClick: () => update({ attachments: draft.attachments.filter((_, i) => i !== index) }) }, "\u79FB\u9664"))))), /* @__PURE__ */ React.createElement("div", { className: "cs-automation-schedule-row" }, /* @__PURE__ */ React.createElement(Field, { label: "\u9891\u7387" }, /* @__PURE__ */ React.createElement(Select, { options: Object.values(Schedule.frequencies), value: Schedule.frequencies[draft.schedule.type], onChange: (label) => updateSchedule({ type: Object.keys(Schedule.frequencies).find((key) => Schedule.frequencies[key] === label) }) })), draft.schedule.type === "one_time" && /* @__PURE__ */ React.createElement(Field, { label: "\u65E5\u671F" }, /* @__PURE__ */ React.createElement(Input, { type: "date", value: draft.schedule.date, onChange: (event) => updateSchedule({ date: event.target.value }) })), draft.schedule.type === "weekly" && /* @__PURE__ */ React.createElement(Field, { label: "\u661F\u671F" }, /* @__PURE__ */ React.createElement(Select, { options: Schedule.weekdays, value: Schedule.weekdays[draft.schedule.weekday], onChange: (label) => updateSchedule({ weekday: Schedule.weekdays.indexOf(label) }) })), draft.schedule.type === "monthly" && /* @__PURE__ */ React.createElement(Field, { label: "\u6BCF\u6708\u65E5\u671F" }, /* @__PURE__ */ React.createElement(Select, { options: [...Array.from({ length: 30 }, (_, i) => `${i + 1} \u65E5`), "\u6708\u5E95"], value: draft.schedule.day === 31 ? "\u6708\u5E95" : `${draft.schedule.day} \u65E5`, onChange: (label) => updateSchedule({ day: label === "\u6708\u5E95" ? 31 : parseInt(label, 10) }) })), /* @__PURE__ */ React.createElement("div", { className: "cs-automation-time" }, /* @__PURE__ */ React.createElement(Field, { label: "\u5C0F\u65F6" }, /* @__PURE__ */ React.createElement(Select, { options: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")), value: String(draft.schedule.hour).padStart(2, "0"), onChange: (value) => updateSchedule({ hour: Number(value) }) })), /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true" }, ":"), /* @__PURE__ */ React.createElement(Field, { label: "\u5206\u949F" }, /* @__PURE__ */ React.createElement(Select, { options: Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")), value: String(draft.schedule.minute).padStart(2, "0"), onChange: (value) => updateSchedule({ minute: Number(value) }) })))), /* @__PURE__ */ React.createElement(Field, { label: "\u6807\u9898\uFF08\u53EF\u9009\uFF09" }, /* @__PURE__ */ React.createElement(Input, { placeholder: "\u7559\u7A7A\u5219\u7528\u4EFB\u52A1\u5185\u5BB9\u9996\u884C", value: draft.title, onChange: (event) => update({ title: event.target.value }) })), /* @__PURE__ */ React.createElement(Checkbox, { label: "\u542F\u7528", checked: draft.enabled, onChange: (enabled) => update({ enabled }) }), error && /* @__PURE__ */ React.createElement("p", { className: "cs-automation-error", role: "alert" }, error)));
  }
  function AutomationScreen({ collapsed, onExpand, onOpenTask, initialItems = INITIAL_AUTOMATIONS }) {
    const [items, setItems] = React.useState(initialItems), [editor, setEditor] = React.useState(null), [deleting, setDeleting] = React.useState(null), [expanded, setExpanded] = React.useState(/* @__PURE__ */ new Set()), [notice, setNotice] = React.useState("");
    const toggleHistory = (id) => setExpanded((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    const toggleEnabled = (task) => {
      setItems((list) => list.map((item) => item.id === task.id ? { ...item, enabled: !item.enabled } : item));
      setNotice(`${task.title}\u5DF2${task.enabled ? "\u505C\u7528" : "\u542F\u7528"}`);
    };
    const save = (task) => {
      setItems((list) => list.some((item) => item.id === task.id) ? list.map((item) => item.id === task.id ? task : item) : [task, ...list]);
      setEditor(null);
      setNotice(task.id === editor?.id ? "\u81EA\u52A8\u5316\u4EFB\u52A1\u5DF2\u4FDD\u5B58" : "\u81EA\u52A8\u5316\u4EFB\u52A1\u5DF2\u521B\u5EFA");
    };
    return /* @__PURE__ */ React.createElement(PageFrame, null, /* @__PURE__ */ React.createElement(PageHeader, { title: "\u81EA\u52A8\u5316", collapsed, onExpand, actions: /* @__PURE__ */ React.createElement(Button, { icon: /* @__PURE__ */ React.createElement(Icon, { name: "plus" }), onClick: () => setEditor(newAutomationDraft()) }, "\u65B0\u5EFA\u81EA\u52A8\u5316\u4EFB\u52A1") }), /* @__PURE__ */ React.createElement(PageScroll, { className: "cs-resource-page-scroll" }, /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-content cs-automation-page" }, notice && /* @__PURE__ */ React.createElement("p", { className: "cs-resource-page-notice", role: "status" }, notice), /* @__PURE__ */ React.createElement("div", { className: "cs-automation-list" }, items.length ? items.map((task) => /* @__PURE__ */ React.createElement(ResourceCard, { key: task.id, variant: "automation", layout: "row", icon: "automation", title: task.message, description: task.title, status: /* @__PURE__ */ React.createElement(StatusDot, { tone: task.enabled ? "success" : "idle", label: task.enabled ? "\u5DF2\u542F\u7528" : "\u5DF2\u505C\u7528" }), automation: { schedule: Schedule.format(task.schedule), lastRun: task.runs[0]?.time || "\u5C1A\u672A\u8FD0\u884C", device: task.device, runCount: task.runs.length, expanded: expanded.has(task.id) }, onToggleRuns: () => toggleHistory(task.id), menu: { groups: [{ items: [{ label: task.enabled ? "\u505C\u7528" : "\u542F\u7528", onSelect: () => toggleEnabled(task) }, { label: "\u7F16\u8F91", onSelect: () => setEditor(task) }] }, { danger: true, items: [{ label: "\u5220\u9664", onSelect: () => setDeleting(task) }] }] } }, (task.mentions.length > 0 || task.attachments.length > 0) && /* @__PURE__ */ React.createElement("div", { className: "cs-automation-row-references" }, task.mentions.map((item) => /* @__PURE__ */ React.createElement("span", { key: `${item.kind}-${item.id}` }, "@", item.name)), task.attachments.length > 0 && /* @__PURE__ */ React.createElement("span", null, task.attachments.length, " \u4E2A\u9644\u4EF6")), expanded.has(task.id) && /* @__PURE__ */ React.createElement("div", { className: "cs-automation-history" }, task.runs.length ? task.runs.map((run) => /* @__PURE__ */ React.createElement("div", { className: "cs-automation-run", key: run.id }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => onOpenTask?.({ title: run.title, taskId: run.id }) }, run.title), /* @__PURE__ */ React.createElement("span", null, run.time))) : /* @__PURE__ */ React.createElement("p", null, "\u6682\u65E0\u4EFB\u52A1")))) : /* @__PURE__ */ React.createElement(EmptyState, { title: "\u6682\u65E0\u81EA\u52A8\u5316\u4EFB\u52A1", reason: "\u521B\u5EFA\u81EA\u52A8\u5316\u4EFB\u52A1\uFF0C\u6216\u4ECE\u4E0B\u65B9\u6A21\u677F\u5F00\u59CB\u3002", action: "\u65B0\u5EFA\u81EA\u52A8\u5316\u4EFB\u52A1", onAction: () => setEditor(newAutomationDraft()) })), /* @__PURE__ */ React.createElement("section", { className: "cs-resource-page-section" }, /* @__PURE__ */ React.createElement(GroupHeading, { label: "\u4ECE\u6A21\u677F\u5FEB\u901F\u6DFB\u52A0" }), /* @__PURE__ */ React.createElement(CardGrid, null, AUTOMATION_TEMPLATES.map((template) => /* @__PURE__ */ React.createElement(ResourceCard, { key: template.id, variant: "template", icon: template.icon, title: template.title, description: template.description, status: /* @__PURE__ */ React.createElement("span", null, Schedule.format(template.schedule)), action: "\u4F7F\u7528\u6A21\u677F", onAction: () => setEditor(newAutomationDraft(template)) })), /* @__PURE__ */ React.createElement(ResourceCard, { variant: "template", icon: "plus", title: "\u4ECE\u7A7A\u767D\u521B\u5EFA", description: "\u81EA\u5B9A\u4E49\u4EFB\u52A1\u6307\u4EE4\u4E0E\u6267\u884C\u8BA1\u5212\u3002", action: "\u521B\u5EFA\u4EFB\u52A1", onAction: () => setEditor(newAutomationDraft()) }))))), editor && /* @__PURE__ */ React.createElement(AutomationEditor, { initial: editor, onCancel: () => setEditor(null), onSave: save }), deleting && /* @__PURE__ */ React.createElement(Dialog, { title: "\u5220\u9664\u81EA\u52A8\u5316\u4EFB\u52A1", description: "\u786E\u8BA4\u5220\u9664\u8FD9\u6761\u81EA\u52A8\u5316\u4EFB\u52A1\uFF1F", confirmLabel: "\u5220\u9664", danger: true, onCancel: () => setDeleting(null), onConfirm: () => {
      setItems((list) => list.filter((item) => item.id !== deleting.id));
      setExpanded((previous) => {
        const next = new Set(previous);
        next.delete(deleting.id);
        return next;
      });
      setNotice("\u81EA\u52A8\u5316\u4EFB\u52A1\u5DF2\u5220\u9664");
      setDeleting(null);
    } }));
  }
  window.AutomationScreen = AutomationScreen;
})();
