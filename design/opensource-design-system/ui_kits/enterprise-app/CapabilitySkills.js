/* Generated from ui_kits/enterprise-app/CapabilitySkills.jsx by tools/build.cjs. */
(() => {
  (function() {
    const { ResourceCard, CardGrid, GroupHeading, Input, Textarea, Field, Tabs, SegmentedControl, Button, DropdownMenu, Dialog, StatusDot, EmptyState } = window.CogSeedDesignSystem_f581b5;
    const sources = { custom: "\u81EA\u5B9A\u4E49", platform: "\u5E73\u53F0", external: "\u5916\u90E8\u5305", global: "\u5168\u5C40\u6587\u4EF6\u5939" };
    const initial = [
      { id: "credit-check", name: "\u9879\u76EE\u62A5\u544A\u53E3\u5F84\u6838\u9A8C", source: "custom", category: "\u6570\u636E\u5206\u6790", description: "\u6838\u5BF9\u62A5\u8868\u671F\u95F4\u3001\u5E01\u79CD\u4E0E\u5408\u5E76\u8303\u56F4\uFF0C\u5217\u51FA\u5DEE\u5F02\u548C\u9700\u8981\u8865\u5145\u7684\u4F9D\u636E\u3002", enabled: true, security: "\u901A\u8FC7", body: "# \u9879\u76EE\u62A5\u544A\u53E3\u5F84\u6838\u9A8C\n\n\u8BFB\u53D6\u672C\u6B21\u4EFB\u52A1\u63D0\u4F9B\u7684\u8D22\u52A1\u6750\u6599\uFF0C\u9010\u9879\u6BD4\u5BF9\u671F\u95F4\u3001\u5E01\u79CD\u4E0E\u5408\u5E76\u8303\u56F4\u3002\n\n\u4EA4\u4ED8\uFF1A\u5DEE\u5F02\u6E05\u5355\u3001\u6765\u6E90\u9875\u7801\u3001\u5F85\u6838\u5B9E\u4E8B\u9879\u3002" },
      { id: "material-list", name: "\u8C03\u7814\u6750\u6599\u6E05\u5355", source: "custom", category: "\u6587\u6863\u5904\u7406", description: "\u6309\u9879\u76EE\u6750\u6599\u6E05\u5355\u68C0\u67E5\u7F3A\u5931\u9879\uFF0C\u5F62\u6210\u8865\u4EF6\u6E05\u5355\u3002", enabled: true, security: "\u5F85\u68C0\u67E5", body: "# \u8C03\u7814\u6750\u6599\u6E05\u5355\n\n\u9010\u9879\u6838\u9A8C\u5DF2\u63D0\u4F9B\u7684\u6750\u6599\u3002\u7F3A\u5C11\u8BC1\u636E\u65F6\u8BB0\u5F55\u5F85\u8865\u5145\uFF0C\u4E0D\u63A8\u65AD\u5BA1\u6838\u7ED3\u8BBA\u3002" },
      { id: "document-summary", name: "\u6587\u6863\u6458\u8981", source: "platform", category: "\u6587\u6863\u5904\u7406", description: "\u63D0\u53D6\u957F\u6587\u6863\u7684\u6838\u5FC3\u7ED3\u8BBA\u3001\u5173\u952E\u6570\u5B57\u4E0E\u5F15\u7528\u4F4D\u7F6E\u3002", enabled: true, security: "\u901A\u8FC7", body: "# \u6587\u6863\u6458\u8981\n\n\u5148\u660E\u786E\u6458\u8981\u7528\u9014\uFF0C\u518D\u63D0\u53D6\u6838\u5FC3\u7ED3\u8BBA\u548C\u8BC1\u636E\u4F4D\u7F6E\u3002" },
      { id: "table-review", name: "\u8868\u683C\u6838\u5BF9", source: "platform", category: "\u6570\u636E\u5206\u6790", description: "\u6838\u5BF9\u6C47\u603B\u53E3\u5F84\u3001\u5F02\u5E38\u6570\u503C\u548C\u660E\u7EC6\u4E4B\u95F4\u7684\u5BF9\u5E94\u5173\u7CFB\u3002", enabled: true, security: "\u963B\u6B62\u4F7F\u7528", body: "# \u8868\u683C\u6838\u5BF9\n\n\u6B64\u7248\u672C\u7684\u6267\u884C\u811A\u672C\u9700\u8981\u91CD\u65B0\u68C0\u67E5\u3002" },
      { id: "office-tools", name: "\u529E\u516C\u6587\u6863\u5DE5\u5177\u5305", source: "external", category: "\u6587\u6863\u5904\u7406", description: "\u63D0\u4F9B\u6587\u6863\u683C\u5F0F\u8F6C\u6362\u4E0E\u8868\u683C\u6574\u7406\u5DE5\u5177\u3002", enabled: true, security: null, version: "1.2.0", body: "\u6587\u6863\u8F6C\u6362\n\u8868\u683C\u6574\u7406" },
      { id: "report-outline", name: "report-outline", source: "global", category: "\u6587\u6863\u5904\u7406", description: "\u6839\u636E\u6750\u6599\u751F\u6210\u5206\u5C42\u62A5\u544A\u63D0\u7EB2\u3002", enabled: true, security: null, body: "# \u62A5\u544A\u63D0\u7EB2\n\n\u6309\u7ED3\u8BBA\u3001\u8BC1\u636E\u3001\u5F85\u786E\u8BA4\u4E8B\u9879\u7EC4\u7EC7\u62A5\u544A\u3002" },
      { id: "report-review", name: "report-review", source: "global", category: "\u6587\u6863\u5904\u7406", description: "\u68C0\u67E5\u62A5\u544A\u7ED3\u6784\u4E0E\u5F15\u7528\u662F\u5426\u5B8C\u6574\u3002", enabled: false, security: null, body: "# \u62A5\u544A\u590D\u6838\n\n\u68C0\u67E5\u7AE0\u8282\u7ED3\u6784\u548C\u8BC1\u636E\u5F15\u7528\u3002" }
    ];
    let previewItems = initial;
    const stack = { display: "grid", gap: "var(--cs-space-4)" };
    function CapabilitySkills({ onUse }) {
      const [items, setItems] = React.useState(() => previewItems), [query, setQuery] = React.useState(() => new URLSearchParams(location.search).get("query") || ""), [category, setCategory] = React.useState("\u5168\u90E8");
      const readRoute = () => new URLSearchParams(location.search).get("skill");
      const [selected, setSelected] = React.useState(readRoute), [view, setView] = React.useState("content"), [expanded, setExpanded] = React.useState(false);
      const [modal, setModal] = React.useState(null), [method, setMethod] = React.useState(0), [draft, setDraft] = React.useState({ name: "", description: "", url: "" }), [error, setError] = React.useState(""), [notice, setNotice] = React.useState(""), [text, setText] = React.useState("");
      React.useEffect(() => {
        const restore = () => {
          setSelected(readRoute());
          setQuery(new URLSearchParams(location.search).get("query") || "");
          setView("content");
          setModal(null);
        };
        window.addEventListener("popstate", restore);
        return () => window.removeEventListener("popstate", restore);
      }, []);
      React.useEffect(() => {
        previewItems = items;
      }, [items]);
      const open = (id, next = "content") => {
        const url = new URL(location.href);
        if (id) url.searchParams.set("skill", id);
        else url.searchParams.delete("skill");
        history.pushState(null, "", url);
        setSelected(id);
        setView(next);
        setNotice("");
      };
      const patch = (id, change) => setItems((old) => old.map((item) => item.id === id ? { ...item, ...change } : item));
      const inMarket = selected === "market" || selected?.startsWith("market:");
      const current = items.find((item) => item.id === selected);
      const use = (item) => onUse?.({ title: `\u4F7F\u7528${item.name}\u5F00\u5C55\u5DE5\u4F5C`, content: "empty", initialMessage: `\u4F7F\u7528\u6280\u80FD\u300C${item.name}\u300D\uFF1A`, skill: { id: item.id, name: item.name, source: item.source } });
      const showCreate = () => {
        setDraft({ name: "", description: "", url: "" });
        setMethod(0);
        setError("");
        setModal({ kind: "create" });
      };
      const matching = (item) => (!query.trim() || `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())) && (category === "\u5168\u90E8" || item.category === category);
      const visible = items.filter(matching);
      const trusted = items.filter((item) => item.source === "custom" || item.source === "platform");
      const count = (status) => trusted.filter((item) => item.security === status).length;
      const security = (item) => /* @__PURE__ */ React.createElement(StatusDot, { tone: item.security === "\u901A\u8FC7" ? "success" : item.security === "\u963B\u6B62\u4F7F\u7528" ? "critical" : "attention", label: `\u5B89\u68C0${item.security}` });
      const menu = (item) => ({ groups: [{ items: [{ label: "\u67E5\u770B\u8BE6\u60C5", onSelect: () => open(item.id) }, ...item.source === "custom" ? [{ label: "\u7F16\u8F91\u6280\u80FD", onSelect: () => {
        open(item.id, "edit");
        setText(item.body);
      } }] : [], { label: item.enabled ? "\u505C\u7528" : "\u542F\u7528", onSelect: () => patch(item.id, { enabled: !item.enabled }) }] }, ...item.source === "custom" ? [{ danger: true, items: [{ label: "\u5220\u9664\u6280\u80FD", onSelect: () => setModal({ kind: "delete", item }) }] }] : []] });
      const card = (item) => /* @__PURE__ */ React.createElement(ResourceCard, { key: item.id, variant: "capability", title: item.name, icon: "fileText", description: item.description, status: /* @__PURE__ */ React.createElement(StatusDot, { tone: item.enabled ? "success" : "idle", label: item.enabled ? item.category : "\u5DF2\u505C\u7528" }), action: item.source === "external" ? "\u67E5\u770B\u5DE5\u5177\u5305" : "\u4F7F\u7528", disabled: item.source !== "external" && (!item.enabled || item.security === "\u963B\u6B62\u4F7F\u7528"), onAction: () => item.source === "external" ? open(item.id) : use(item), menu: menu(item) }, item.security && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => open(item.id, "security") }, security(item)), item.source === "external" && /* @__PURE__ */ React.createElement("span", null, item.version, " \xB7 2 \u9879\u6280\u80FD"));
      const saveCreate = () => {
        if (method !== 0) {
          setError(method === 1 ? "\u5C1A\u672A\u8FDE\u63A5\u5BFC\u5165\u670D\u52A1\uFF0C\u5730\u5740\u5DF2\u4FDD\u7559\u3002" : "\u6587\u4EF6\u5939\u5BFC\u5165\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
          return;
        }
        const name = draft.name.trim();
        if (!name || name.length > 60) {
          setError("\u6280\u80FD\u540D\u79F0\u987B\u4E3A 1\u201360 \u4E2A\u5B57\u7B26\u3002");
          return;
        }
        if (!draft.description.trim()) {
          setError("\u8BF7\u586B\u5199\u6280\u80FD\u8981\u5B8C\u6210\u7684\u5DE5\u4F5C\u3002");
          return;
        }
        if (items.some((item) => item.source === "custom" && item.name === name)) {
          setError("\u5DF2\u5B58\u5728\u540C\u540D\u81EA\u5B9A\u4E49\u6280\u80FD\uFF0C\u8BF7\u4FEE\u6539\u540D\u79F0\u3002");
          return;
        }
        const id = `custom-${Date.now()}`;
        setItems((old) => [...old, { id, name, description: draft.description.trim(), source: "custom", category: "\u901A\u7528", enabled: true, security: "\u5F85\u68C0\u67E5", body: `# ${name}

${draft.description.trim()}` }]);
        setModal(null);
        setQuery("");
        setCategory("\u5168\u90E8");
        open(id);
        setNotice("\u6280\u80FD\u5DF2\u521B\u5EFA\uFF0C\u53EF\u7EE7\u7EED\u7F16\u8F91\u4F7F\u7528\u8BF4\u660E\u3002");
      };
      return /* @__PURE__ */ React.createElement("div", { className: "cs-skills-layout", style: stack }, notice && /* @__PURE__ */ React.createElement("p", { role: "status", className: "cs-resource-page-notice" }, notice), inMarket ? /* @__PURE__ */ React.createElement(window.CapabilityMarketplace, { kind: "skill", selectedId: selected.startsWith("market:") ? selected.slice(7) : null, onSelect: (id) => open(id ? `market:${id}` : "market"), onBack: () => open(null) }) : selected ? current ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-toolbar" }, /* @__PURE__ */ React.createElement(Button, { onClick: () => open(null) }, "\u8FD4\u56DE\u6280\u80FD"), /* @__PURE__ */ React.createElement("h2", { style: { font: "var(--cs-type-title)", margin: 0 } }, current.name), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(DropdownMenu, { trigger: /* @__PURE__ */ React.createElement(Button, null, "\u66F4\u591A\u64CD\u4F5C"), ...menu(current) }), current.source !== "external" && /* @__PURE__ */ React.createElement(Button, { disabled: !current.enabled || current.security === "\u963B\u6B62\u4F7F\u7528", onClick: () => use(current) }, "\u4F7F\u7528")), /* @__PURE__ */ React.createElement("p", null, sources[current.source], " \xB7 ", current.category, current.version ? ` \xB7 ${current.version}` : ""), /* @__PURE__ */ React.createElement(Tabs, { items: ["\u4F7F\u7528\u8BF4\u660E", ...current.security ? ["\u5B89\u68C0\u8BE6\u60C5"] : []], value: view === "security" ? 1 : 0, onChange: (index) => setView(index ? "security" : "content") }), view === "security" ? /* @__PURE__ */ React.createElement("section", { style: stack, "aria-label": "\u6280\u80FD\u5B89\u68C0\u8BE6\u60C5" }, security(current), /* @__PURE__ */ React.createElement("p", null, current.security === "\u901A\u8FC7" ? "\u6700\u8FD1\u8BB0\u5F55\u672A\u53D1\u73B0\u963B\u65AD\u9879\u3002" : current.security === "\u963B\u6B62\u4F7F\u7528" ? "\u6267\u884C\u811A\u672C\u5305\u542B\u672A\u6279\u51C6\u7684\u5916\u90E8\u8C03\u7528\uFF0C\u672C\u7248\u672C\u6682\u4E0D\u53EF\u4F7F\u7528\u3002" : "\u5F53\u524D\u5185\u5BB9\u5C1A\u65E0\u68C0\u67E5\u7ED3\u679C\u3002"), /* @__PURE__ */ React.createElement("dl", null, /* @__PURE__ */ React.createElement("dt", null, "\u68C0\u67E5\u8303\u56F4"), /* @__PURE__ */ React.createElement("dd", null, "SKILL.md\u3001\u6267\u884C\u811A\u672C\u4E0E\u4F9D\u8D56\u58F0\u660E"), /* @__PURE__ */ React.createElement("dt", null, "\u68C0\u67E5\u8BB0\u5F55"), /* @__PURE__ */ React.createElement("dd", null, current.security === "\u5F85\u68C0\u67E5" ? "\u6682\u65E0\u8BB0\u5F55" : "2026-09-05 10:20")), /* @__PURE__ */ React.createElement(Button, { onClick: () => setNotice("\u5C1A\u672A\u8FDE\u63A5\u5B89\u5168\u68C0\u67E5\u670D\u52A1\uFF0C\u4FDD\u7559\u6700\u8FD1\u68C0\u67E5\u8BB0\u5F55\u3002") }, "\u91CD\u65B0\u68C0\u67E5")) : view === "edit" ? /* @__PURE__ */ React.createElement("form", { style: stack, onSubmit: (event) => {
        event.preventDefault();
        if (!text.trim()) {
          setNotice("\u4F7F\u7528\u8BF4\u660E\u4E0D\u80FD\u4E3A\u7A7A\u3002");
          return;
        }
        patch(current.id, { body: text, security: "\u5F85\u68C0\u67E5" });
        setView("content");
        setNotice("\u4F7F\u7528\u8BF4\u660E\u5DF2\u4FDD\u5B58\uFF0C\u5B89\u68C0\u72B6\u6001\u5DF2\u91CD\u7F6E\u4E3A\u5F85\u68C0\u67E5\u3002");
      } }, /* @__PURE__ */ React.createElement(Field, { label: "SKILL.md" }, /* @__PURE__ */ React.createElement(Textarea, { "aria-label": "\u6280\u80FD\u4F7F\u7528\u8BF4\u660E", value: text, onChange: (event) => setText(event.target.value), minHeight: 260 })), /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-toolbar" }, /* @__PURE__ */ React.createElement(Button, { type: "button", onClick: () => setView("content") }, "\u53D6\u6D88\u7F16\u8F91"), /* @__PURE__ */ React.createElement(Button, { type: "submit" }, "\u4FDD\u5B58\u5185\u5BB9"))) : /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(0, 4fr)", gap: "var(--cs-space-4)" } }, /* @__PURE__ */ React.createElement("aside", { "aria-label": "\u6280\u80FD\u6587\u4EF6" }, /* @__PURE__ */ React.createElement(GroupHeading, { label: "\u6587\u4EF6" }), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => setView("content") }, current.source === "external" ? "\u5305\u542B\u7684\u6280\u80FD" : "SKILL.md")), /* @__PURE__ */ React.createElement("article", null, /* @__PURE__ */ React.createElement("p", null, current.description), /* @__PURE__ */ React.createElement("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "var(--cs-type-body)", margin: 0 } }, current.body), current.source === "external" && /* @__PURE__ */ React.createElement("p", null, "\u6B64\u5DE5\u5177\u5305\u7684\u6280\u80FD\u6587\u4EF6\u53EA\u8BFB\u3002")))) : /* @__PURE__ */ React.createElement(EmptyState, { title: "\u6280\u80FD\u4E0D\u5B58\u5728", reason: "\u8BE5\u6280\u80FD\u53EF\u80FD\u5DF2\u79FB\u9664\uFF0C\u8BF7\u8FD4\u56DE\u5217\u8868\u91CD\u65B0\u9009\u62E9\u3002", action: "\u8FD4\u56DE\u6280\u80FD", onAction: () => open(null) }) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(window.ResourceToolbar, { leading: /* @__PURE__ */ React.createElement(SegmentedControl, { ariaLabel: "\u6280\u80FD\u5206\u7C7B", items: ["\u5168\u90E8", "\u901A\u7528", "\u6587\u6863\u5904\u7406", "\u6570\u636E\u5206\u6790"], value: ["\u5168\u90E8", "\u901A\u7528", "\u6587\u6863\u5904\u7406", "\u6570\u636E\u5206\u6790"].indexOf(category), onChange: (index) => setCategory(["\u5168\u90E8", "\u901A\u7528", "\u6587\u6863\u5904\u7406", "\u6570\u636E\u5206\u6790"][index]) }), search: /* @__PURE__ */ React.createElement(Input, { size: "md", "aria-label": "\u641C\u7D22\u6280\u80FD", icon: "search", placeholder: "\u641C\u7D22\u6280\u80FD\u540D\u79F0\u6216\u7B80\u4ECB", value: query, onChange: (event) => setQuery(event.target.value) }), actions: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { onClick: showCreate }, "\u521B\u5EFA\u6280\u80FD"), /* @__PURE__ */ React.createElement(Button, { onClick: () => {
        setQuery("");
        setCategory("\u5168\u90E8");
        open("market");
      } }, "\u66F4\u591A")) }), /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-toolbar", "aria-label": "\u6280\u80FD\u5B89\u68C0\u6C47\u603B" }, /* @__PURE__ */ React.createElement("span", null, "\u5B89\u68C0 \xB7 ", count("\u901A\u8FC7"), " \u9879\u901A\u8FC7 \xB7 ", count("\u5F85\u68C0\u67E5"), " \u9879\u5F85\u68C0\u67E5 \xB7 ", count("\u963B\u6B62\u4F7F\u7528"), " \u9879\u963B\u6B62\u4F7F\u7528"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => {
        const item = trusted.find((item2) => item2.security === "\u963B\u6B62\u4F7F\u7528") || trusted[0];
        if (item) open(item.id, "security");
      } }, "\u67E5\u770B\u5B89\u68C0\u8BE6\u60C5")), visible.length ? Object.entries(sources).map(([source, label]) => {
        const list = visible.filter((item) => item.source === source);
        if (!list.length) return null;
        return /* @__PURE__ */ React.createElement("section", { key: source, style: stack, "aria-label": `${label}\u6280\u80FD` }, /* @__PURE__ */ React.createElement(GroupHeading, { label: `${label} \xB7 ${list.length}` }), source === "global" ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(ResourceCard, { title: "report", description: `${list.length} \u9879\u62A5\u544A\u6280\u80FD`, action: expanded ? "\u6536\u8D77\u6280\u80FD" : "\u5C55\u5F00\u6280\u80FD", onAction: () => setExpanded((old) => !old), menu: { groups: [{ items: [{ label: "\u542F\u7528\u5168\u90E8", onSelect: () => setItems((old) => old.map((item) => item.source === "global" ? { ...item, enabled: true } : item)) }, { label: "\u505C\u7528\u5168\u90E8", onSelect: () => setItems((old) => old.map((item) => item.source === "global" ? { ...item, enabled: false } : item)) }] }] } }), expanded && /* @__PURE__ */ React.createElement(CardGrid, null, list.map(card))) : /* @__PURE__ */ React.createElement(CardGrid, null, list.map(card)));
      }) : /* @__PURE__ */ React.createElement(EmptyState, { title: "\u6CA1\u6709\u5339\u914D\u7684\u6280\u80FD", action: "\u6E05\u9664\u7B5B\u9009", onAction: () => {
        setQuery("");
        setCategory("\u5168\u90E8");
      } })), modal?.kind === "delete" && /* @__PURE__ */ React.createElement(Dialog, { title: `\u5220\u9664\u300C${modal.item.name}\u300D\uFF1F`, description: "\u6280\u80FD\u6587\u4EF6\u5C06\u5220\u9664\uFF0C\u5DF2\u6709\u4EFB\u52A1\u4E0E\u4EA7\u7269\u4FDD\u7559\u3002\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002", confirmLabel: "\u5220\u9664\u6280\u80FD", danger: true, onCancel: () => setModal(null), onConfirm: () => {
        setItems((old) => old.filter((item) => item.id !== modal.item.id));
        if (selected === modal.item.id) open(null);
        setModal(null);
        setNotice("\u6280\u80FD\u5DF2\u5220\u9664");
      } }), modal?.kind === "create" && /* @__PURE__ */ React.createElement(Dialog, { title: "\u521B\u5EFA\u6280\u80FD\uFF1F", width: 520, confirmLabel: method === 0 ? "\u521B\u5EFA\u6280\u80FD" : "\u5BFC\u5165\u6280\u80FD", onCancel: () => setModal(null), onConfirm: saveCreate, extra: /* @__PURE__ */ React.createElement("div", { style: { ...stack, width: "100%" } }, /* @__PURE__ */ React.createElement(Tabs, { items: ["\u624B\u52A8\u521B\u5EFA", "\u94FE\u63A5\u5BFC\u5165", "\u6587\u4EF6\u5939\u5BFC\u5165"], value: method, onChange: (value) => {
        setMethod(value);
        setError("");
      } }), method === 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Field, { label: "\u540D\u79F0" }, /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u6280\u80FD\u540D\u79F0", maxLength: 60, value: draft.name, onChange: (event) => setDraft({ ...draft, name: event.target.value }) })), /* @__PURE__ */ React.createElement(Field, { label: "\u7B80\u4ECB" }, /* @__PURE__ */ React.createElement(Textarea, { "aria-label": "\u6280\u80FD\u7B80\u4ECB", placeholder: "\u63CF\u8FF0\u6280\u80FD\u8981\u5B8C\u6210\u7684\u5DE5\u4F5C", value: draft.description, onChange: (event) => setDraft({ ...draft, description: event.target.value }) }))) : method === 1 ? /* @__PURE__ */ React.createElement(Field, { label: "\u6280\u80FD\u94FE\u63A5" }, /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u6280\u80FD\u94FE\u63A5", placeholder: "https://", value: draft.url, onChange: (event) => setDraft({ ...draft, url: event.target.value }) })) : /* @__PURE__ */ React.createElement("p", null, "\u9009\u62E9\u5305\u542B SKILL.md \u7684\u6280\u80FD\u6587\u4EF6\u5939\u3002"), error && /* @__PURE__ */ React.createElement("p", { role: "alert" }, error)) }));
    }
    window.CapabilitySkills = CapabilitySkills;
  })();
})();
