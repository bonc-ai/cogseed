/* Generated from ui_kits/enterprise-app/SettingsPanels.jsx by tools/build.cjs. */
(() => {
  const { InlineConfirm, SettingsSection, Button, Input, Select, Switch, RadioCard, Checkbox, DataTable } = window.CogSeedDesignSystem_f581b5;
  function SettingsChoice({ label, options, value, onChange }) {
    return /* @__PURE__ */ React.createElement("div", { className: "cs-settings-choice", role: "group", "aria-label": label }, /* @__PURE__ */ React.createElement(Select, { size: "md", "aria-label": label, options, value, onChange }));
  }
  function SettingsActions({ children }) {
    return /* @__PURE__ */ React.createElement("div", { className: "cs-settings-actions" }, children);
  }
  function SettingsFeedback({ children }) {
    return /* @__PURE__ */ React.createElement("div", { className: "cs-settings-notice", role: "status", "aria-live": "polite" }, children);
  }
  function SettingsConfirm({ title, confirmLabel = "\u5220\u9664\u914D\u7F6E", onCancel, onConfirm }) {
    return /* @__PURE__ */ React.createElement(InlineConfirm, { title, confirmLabel, onCancel, onConfirm });
  }
  function SettingsGeneral() {
    const [prefs, setPrefs] = React.useState({ language: "\u7B80\u4F53\u4E2D\u6587", thinking: "\u81EA\u52A8", notifications: true, access: "\u5E38\u89C4", evolution: false });
    const [notice, setNotice] = React.useState("");
    const update = (key, value) => {
      setPrefs((p) => ({ ...p, [key]: value }));
      setNotice("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\u3002");
    };
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u8BED\u8A00\u4E0E\u63A8\u7406" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u8BED\u8A00 / Language" }, /* @__PURE__ */ React.createElement(SettingsChoice, { label: "\u8BED\u8A00", value: prefs.language, options: ["\u7B80\u4F53\u4E2D\u6587", "English", "\u65E5\u672C\u8A9E", "Portugu\xEAs"], onChange: (v) => {
      update("language", v);
      setNotice("\u8BED\u8A00\u504F\u597D\u5DF2\u4FDD\u5B58\u3002");
    } })), /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u9ED8\u8BA4\u63A8\u7406\u5F3A\u5EA6", help: "\u4EFB\u52A1\u5185\u53EF\u4E34\u65F6\u8C03\u6574\uFF0C\u4EC5\u5F71\u54CD\u5F53\u524D\u4EFB\u52A1\u3002" }, /* @__PURE__ */ React.createElement(SettingsChoice, { label: "\u9ED8\u8BA4\u63A8\u7406\u5F3A\u5EA6", value: prefs.thinking, options: ["\u81EA\u52A8", "\u5173\u95ED", "\u4F4E", "\u9AD8"], onChange: (v) => update("thinking", v) }))), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u4EFB\u52A1\u901A\u77E5" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u542F\u7528\u4EFB\u52A1\u901A\u77E5", help: "\u5E94\u7528\u4E0D\u5728\u524D\u53F0\u65F6\uFF0C\u901A\u77E5\u4EFB\u52A1\u5B8C\u6210\u3001\u5931\u8D25\u6216\u9700\u8981\u8F93\u5165\u3002" }, /* @__PURE__ */ React.createElement(Switch, { "aria-label": "\u542F\u7528\u4EFB\u52A1\u901A\u77E5", checked: prefs.notifications, onChange: (v) => update("notifications", v) })), /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u7CFB\u7EDF\u901A\u77E5\u6743\u9650" }, /* @__PURE__ */ React.createElement(Button, { onClick: () => setNotice("\u8BF7\u5728\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u7BA1\u7406\u901A\u77E5\u6743\u9650\u3002") }, "\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E"))), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u5DE5\u5177\u6267\u884C\u6743\u9650" }, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-options" }, [["\u8C28\u614E", "\u4EC5\u8BBF\u95EE\u5DE5\u4F5C\u533A\u6587\u4EF6\uFF0C\u654F\u611F\u64CD\u4F5C\u9700\u786E\u8BA4"], ["\u5E38\u89C4", "\u53EF\u8BBF\u95EE\u5DE5\u4F5C\u533A\u5916\u6587\u4EF6\uFF0C\u654F\u611F\u64CD\u4F5C\u9700\u786E\u8BA4"], ["\u4FE1\u4EFB", "\u53EF\u8BBF\u95EE\u5DE5\u4F5C\u533A\u5916\u6587\u4EF6\uFF0C\u654F\u611F\u64CD\u4F5C\u65E0\u9700\u786E\u8BA4"]].map(([title, help]) => /* @__PURE__ */ React.createElement(RadioCard, { name: "tool-access", value: title, key: title, title, help, checked: prefs.access === title, onChange: () => update("access", title) })))), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u5143\u8BA4\u77E5\u7EA7\u667A\u80FD\u4F53\u81EA\u8FDB\u5316" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u542F\u7528\u81EA\u8FDB\u5316", help: "\u667A\u80FD\u4F53\u5B9A\u671F\u56DE\u987E\u8FD1\u671F\u8868\u73B0\uFF0C\u63D0\u70BC\u7ECF\u9A8C\u5E76\u8C03\u6574\u5DE5\u4F5C\u65B9\u5F0F\u3002" }, /* @__PURE__ */ React.createElement(Switch, { "aria-label": "\u542F\u7528\u81EA\u8FDB\u5316", checked: prefs.evolution, onChange: (v) => update("evolution", v) }))), /* @__PURE__ */ React.createElement(SettingsFeedback, null, notice));
  }
  function SettingsUsage() {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u4F53\u9A8C\u989D\u5EA6 / \u8FD0\u884C\u989D\u5EA6" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u6682\u65E0\u989D\u5EA6\u6570\u636E" }, /* @__PURE__ */ React.createElement("span", { className: "cs-settings-muted" }, "\u6682\u65E0\u6570\u636E"))));
  }
  function SettingsAccount() {
    const [signed, setSigned] = React.useState(true), [devices, setDevices] = React.useState(["\u5F53\u524D Mac", "Windows \u8BBE\u5907"]);
    const [confirm, setConfirm] = React.useState(null), [step, setStep] = React.useState(0), [code, setCode] = React.useState(""), [sent, setSent] = React.useState(false), [phrase, setPhrase] = React.useState(""), [checks, setChecks] = React.useState([false, false, false]), [notice, setNotice] = React.useState("");
    if (step) return /* @__PURE__ */ React.createElement("div", { className: "cs-settings-editor" }, /* @__PURE__ */ React.createElement("h2", null, "\u6CE8\u9500\u8D26\u53F7 \xB7 ", step, " / 3"), step === 1 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, "\u8D26\u53F7\u4F1A\u8BDD\u3001\u8BBE\u5907\u8BBF\u95EE\u548C\u8054\u7F51\u6743\u76CA\u5C06\u505C\u6B62\uFF0C\u672C\u673A\u6570\u636E\u4FDD\u7559\u3002")) : null, step === 2 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, "\u9A8C\u8BC1\u8D26\u53F7\u8EAB\u4EFD"), /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u9A8C\u8BC1\u7801", placeholder: "\u586B\u5199 6 \u4F4D\u9A8C\u8BC1\u7801", value: code, onChange: (e) => setCode(e.target.value) }), /* @__PURE__ */ React.createElement(Button, { onClick: () => {
      setSent(true);
      setNotice("\u9A8C\u8BC1\u7801\u5DF2\u53D1\u9001\u3002");
    } }, sent ? "\u91CD\u65B0\u83B7\u53D6\u9A8C\u8BC1\u7801" : "\u83B7\u53D6\u9A8C\u8BC1\u7801"))) : null, step === 3 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-options" }, ["\u6211\u77E5\u9053\u8D26\u53F7\u4F1A\u8BDD\u3001\u8BBE\u5907\u8BBF\u95EE\u548C\u8054\u7F51\u6743\u76CA\u4F1A\u505C\u6B62\u3002", "\u6211\u77E5\u9053\u53CD\u6094\u671F\u5185\u91CD\u65B0\u767B\u5F55\u9700\u5148\u9009\u62E9\u6062\u590D\u8D26\u53F7\u6216\u653E\u5F03\u767B\u5F55\u3002", "\u6211\u77E5\u9053\u672C\u673A\u6570\u636E\u4E0D\u4F1A\u968F\u4E91\u7AEF\u8D26\u53F7\u6CE8\u9500\u800C\u5220\u9664\u3002"].map((label, i) => /* @__PURE__ */ React.createElement(Checkbox, { key: label, label, checked: checks[i], onChange: (v) => setChecks((old) => old.map((x, j) => i === j ? v : x)) }))), /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u6CE8\u9500\u786E\u8BA4\u77ED\u8BED", placeholder: "\u8F93\u5165 DELETE_MY_ACCOUNT \u786E\u8BA4", value: phrase, onChange: (e) => setPhrase(e.target.value) })) : null, /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: () => {
      setStep(0);
      setNotice("");
    } }, "\u53D6\u6D88\u6CE8\u9500"), step > 1 ? /* @__PURE__ */ React.createElement(Button, { onClick: () => setStep((s) => s - 1) }, "\u4E0A\u4E00\u6B65") : null, /* @__PURE__ */ React.createElement(Button, { variant: step === 3 ? "danger" : "primary", disabled: step === 2 ? !sent || code !== "123456" : step === 3 ? !checks.every(Boolean) || phrase !== "DELETE_MY_ACCOUNT" : false, onClick: () => {
      if (step < 3) setStep((s) => s + 1);
      else {
        setStep(0);
        setSigned(false);
        setNotice("\u6CE8\u9500\u7533\u8BF7\u5DF2\u63D0\u4EA4\u3002");
      }
    } }, step === 3 ? "\u63D0\u4EA4\u6CE8\u9500" : "\u7EE7\u7EED")), /* @__PURE__ */ React.createElement(SettingsFeedback, null, notice));
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SettingsSection, { title: signed ? "\u5DF2\u767B\u5F55" : "\u672A\u767B\u5F55" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: signed ? "\u5F20\u660E" : "\u672C\u5730\u6A21\u5F0F", help: signed ? "\u8D26\u53F7 zhangming \xB7 \u624B\u673A\u53F7\u672A\u7ED1\u5B9A" : "\u672C\u673A\u5185\u5BB9\u4FDD\u7559\uFF0C\u767B\u5F55\u540E\u7BA1\u7406\u8BBE\u5907\u3002" }, /* @__PURE__ */ React.createElement(Button, { onClick: () => {
      if (signed) document.getElementById("preview-account-devices")?.scrollIntoView({ behavior: "smooth", block: "start" });
      else {
        setSigned(true);
        setNotice("\u5DF2\u767B\u5F55\u3002");
      }
    } }, signed ? "\u7BA1\u7406\u8D26\u53F7" : "\u767B\u5F55\u8D26\u53F7"))), signed ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { id: "preview-account-devices" }), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u767B\u5F55\u8BBE\u5907" }, devices.map((name, i) => /* @__PURE__ */ React.createElement(SettingsRow, { key: name, title: name, help: "\u6700\u8FD1\u6D3B\u8DC3" }, /* @__PURE__ */ React.createElement("span", { className: "cs-settings-muted" }, i === 0 ? "\u5F53\u524D\u8BBE\u5907" : null), i !== 0 ? /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setConfirm({ title: `\u64A4\u9500\u300C${name}\u300D\u7684\u8BBF\u95EE\u6743\u9650\uFF1F`, label: "\u64A4\u9500\u8BBF\u95EE", action: () => setDevices((d) => d.filter((n) => n !== name)) }) }, "\u64A4\u9500\u8BBF\u95EE") : null))), /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: () => setConfirm({ title: "\u9000\u51FA\u5F53\u524D\u8D26\u53F7\uFF1F\u672C\u5730\u5185\u5BB9\u5C06\u4FDD\u7559\u3002", label: "\u9000\u51FA\u767B\u5F55", action: () => setSigned(false) }) }, "\u9000\u51FA\u767B\u5F55"), /* @__PURE__ */ React.createElement(Button, { variant: "danger", onClick: () => {
      setStep(1);
      setCode("");
      setSent(false);
      setPhrase("");
      setChecks([false, false, false]);
      setNotice("");
    } }, "\u6CE8\u9500\u8D26\u53F7"))) : null, confirm ? /* @__PURE__ */ React.createElement(SettingsConfirm, { title: confirm.title, confirmLabel: confirm.label, onCancel: () => setConfirm(null), onConfirm: () => {
      confirm.action();
      setConfirm(null);
      setNotice("\u64CD\u4F5C\u5DF2\u5B8C\u6210\u3002");
    } }) : null, /* @__PURE__ */ React.createElement(SettingsFeedback, null, notice));
  }
  function SettingsSecurity() {
    const [rows, setRows] = React.useState([{ id: "finance-check", name: "\u9879\u76EE\u62A5\u544A\u53E3\u5F84\u6838\u9A8C", decision: "\u901A\u8FC7", score: 96, time: "2026-09-05 09:30" }, { id: "material-check", name: "\u8C03\u7814\u6750\u6599\u6E05\u5355", decision: "\u6709\u63D0\u793A", score: 78, time: "2026-09-05 09:30" }]);
    const [query, setQuery] = React.useState(""), [picker, setPicker] = React.useState(false), [all, setAll] = React.useState(false), [notice, setNotice] = React.useState(""), [busy, setBusy] = React.useState("");
    const timer = React.useRef(null);
    React.useEffect(() => () => clearTimeout(timer.current), []);
    const recheck = (id) => {
      setBusy(id);
      setNotice("\u6B63\u5728\u68C0\u67E5\u2026");
      timer.current = setTimeout(() => {
        setRows((old) => old.map((r) => r.id === id ? { ...r, time: "\u521A\u521A" } : r));
        setBusy("");
        setNotice("\u68C0\u67E5\u5DF2\u5B8C\u6210\u3002");
      }, 600);
    };
    const exportRows = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ preview: true, receipts: rows }, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "preview-security-receipts.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
      setNotice("\u68C0\u67E5\u56DE\u6267\u5DF2\u5BFC\u51FA\u3002");
    };
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u7CFB\u7EDF\u4FDD\u62A4" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u7CFB\u7EDF\u4FDD\u62A4\u5DF2\u5F00\u542F" }, /* @__PURE__ */ React.createElement("span", { className: "cs-settings-muted" }, "\u5DF2\u5F00\u542F")), [["\u5B89\u5168\u626B\u63CF\u5668", "\u53EF\u7528 \xB7 \u5B8C\u6574\u6027\u5DF2\u6821\u9A8C"], ["\u6DF1\u626B\u5F15\u64CE", "\u89C4\u5219\u5305\u5DF2\u6821\u9A8C"], ["\u5B8C\u6574\u6027\u6821\u9A8C\u5F15\u64CE", "\u5DF2\u6821\u9A8C"]].map(([title, help]) => /* @__PURE__ */ React.createElement(SettingsRow, { key: title, title, help }, /* @__PURE__ */ React.createElement("span", { className: "cs-settings-muted" }, "\u53EA\u8BFB")))), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u6700\u8FD1\u68C0\u67E5\u8BB0\u5F55" }, /* @__PURE__ */ React.createElement("p", { className: "cs-settings-muted" }, "\u5B89\u5168\u901A\u8FC7\u4E0D\u4EE3\u8868\u5DF2\u9A8C\u8BC1\u6709\u6548\u3002"), /* @__PURE__ */ React.createElement("div", { className: "cs-settings-table" }, /* @__PURE__ */ React.createElement(DataTable, { columns: [{ key: "name", label: "\u6280\u80FD", width: "1.4fr" }, { key: "decision", label: "\u7ED3\u8BBA" }, { key: "score", label: "\u8BC4\u5206", width: ".6fr" }, { key: "time", label: "\u68C0\u67E5\u65F6\u95F4" }, { key: "action", label: "\u64CD\u4F5C" }], rows: (all ? rows : rows.slice(0, 10)).map((r) => ({ ...r, action: /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", disabled: !!busy, onClick: () => recheck(r.id) }, busy === r.id ? "\u68C0\u67E5\u4E2D\u2026" : "\u91CD\u65B0\u68C0\u67E5") })) })), rows.length > 10 ? /* @__PURE__ */ React.createElement(Button, { onClick: () => setAll((v) => !v) }, all ? "\u67E5\u770B\u6700\u8FD1" : "\u67E5\u770B\u5168\u90E8") : null), /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: exportRows }, "\u5BFC\u51FA\u68C0\u67E5\u56DE\u6267\uFF08\u8131\u654F\uFF09"), /* @__PURE__ */ React.createElement(Button, { onClick: () => setPicker((v) => !v) }, picker ? "\u6536\u8D77\u6280\u80FD\u68C0\u67E5" : "\u68C0\u67E5\u5355\u4E2A\u6280\u80FD"), /* @__PURE__ */ React.createElement(Button, { disabled: !!busy, onClick: () => {
      setNotice("\u72B6\u6001\u5DF2\u5237\u65B0\u3002");
    } }, "\u5237\u65B0")), picker ? /* @__PURE__ */ React.createElement("div", { className: "cs-settings-editor" }, /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u641C\u7D22\u5DF2\u5B89\u88C5\u6280\u80FD", placeholder: "\u641C\u7D22\u5DF2\u5B89\u88C5\u6280\u80FD", value: query, onChange: (e) => setQuery(e.target.value) }), rows.filter((r) => `${r.name} ${r.id}`.includes(query.trim())).map((r) => /* @__PURE__ */ React.createElement(SettingsRow, { key: r.id, title: r.name, help: r.id }, /* @__PURE__ */ React.createElement(Button, { disabled: !!busy, onClick: () => recheck(r.id) }, "\u68C0\u67E5"))), !rows.some((r) => `${r.name} ${r.id}`.includes(query.trim())) ? /* @__PURE__ */ React.createElement("p", { className: "cs-settings-muted" }, "\u6CA1\u6709\u5339\u914D\u7684\u6280\u80FD") : null) : null, /* @__PURE__ */ React.createElement(SettingsFeedback, null, notice), /* @__PURE__ */ React.createElement("p", { className: "cs-settings-muted" }, "\u6280\u80FD\u5B89\u88C5\u3001\u5BFC\u5165\u4E0E\u751F\u6210\u90FD\u4F1A\u7ECF\u8FC7\u5B89\u5168\u68C0\u67E5\uFF1B\u68C0\u67E5\u4E0D\u53EF\u7528\u65F6\uFF0C\u65B0\u5185\u5BB9\u4E0D\u4F1A\u88AB\u5F53\u4F5C\u5DF2\u68C0\u67E5\u653E\u884C\u3002"));
  }
  function SettingsAbout() {
    const [state, setState] = React.useState("idle"), [progress, setProgress] = React.useState(0), [notice, setNotice] = React.useState("");
    const timer = React.useRef(null);
    React.useEffect(() => () => clearInterval(timer.current), []);
    const download = () => {
      setState("downloading");
      setProgress(0);
      let n = 0;
      timer.current = setInterval(() => {
        n += 25;
        setProgress(n);
        if (n === 100) {
          clearInterval(timer.current);
          setState("ready");
        }
      }, 200);
    };
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SettingsSection, { title: "CogSeed" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u684C\u9762\u5E94\u7528" }, /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { disabled: ["checking", "downloading"].includes(state), onClick: () => {
      setState("checking");
      timer.current = setTimeout(() => setState("available"), 500);
    } }, state === "checking" ? "\u6B63\u5728\u68C0\u67E5\u2026" : "\u68C0\u67E5\u66F4\u65B0"), /* @__PURE__ */ React.createElement("a", { className: "cs-settings-external", href: "https://cogseed-open.bonc.com.cn/#view=changelog", target: "_blank", rel: "noopener noreferrer" }, "\u7248\u672C\u4ECB\u7ECD")))), state === "available" ? /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u53D1\u73B0\u53EF\u7528\u66F4\u65B0" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u65B0\u7248\u672C\u5B89\u88C5\u5305" }, /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: download }, "\u4E0B\u8F7D\u66F4\u65B0"), /* @__PURE__ */ React.createElement(Button, { onClick: () => {
      setState("idle");
      setNotice("\u5DF2\u8DF3\u8FC7\u6B64\u7248\u672C\u3002");
    } }, "\u8DF3\u8FC7\u6B64\u7248\u672C")))) : null, state === "downloading" ? /* @__PURE__ */ React.createElement("div", { role: "progressbar", "aria-valuenow": progress, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "\u4E0B\u8F7D\u8FDB\u5EA6" }, /* @__PURE__ */ React.createElement("p", null, "\u6B63\u5728\u4E0B\u8F7D \xB7 ", progress, "%"), /* @__PURE__ */ React.createElement("div", { className: "cs-settings-progress" }, /* @__PURE__ */ React.createElement("span", { style: { width: `${progress}%` } }))) : null, state === "ready" ? /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u4E0B\u8F7D\u5B8C\u6210" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u5B89\u88C5\u5305\u5DF2\u5C31\u7EEA" }, /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: () => setNotice("\u8BF7\u6253\u5F00\u5B89\u88C5\u5305\u7EE7\u7EED\u5B89\u88C5\u3002") }, "\u6253\u5F00\u5B89\u88C5\u5305"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", onClick: () => setNotice("\u51C6\u5907\u91CD\u542F\u5E76\u5B89\u88C5\u3002") }, "\u91CD\u542F\u5E76\u5B89\u88C5")))) : null, /* @__PURE__ */ React.createElement(SettingsFeedback, null, notice));
  }
  Object.assign(window, { SettingsChoice, SettingsActions, SettingsFeedback, SettingsConfirm, SettingsGeneral, SettingsUsage, SettingsAccount, SettingsSecurity, SettingsAbout });
  function SettingsRecycle() {
    const [items, setItems] = React.useState([{ id: "task", name: "\u9879\u76EE\u8C03\u7814\u6838\u9A8C", kind: "\u4EFB\u52A1", count: 3 }, { id: "file", name: "\u9879\u76EE\u53F0\u8D26\u8349\u7A3F.md", kind: "\u8D44\u6599", count: 1 }]);
    const [pending, setPending] = React.useState(null), [notice, setNotice] = React.useState("");
    return /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u56DE\u6536\u7AD9" }, items.length ? items.map((item) => /* @__PURE__ */ React.createElement(SettingsRow, { key: item.id, title: item.name, help: `${item.kind} \xB7 ${item.count} \u9879 \xB7 \u5220\u9664\u4E8E 2026-09-05 09:30` }, /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: () => {
      setItems((old) => old.filter((x) => x.id !== item.id));
      setNotice(`\u5DF2\u6062\u590D ${item.count} \u9879\u6570\u636E\u3002`);
    } }, "\u6062\u590D"), /* @__PURE__ */ React.createElement(Button, { onClick: () => setPending(item) }, "\u5F7B\u5E95\u5220\u9664")))) : /* @__PURE__ */ React.createElement("p", { className: "cs-settings-muted" }, "\u6682\u65E0\u53EF\u6062\u590D\u6570\u636E"), pending ? /* @__PURE__ */ React.createElement(SettingsConfirm, { title: `\u5F7B\u5E95\u5220\u9664\u300C${pending.name}\u300D\uFF1F\u5220\u9664\u540E\u4E0D\u53EF\u6062\u590D\u3002`, onCancel: () => setPending(null), onConfirm: () => {
      setItems((old) => old.filter((x) => x.id !== pending.id));
      setPending(null);
      setNotice("\u5DF2\u5F7B\u5E95\u5220\u9664\u3002");
    } }) : null, /* @__PURE__ */ React.createElement(SettingsFeedback, null, notice));
  }
  window.SettingsRecycle = SettingsRecycle;
})();
