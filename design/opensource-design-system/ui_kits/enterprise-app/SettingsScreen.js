/* Generated from ui_kits/enterprise-app/SettingsScreen.jsx by tools/build.cjs. */
(() => {
  const { SettingsSection, Button, Icon, NavItem } = window.CogSeedDesignSystem_f581b5;
  function SettingsRow({ title, help, children }) {
    return /* @__PURE__ */ React.createElement("div", { className: "cs-settings-row" }, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-row-copy" }, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-row-title" }, title), help ? /* @__PURE__ */ React.createElement("p", null, help) : null), /* @__PURE__ */ React.createElement("div", { className: "cs-settings-row-control" }, children));
  }
  const SETTINGS_SECTIONS = [
    ["data", "\u6570\u636E", "database"],
    ["account", "\u8D26\u53F7", "lock"],
    ["usage", "\u8D26\u53F7\u4E0E\u7528\u91CF", "clock"],
    ["general", "\u901A\u7528", "settings"],
    ["security", "\u5B89\u5168\u4E0E\u4FE1\u4EFB", "shield"],
    ["about", "\u5173\u4E8E\u6211\u4EEC", "info"]
  ];
  function readSettingsSection() {
    const value = new URLSearchParams(window.location.search).get("section");
    return SETTINGS_SECTIONS.some(([id]) => id === value) ? value : "data";
  }
  function SettingsScreen({ onBack, onLibrary }) {
    const [section, setSection] = React.useState(readSettingsSection);
    const [detail, setDetail] = React.useState(() => readSettingsSection() === "data" && new URLSearchParams(location.search).get("detail") === "memory");
    React.useEffect(() => {
      const restore = () => {
        setSection(readSettingsSection());
        setDetail(readSettingsSection() === "data" && new URLSearchParams(location.search).get("detail") === "memory");
      };
      window.addEventListener("popstate", restore);
      return () => window.removeEventListener("popstate", restore);
    }, []);
    const select = (id) => {
      setDetail(false);
      setNotice("");
      if (id !== section || detail) {
        const url = new URL(window.location.href);
        url.searchParams.set("section", id);
        url.searchParams.delete("detail");
        window.history.pushState(null, "", url);
        setSection(id);
      }
    };
    React.useEffect(() => {
      const pane = document.querySelector(".cs-settings-scroll");
      if (pane) pane.scrollTop = 0;
    }, [section, detail]);
    const [memory, setMemory] = React.useState(() => JSON.parse(JSON.stringify(window.MEMORY_PREVIEW)));
    const [notice, setNotice] = React.useState("");
    const openMemory = (active) => {
      const url = new URL(location.href);
      active ? url.searchParams.set("detail", "memory") : url.searchParams.delete("detail");
      history.pushState(null, "", url);
      setDetail(active);
    };
    const preview = (title) => setNotice(`\u8BF7\u5728\u6587\u4EF6\u7BA1\u7406\u5668\u4E2D\u67E5\u770B${title}`);
    return /* @__PURE__ */ React.createElement(PageFrame, { className: "cs-settings-screen" }, /* @__PURE__ */ React.createElement(PageHeader, { windowControls: true, title: "\u8BBE\u7F6E" }), /* @__PURE__ */ React.createElement("div", { className: "cs-settings-layout" }, /* @__PURE__ */ React.createElement("aside", { className: "cs-settings-nav" }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", icon: /* @__PURE__ */ React.createElement(Icon, { name: "chevronLeft", size: 14 }), onClick: onBack, style: { justifyContent: "flex-start", width: "100%", marginBottom: "var(--cs-space-6)" } }, "\u8FD4\u56DE\u5E94\u7528"), /* @__PURE__ */ React.createElement("nav", { "aria-label": "\u8BBE\u7F6E\u5206\u7C7B" }, SETTINGS_SECTIONS.map(([id, label, icon]) => /* @__PURE__ */ React.createElement(NavItem, { key: id, icon: /* @__PURE__ */ React.createElement(Icon, { name: icon }), label, selected: section === id, "aria-current": section === id ? "page" : void 0, onClick: () => select(id) })))), /* @__PURE__ */ React.createElement(PageScroll, { className: "cs-settings-scroll" }, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-content" }, /* @__PURE__ */ React.createElement("div", { hidden: section !== "data" }, detail ? /* @__PURE__ */ React.createElement(MemorySettings, { value: memory, onChange: setMemory, onBack: () => openMemory(false) }) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-heading" }, /* @__PURE__ */ React.createElement("h1", null, "\u6570\u636E")), /* @__PURE__ */ React.createElement("div", { className: "cs-settings-notice", role: "status", "aria-live": "polite" }, notice), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u8BB0\u5FC6" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u4E2A\u4EBA\u8BB0\u5FC6", help: "\u7BA1\u7406\u8DE8\u4EFB\u52A1\u4F7F\u7528\u7684\u4E2A\u4EBA\u8BB0\u5FC6\u3002" }, /* @__PURE__ */ React.createElement(Button, { onClick: () => {
      setNotice("");
      openMemory(true);
    } }, "\u7BA1\u7406\u8BB0\u5FC6"))), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u672C\u5730" }, /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u8D44\u6599\u5E93", help: "\u7BA1\u7406\u53EF\u4F9B\u6A21\u578B\u5F15\u7528\u7684\u8D44\u6599\u5185\u5BB9\u3002" }, /* @__PURE__ */ React.createElement(Button, { onClick: onLibrary }, "\u6253\u5F00\u8D44\u6599\u5E93")), /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u6570\u636E\u76EE\u5F55", help: "\u5728\u7CFB\u7EDF\u6587\u4EF6\u7BA1\u7406\u5668\u4E2D\u67E5\u770B\u5E94\u7528\u6570\u636E\u3002" }, /* @__PURE__ */ React.createElement(Button, { onClick: () => preview("\u6570\u636E\u76EE\u5F55") }, "\u6253\u5F00\u76EE\u5F55"))), /* @__PURE__ */ React.createElement(SettingsRecycle, null))), SETTINGS_SECTIONS.filter(([id]) => id !== "data").map(([id, label]) => /* @__PURE__ */ React.createElement("div", { key: id, hidden: section !== id }, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-heading" }, /* @__PURE__ */ React.createElement("h1", null, label)), id === "account" ? /* @__PURE__ */ React.createElement(SettingsAccount, null) : id === "usage" ? /* @__PURE__ */ React.createElement(SettingsUsage, null) : id === "general" ? /* @__PURE__ */ React.createElement(SettingsGeneral, null) : id === "security" ? /* @__PURE__ */ React.createElement(SettingsSecurity, null) : /* @__PURE__ */ React.createElement(SettingsAbout, null)))))));
  }
  Object.assign(window, { SettingsScreen, SettingsRow, SETTINGS_SECTIONS, readSettingsSection });
})();
