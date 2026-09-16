/* Generated from ui_kits/enterprise-app/CapabilitiesScreen.jsx by tools/build.cjs. */
(() => {
  const { PageFrame, PageHeader, PageScroll, PageTabs, PreviewNameEditor } = window;
  const { ResourceCard, CardGrid, StatusDot, EmptyState, SegmentedControl, Button, Input, Switch, Select, Icon, GroupHeading, Dialog } = window.CogSeedDesignSystem_f581b5;
  const CAPABILITY_KEYS = ["agents", "tools", "skills", "library", "im"];
  const CAPABILITY_TABS = ["\u667A\u80FD\u4F53", "MCP \u4E0E\u5DE5\u5177", "\u6280\u80FD", "\u8D44\u6599\u5E93", "IM"];
  function resolveCapabilityTab(value) {
    const raw = String(value ?? "agents");
    return CAPABILITY_KEYS.includes(raw) ? raw : { "0": "agents", "1": "tools", "3": "skills", "4": "library", "5": "im" }[raw] || "agents";
  }
  window.resolveCapabilityTab = resolveCapabilityTab;
  const CAPABILITIES = [
    { id: "commander", kind: 0, name: "cogseed", icon: "space", enabled: true },
    { id: "codex", kind: 0, name: "Codex", icon: "fileText", enabled: true },
    { id: "credit", kind: 0, name: "\u9879\u76EE\u5206\u6790\u5E08", icon: "file", enabled: true },
    { id: "compliance", kind: 0, name: "\u5408\u89C4\u5BA1\u9605\u5458", icon: "shield", enabled: true },
    { id: "report", kind: 0, name: "\u7ECF\u8425\u5206\u6790\u5E08", icon: "fileText", enabled: false },
    { id: "ledger", kind: 1, name: "\u9879\u76EE\u53F0\u8D26", icon: "database", enabled: true, connected: true },
    { id: "warehouse", kind: 1, name: "\u7ECF\u8425\u6570\u636E\u4ED3\u5E93", icon: "database", enabled: true, connected: false },
    { id: "library", kind: 1, name: "\u5236\u5EA6\u5E93", icon: "connector", enabled: true, connected: true, error: true }
  ];
  function readAgentRoute() {
    const params = new URLSearchParams(location.search);
    return { id: params.get("agent"), editing: params.get("edit") === "1" };
  }
  function CapabilitiesScreen({ collapsed, onExpand, onUse, onSearch, initialFilter = "agents" }) {
    const [items, setItems] = React.useState(() => {
      const store = window.CapabilityAgentStore;
      if (!store.initialized) {
        store.items = [...CAPABILITIES, ...store.items || []];
        store.initialized = true;
      }
      return store.items;
    }), [filter, setFilter] = React.useState(() => resolveCapabilityTab(initialFilter)), [query, setQuery] = React.useState(() => new URLSearchParams(location.search).get("query") || ""), [category, setCategory] = React.useState(0), [notice, setNotice] = React.useState(""), [creating, setCreating] = React.useState(null), [remove, setRemove] = React.useState(null), [toolEditor, setToolEditor] = React.useState(false), [detail, setDetail] = React.useState(null), [market, setMarket] = React.useState(() => new URLSearchParams(location.search).get("market") || ""), [agentRoute, setAgentRoute] = React.useState(readAgentRoute);
    React.useEffect(() => {
      window.CapabilityAgentStore.items = items;
    }, [items]);
    const patch = (id, value) => setItems((old) => old.map((item) => item.id === id ? { ...item, ...value } : item));
    React.useEffect(() => {
      setFilter(resolveCapabilityTab(initialFilter));
      if (["2", "6"].includes(String(initialFilter))) setNotice("\u6B64\u5165\u53E3\u5DF2\u8C03\u6574\uFF0C\u8BF7\u4ECE\u5F53\u524D\u80FD\u529B\u5217\u8868\u9009\u62E9\u3002");
    }, [initialFilter]);
    React.useEffect(() => {
      const restore = () => {
        setAgentRoute(readAgentRoute());
        setMarket(new URLSearchParams(location.search).get("market") || "");
        setQuery(new URLSearchParams(location.search).get("query") || "");
        setFilter(resolveCapabilityTab(new URLSearchParams(location.search).get("tab")));
      };
      window.addEventListener("popstate", restore);
      return () => window.removeEventListener("popstate", restore);
    }, []);
    const openAgent = (id, editing = false) => {
      const url = new URL(location.href);
      url.searchParams.set("page", "capabilities");
      ["market", "query", "skill"].forEach((k) => url.searchParams.delete(k));
      setMarket("");
      url.searchParams.set("tab", "agents");
      if (id) url.searchParams.set("agent", id);
      else url.searchParams.delete("agent");
      if (editing) url.searchParams.set("edit", "1");
      else url.searchParams.delete("edit");
      history.pushState(null, "", url);
      setAgentRoute({ id, editing });
      setFilter("agents");
      setNotice("");
    };
    const changeTab = (index) => {
      const key = CAPABILITY_KEYS[index], url = new URL(location.href);
      url.searchParams.set("tab", key);
      ["agent", "edit", "skill", "query", "market"].forEach((k) => url.searchParams.delete(k));
      history.pushState(null, "", url);
      setFilter(key);
      setAgentRoute({ id: null, editing: false });
      setQuery("");
      setCategory(0);
      setNotice("");
      setDetail(null);
      setToolEditor(false);
      setMarket("");
    };
    const openMarket = (kind) => {
      const url = new URL(location.href);
      if (kind) url.searchParams.set("market", kind);
      else url.searchParams.delete("market");
      history.pushState(null, "", url);
      setMarket(kind);
    };
    const agents = items.filter((t) => t.kind === 0).map(window.agentProfile);
    const categories = ["\u5168\u90E8", ...new Set(agents.map((a) => a.category))];
    const visible = agents.filter((a) => (!category || a.category === categories[category]) && `${a.name} ${a.intro}`.toLowerCase().includes(query.trim().toLowerCase()));
    const managed = agents.find((a) => a.id === agentRoute.id);
    const useAgent = (a) => onUse?.({ title: `\u4F7F\u7528${a.name}\u5F00\u5C55\u5DE5\u4F5C`, agentName: a.name, content: "empty", initialMessage: `@${a.name} ` });
    const agentCard = (a) => /* @__PURE__ */ React.createElement(ResourceCard, { key: a.id, title: a.name, icon: a.icon, onOpen: () => openAgent(a.id), description: a.intro, status: /* @__PURE__ */ React.createElement("span", null, a.category, a.version ? ` \xB7 v${a.version}` : "", " \xB7 ", a.standards.length, " \u9879\u4EA4\u4ED8\u6807\u51C6 \xB7 ", (a.skills || []).length, " \u9879\u6280\u80FD", !a.enabled ? " \xB7 \u5DF2\u505C\u7528" : ""), action: "\u4F7F\u7528\u6B64\u667A\u80FD\u4F53", disabled: !a.enabled, onAction: () => useAgent(a), menu: { groups: [{ items: [{ label: "\u7BA1\u7406\u5DE5\u4F5C\u53F0", onSelect: () => openAgent(a.id) }, ...a.source === "custom" || a.source === "external" ? [{ label: "\u7F16\u8F91", onSelect: () => openAgent(a.id, true) }] : [], ...a.source !== "commander" ? [{ label: a.enabled ? "\u505C\u7528" : "\u542F\u7528", onSelect: () => patch(a.id, { enabled: !a.enabled }) }] : []] }, ...a.source !== "commander" ? [{ danger: true, items: [{ label: "\u5220\u9664", onSelect: () => setRemove(a) }] }] : []] } });
    return /* @__PURE__ */ React.createElement(PageFrame, null, /* @__PURE__ */ React.createElement(PageHeader, { collapsed, onExpand, title: "\u667A\u80FD\u4F53 / \u6280\u80FD / \u8FDE\u63A5" }), /* @__PURE__ */ React.createElement(PageScroll, { className: "cs-resource-page-scroll cs-page-tabs-layout" }, /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-content cs-capabilities-content" }, /* @__PURE__ */ React.createElement(PageTabs, { ariaLabel: "\u667A\u80FD\u4F53 / \u6280\u80FD / \u8FDE\u63A5", items: CAPABILITY_TABS, value: CAPABILITY_KEYS.indexOf(filter), onChange: changeTab }), notice && /* @__PURE__ */ React.createElement("p", { role: "status", className: "cs-resource-page-notice" }, notice), filter === "agents" && (market ? /* @__PURE__ */ React.createElement(CapabilityMarketplace, { kind: market, onKindChange: openMarket, onBack: () => openMarket("") }) : agentRoute.id ? managed ? /* @__PURE__ */ React.createElement(AgentWorkbench, { key: managed.id, item: managed, editing: agentRoute.editing, onEdit: (editing) => openAgent(managed.id, editing), onPatch: (value) => patch(managed.id, value), onBack: () => openAgent(null), onUse, onRemove: () => {
      setItems((old) => old.filter((t) => t.id !== managed.id));
      openAgent(null);
    } }) : /* @__PURE__ */ React.createElement(EmptyState, { title: "\u667A\u80FD\u4F53\u4E0D\u5B58\u5728", action: "\u8FD4\u56DE\u5217\u8868", onAction: () => openAgent(null) }) : /* @__PURE__ */ React.createElement("section", { "aria-label": "AI \u56E2\u961F" }, /* @__PURE__ */ React.createElement(window.ResourceToolbar, { leading: /* @__PURE__ */ React.createElement(SegmentedControl, { ariaLabel: "\u667A\u80FD\u4F53\u5206\u7C7B", items: categories, value: category, onChange: setCategory }), search: /* @__PURE__ */ React.createElement(Input, { size: "md", icon: "search", "aria-label": "\u641C\u7D22\u667A\u80FD\u4F53", placeholder: "\u641C\u7D22\u667A\u80FD\u4F53", value: query, onChange: (e) => setQuery(e.target.value) }), actions: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { onClick: () => setCreating("create") }, "\u521B\u5EFA\u667A\u80FD\u4F53"), /* @__PURE__ */ React.createElement(Button, { onClick: () => openMarket("agent") }, "\u66F4\u591A")) }), visible.length ? /* @__PURE__ */ React.createElement("div", { className: "cs-capability-sections" }, [["commander", "\u4E3B\u667A\u80FD\u4F53"], ["external", "\u5916\u63A5 Agent"], ["custom", "\u81EA\u5B9A\u4E49"], ["platform", "\u5E73\u53F0"]].map(([source, label]) => {
      const group = visible.filter((a) => a.source === source);
      return group.length ? /* @__PURE__ */ React.createElement("section", { key: source }, /* @__PURE__ */ React.createElement(GroupHeading, { label: `${label} \xB7 ${group.length}` }), /* @__PURE__ */ React.createElement(CardGrid, null, group.map(agentCard))) : null;
    })) : /* @__PURE__ */ React.createElement(EmptyState, { title: "\u6CA1\u6709\u5339\u914D\u7684\u667A\u80FD\u4F53", action: "\u6E05\u9664\u7B5B\u9009", onAction: () => {
      setQuery("");
      setCategory(0);
    } }))), filter === "tools" && /* @__PURE__ */ React.createElement("section", { "aria-label": "MCP \u4E0E\u5DE5\u5177" }, /* @__PURE__ */ React.createElement(window.ResourceToolbar, { search: /* @__PURE__ */ React.createElement(Input, { size: "md", icon: "search", "aria-label": "\u641C\u7D22\u8FDE\u63A5", placeholder: "\u641C\u7D22\u8FDE\u63A5", value: query, onChange: (e) => setQuery(e.target.value) }), actions: /* @__PURE__ */ React.createElement(Button, { onClick: () => setToolEditor(true) }, "\u6DFB\u52A0 MCP \u670D\u52A1\u5668") }), toolEditor && /* @__PURE__ */ React.createElement(PreviewNameEditor, { title: "MCP \u670D\u52A1\u5668\u540D\u79F0", onCancel: () => setToolEditor(false), onSave: (name) => {
      setItems((old) => [...old, { id: `mcp-${Date.now()}`, kind: 1, name, icon: "connector", enabled: true, connected: false }]);
      setToolEditor(false);
    } }), detail && /* @__PURE__ */ React.createElement("div", { className: "cs-capability-detail" }, /* @__PURE__ */ React.createElement("h2", null, detail.name), /* @__PURE__ */ React.createElement("p", null, "\u5DE5\u5177\uFF1A\u67E5\u8BE2\u8BB0\u5F55\u3001\u68C0\u7D22\u6587\u6863"), /* @__PURE__ */ React.createElement(Button, { onClick: () => setDetail(null) }, "\u8FD4\u56DE\u5217\u8868")), /* @__PURE__ */ React.createElement("div", { className: "cs-capability-sections" }, [true, false].map((connected) => /* @__PURE__ */ React.createElement("section", { key: String(connected) }, /* @__PURE__ */ React.createElement(GroupHeading, { label: connected ? "\u5DF2\u8FDE\u63A5" : "\u53EF\u7528\u8FDE\u63A5" }), /* @__PURE__ */ React.createElement(CardGrid, null, items.filter((t) => t.kind === 1 && !!t.connected === connected && t.name.includes(query)).map((t) => /* @__PURE__ */ React.createElement(ResourceCard, { key: t.id, title: t.name, icon: t.icon, onOpen: () => setDetail(t), status: /* @__PURE__ */ React.createElement(StatusDot, { tone: t.error ? "attention" : t.connected ? "success" : "idle", label: t.error ? "\u8FDE\u63A5\u5F02\u5E38" : t.connected ? "\u5DF2\u8FDE\u63A5" : "\u672A\u8FDE\u63A5" }), action: t.error ? "\u91CD\u8BD5\u8FDE\u63A5" : !t.connected ? "\u8FDE\u63A5\u8D26\u6237" : "\u4F7F\u7528\u8FDE\u63A5", onAction: () => t.error || !t.connected ? setNotice("\u8BBE\u8BA1\u9884\u89C8\u672A\u8FDE\u63A5 MCP \u670D\u52A1\uFF0C\u8BF7\u5728\u5B89\u88C5\u7248\u5B8C\u6210\u8FDE\u63A5\u3002") : onUse?.({ title: `\u4F7F\u7528${t.name}\u5F00\u5C55\u5DE5\u4F5C` }) }))))))), filter === "skills" && /* @__PURE__ */ React.createElement(CapabilitySkills, { onUse }), filter === "library" && /* @__PURE__ */ React.createElement(CapabilityLibrary, { onSearch, onUse: (value) => onUse?.({ title: `\u8BF7\u9605\u8BFB${value.name}`, reference: value.reference, content: "empty", initialMessage: `\u8BF7\u9605\u8BFB ${value.name}\uFF1A
${value.text}` }) }), filter === "im" && /* @__PURE__ */ React.createElement("section", { "aria-label": "IM" }, /* @__PURE__ */ React.createElement(IMConnectionManager, null)))), /* @__PURE__ */ React.createElement(AgentCreateDialog, { open: !!creating, initialMode: creating || "create", onClose: () => setCreating(null), onCreated: (agent) => {
      setItems([...window.CapabilityAgentStore.items]);
      setQuery("");
      setCategory(0);
      openAgent(agent.id, true);
    } }), remove && /* @__PURE__ */ React.createElement(Dialog, { title: `\u5220\u9664${remove.name}\uFF1F`, description: "\u5C06\u4ECE\u5F53\u524D\u8BBE\u8BA1\u9884\u89C8\u5217\u8868\u79FB\u9664\u6B64\u667A\u80FD\u4F53\u3002", danger: true, confirmLabel: "\u5220\u9664", onCancel: () => setRemove(null), onConfirm: () => {
      setItems((old) => old.filter((a) => a.id !== remove.id));
      setRemove(null);
    } }));
  }
  window.CapabilitiesScreen = CapabilitiesScreen;
  function IMConnectionManager() {
    const channels = ["\u98DE\u4E66", "Lark", "\u4F01\u4E1A\u5FAE\u4FE1", "Telegram", "\u4E2A\u4EBA\u5FAE\u4FE1"];
    const [channel, setChannel] = React.useState("\u98DE\u4E66");
    const [accounts, setAccounts] = React.useState({});
    const [scanning, setScanning] = React.useState(false);
    const [notice, setNotice] = React.useState("");
    const account = { linked: false, enabled: false, owner: "", ownerId: "", draftId: "", draftName: "", reply: "\u5BCC\u6587\u672C\u6D88\u606F", scope: "\u6240\u6709\u5DE5\u4F5C\u7A7A\u95F4", ...accounts[channel] };
    const patch = (change) => setAccounts((old) => ({ ...old, [channel]: { ...account, ...change } }));
    const selectChannel = (name) => {
      setChannel(name);
      setScanning(false);
      setNotice("");
    };
    const isFeishu = channel === "\u98DE\u4E66" || channel === "Lark";
    return /* @__PURE__ */ React.createElement("div", { className: "cs-im-page" }, /* @__PURE__ */ React.createElement("h2", null, "\u8FDE\u63A5\u7BA1\u7406"), /* @__PURE__ */ React.createElement("div", { className: "cs-im-layout" }, /* @__PURE__ */ React.createElement("aside", { className: "cs-im-menu", "aria-label": "\u6D88\u606F\u6E20\u9053" }, /* @__PURE__ */ React.createElement("div", { className: "cs-im-menu-heading" }, /* @__PURE__ */ React.createElement("h3", null, "\u6D88\u606F\u6E20\u9053")), /* @__PURE__ */ React.createElement("div", { className: "cs-im-channel-list" }, /* @__PURE__ */ React.createElement(GroupHeading, { label: "\u5DF2\u5F00\u653E" }), channels.map((name) => /* @__PURE__ */ React.createElement(Button, { key: name, variant: channel === name ? "primary" : "ghost", onClick: () => selectChannel(name) }, /* @__PURE__ */ React.createElement(Icon, { name: "connector", size: 16 }), /* @__PURE__ */ React.createElement("span", null, name), accounts[name]?.linked && /* @__PURE__ */ React.createElement("span", { className: "cs-im-channel-status" }, "\u5DF2\u7ED1\u5B9A")))), /* @__PURE__ */ React.createElement("div", { className: "cs-im-channel-list" }, /* @__PURE__ */ React.createElement(GroupHeading, { label: "\u5373\u5C06\u652F\u6301" }), ["QQ \u673A\u5668\u4EBA", "\u9489\u9489", "Discord"].map((name) => /* @__PURE__ */ React.createElement(Button, { key: name, variant: "ghost", disabled: true }, /* @__PURE__ */ React.createElement(Icon, { name: "connector", size: 16 }), name)))), /* @__PURE__ */ React.createElement("article", { className: "cs-im-content", "aria-label": `${channel}\u8FDE\u63A5\u7BA1\u7406` }, /* @__PURE__ */ React.createElement("header", { className: "cs-im-channel-header" }, /* @__PURE__ */ React.createElement("div", { className: "cs-im-channel-icon" }, /* @__PURE__ */ React.createElement(Icon, { name: "connector", size: 28 })), /* @__PURE__ */ React.createElement("div", { className: "cs-im-channel-copy" }, /* @__PURE__ */ React.createElement("div", { className: "cs-im-channel-name" }, /* @__PURE__ */ React.createElement("h3", null, channel), isFeishu && /* @__PURE__ */ React.createElement("span", { className: "cs-im-region" }, channel === "\u98DE\u4E66" ? "\u4E2D\u56FD" : "\u5168\u7403")), /* @__PURE__ */ React.createElement(StatusDot, { tone: account.linked ? "success" : "idle", label: account.linked ? "\u5DF2\u5173\u8054" : "\u672A\u5173\u8054" })), /* @__PURE__ */ React.createElement("div", { className: "cs-im-receive" }, /* @__PURE__ */ React.createElement("span", null, "\u63A5\u6536\u6D88\u606F"), /* @__PURE__ */ React.createElement(Switch, { "aria-label": "\u63A5\u6536\u6D88\u606F", checked: account.enabled, onChange: (value) => {
      if (!account.linked) {
        setNotice("\u8BF7\u5148\u5173\u8054\u673A\u5668\u4EBA");
        return;
      }
      patch({ enabled: value });
    } }))), notice && /* @__PURE__ */ React.createElement("p", { className: "cs-im-notice", role: "status" }, notice), /* @__PURE__ */ React.createElement("section", { className: "cs-im-section" }, /* @__PURE__ */ React.createElement("h3", null, "\u5F53\u524D\u8D26\u53F7"), /* @__PURE__ */ React.createElement("div", { className: "cs-im-account" }, /* @__PURE__ */ React.createElement(Icon, { name: "connector", size: 20 }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, channel, "\u673A\u5668\u4EBA"), /* @__PURE__ */ React.createElement(StatusDot, { tone: account.linked ? "success" : "idle", label: account.linked ? "\u5DF2\u5173\u8054" : "\u672A\u5173\u8054" })), account.linked && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => {
      patch({ linked: false, enabled: false, owner: "", ownerId: "" });
      setNotice("\u5DF2\u89E3\u9664\u8FDE\u63A5");
    } }, "\u89E3\u9664\u5173\u8054"))), /* @__PURE__ */ React.createElement("section", { className: "cs-im-section" }, /* @__PURE__ */ React.createElement("div", { className: "cs-im-section-row" }, /* @__PURE__ */ React.createElement("h3", null, "\u5173\u8054\u673A\u5668\u4EBA"), /* @__PURE__ */ React.createElement(Button, { disabled: account.linked, onClick: () => {
      setScanning(true);
      setNotice("");
    } }, account.linked ? "\u5DF2\u5173\u8054" : channel === "Telegram" ? "\u8FDE\u63A5\u673A\u5668\u4EBA" : "\u626B\u7801")), scanning && /* @__PURE__ */ React.createElement("div", { className: "cs-im-scan" }, /* @__PURE__ */ React.createElement("h3", null, channel === "Telegram" ? "\u8FDE\u63A5\u673A\u5668\u4EBA" : "\u5173\u8054\u673A\u5668\u4EBA"), /* @__PURE__ */ React.createElement("div", { className: "cs-im-actions" }, /* @__PURE__ */ React.createElement(Button, { variant: "primary", onClick: () => {
      patch({ linked: true, enabled: true });
      setScanning(false);
      setNotice("\u5DF2\u5B8C\u6210\u5173\u8054");
    } }, "\u5B8C\u6210\u5173\u8054"), /* @__PURE__ */ React.createElement(Button, { onClick: () => setScanning(false) }, "\u53D6\u6D88")))), /* @__PURE__ */ React.createElement("section", { className: "cs-im-section" }, /* @__PURE__ */ React.createElement("h3", null, "\u8EAB\u4EFD\u4E0E\u6295\u9012"), account.ownerId ? /* @__PURE__ */ React.createElement("div", { className: "cs-im-section-row" }, /* @__PURE__ */ React.createElement(StatusDot, { tone: "success", label: account.owner || account.ownerId }), /* @__PURE__ */ React.createElement(Button, { onClick: () => patch({ owner: "", ownerId: "" }) }, "\u89E3\u9664\u8EAB\u4EFD\u7ED1\u5B9A")) : /* @__PURE__ */ React.createElement("form", { className: "cs-im-owner-form", onSubmit: (event) => {
      event.preventDefault();
      if (!account.draftId.trim()) {
        setNotice("\u8BF7\u586B\u5199\u5F52\u5C5E\u4EBA ID");
        return;
      }
      patch({ ownerId: account.draftId.trim(), owner: account.draftName.trim() });
      setNotice("\u5F52\u5C5E\u4EBA\u5DF2\u4FDD\u5B58");
    } }, /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u5F52\u5C5E\u4EBA ID", placeholder: isFeishu ? "ou_xxxxxxxxxxxxxxxx" : "\u5F52\u5C5E\u4EBA ID", value: account.draftId, onChange: (e) => patch({ draftId: e.target.value }) }), /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u5F52\u5C5E\u4EBA\u540D\u79F0", placeholder: "\u9009\u586B\uFF1A\u5F52\u5C5E\u4EBA\u540D\u79F0", value: account.draftName, onChange: (e) => patch({ draftName: e.target.value }) }), /* @__PURE__ */ React.createElement(Button, { type: "submit", variant: "primary" }, "\u4FDD\u5B58\u5F52\u5C5E\u4EBA"))), /* @__PURE__ */ React.createElement("section", { className: "cs-im-section cs-im-behavior" }, /* @__PURE__ */ React.createElement("h3", null, "\u6D88\u606F\u884C\u4E3A"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "cs-im-setting-row" }, /* @__PURE__ */ React.createElement("span", null, "\u673A\u5668\u4EBA\u56DE\u590D\u9897\u7C92\u5EA6"), /* @__PURE__ */ React.createElement(Select, { options: isFeishu ? ["\u5BCC\u6587\u672C\u6D88\u606F", "\u6D41\u5F0F\u5361\u7247"] : ["\u5BCC\u6587\u672C\u6D88\u606F"], value: account.reply, onChange: (value) => patch({ reply: value }) })), /* @__PURE__ */ React.createElement("div", { className: "cs-im-setting-row" }, /* @__PURE__ */ React.createElement("span", null, "\u5DE5\u4F5C\u7A7A\u95F4\u8BBF\u95EE\u8303\u56F4"), /* @__PURE__ */ React.createElement(Select, { options: ["\u6240\u6709\u5DE5\u4F5C\u7A7A\u95F4", "\u4EC5\u5F53\u524D\u5DE5\u4F5C\u7A7A\u95F4"], value: account.scope, onChange: (value) => patch({ scope: value }) })))))));
  }
})();
