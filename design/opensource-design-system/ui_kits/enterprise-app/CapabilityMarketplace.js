/* Generated from ui_kits/enterprise-app/CapabilityMarketplace.jsx by tools/build.cjs. */
(() => {
  (function() {
    const { ResourceCard, CardGrid, Input, Select, Tabs, Button, StatusDot, EmptyState } = window.CogSeedDesignSystem_f581b5;
    const kinds = ["agent", "skill", "open"];
    const labels = { agent: "\u667A\u80FD\u4F53", skill: "\u6280\u80FD", open: "\u5F00\u6E90\u9879\u76EE" };
    const entries = [
      { id: "market-credit-agent", kind: "agent", name: "\u9879\u76EE\u6750\u6599\u5BA1\u9605", category: "\u4E1A\u52A1", description: "\u68B3\u7406\u9879\u76EE\u6750\u6599\u3001\u8BC6\u522B\u5F85\u8865\u5145\u4E8B\u9879\u5E76\u6574\u7406\u590D\u6838\u4F9D\u636E\u3002", file: "AGENT.md", body: "# \u9879\u76EE\u6750\u6599\u5BA1\u9605\n\n\u5148\u786E\u8BA4\u6750\u6599\u8303\u56F4\uFF0C\u518D\u6838\u9A8C\u4E00\u81F4\u6027\u5E76\u8F93\u51FA\u5F85\u786E\u8BA4\u95EE\u9898\u3002\n\n\u4EA4\u4ED8\uFF1A\u6750\u6599\u76EE\u5F55\u3001\u5F02\u5E38\u6E05\u5355\u3001\u6765\u6E90\u5F15\u7528\u3002\n\u6280\u80FD\uFF1A\u6587\u6863\u6458\u8981\u3001\u9879\u76EE\u62A5\u544A\u53E3\u5F84\u6838\u9A8C\u3002" },
      { id: "market-report-agent", kind: "agent", name: "\u8FDB\u5C55\u7B80\u62A5\u7F16\u5199", category: "\u6587\u6863\u5904\u7406", description: "\u6C47\u603B\u7ECF\u8425\u6570\u636E\u4E0E\u4E1A\u52A1\u8BF4\u660E\uFF0C\u5F62\u6210\u6709\u6765\u6E90\u4F9D\u636E\u7684\u7B80\u62A5\u3002", file: "AGENT.md", body: "# \u8FDB\u5C55\u7B80\u62A5\u7F16\u5199\n\n\u786E\u8BA4\u7EDF\u8BA1\u671F\u95F4\u4E0E\u53E3\u5F84\uFF0C\u6574\u7406\u53D8\u5316\u539F\u56E0\u548C\u5F85\u6838\u9A8C\u4E8B\u9879\u3002" },
      { id: "meeting-notes", kind: "skill", name: "\u4F1A\u8BAE\u7EAA\u8981", category: "\u6587\u6863\u5904\u7406", description: "\u5C06\u4F1A\u8BAE\u6750\u6599\u6574\u7406\u4E3A\u8BAE\u9898\u3001\u51B3\u5B9A\u4E0E\u884C\u52A8\u6E05\u5355\u3002", file: "SKILL.md", body: "# \u4F1A\u8BAE\u7EAA\u8981\n\n\u9010\u9879\u8BB0\u5F55\u51B3\u5B9A\u3001\u8D23\u4EFB\u4EBA\u548C\u622A\u6B62\u65F6\u95F4\uFF0C\u4FDD\u7559\u5C1A\u672A\u786E\u5B9A\u7684\u4E8B\u9879\u3002" },
      { id: "data-validation", kind: "skill", name: "\u6570\u636E\u8D28\u91CF\u6838\u9A8C", category: "\u6570\u636E\u5206\u6790", description: "\u68C0\u67E5\u7F3A\u5931\u503C\u3001\u91CD\u590D\u8BB0\u5F55\u548C\u6C47\u603B\u53E3\u5F84\u3002", file: "SKILL.md", body: "# \u6570\u636E\u8D28\u91CF\u6838\u9A8C\n\n\u68C0\u67E5\u6570\u636E\u5B8C\u6574\u6027\u4E0E\u4E00\u81F4\u6027\uFF0C\u8F93\u51FA\u5F02\u5E38\u6E05\u5355\u53CA\u6765\u6E90\u3002" },
      { id: "open-document-tools", kind: "open", name: "\u6587\u6863\u8F6C\u6362\u5DE5\u5177", category: "\u6587\u6863\u5904\u7406", description: "\u7528\u4E8E\u5E38\u89C1\u529E\u516C\u6587\u6863\u683C\u5F0F\u8F6C\u6362\u7684\u5F00\u6E90\u5DE5\u5177\u96C6\u5408\u3002", file: "README.md", body: "# \u6587\u6863\u8F6C\u6362\u5DE5\u5177\n\n\u5B89\u88C5\u524D\u9700\u786E\u8BA4\u8FD0\u884C\u73AF\u5883\u3001\u4F9D\u8D56\u4E0E\u8BB8\u53EF\u8BC1\u3002\n\n\u5305\u542B\uFF1A\u6587\u672C\u63D0\u53D6\u3001\u6587\u6863\u8F6C\u6362\u4E0E\u8868\u683C\u6574\u7406\u3002" },
      { id: "open-data-tools", kind: "open", name: "\u6570\u636E\u6574\u7406\u5DE5\u5177", category: "\u6570\u636E\u5206\u6790", description: "\u7528\u4E8E\u6E05\u6D17\u8868\u683C\u3001\u68C0\u67E5\u91CD\u590D\u6570\u636E\u4E0E\u751F\u6210\u7EDF\u8BA1\u6458\u8981\u3002", file: "README.md", body: "# \u6570\u636E\u6574\u7406\u5DE5\u5177\n\n\u786E\u8BA4\u6570\u636E\u8303\u56F4\u540E\u6267\u884C\u6E05\u6D17\uFF0C\u4FDD\u7559\u539F\u59CB\u6587\u4EF6\u548C\u5904\u7406\u8BB0\u5F55\u3002" }
    ];
    function CapabilityMarketplace({ kind = "agent", selectedId, onSelect, onBack, onKindChange }) {
      const [active, setActive] = React.useState(kinds.includes(kind) ? kind : "agent");
      const [localId, setLocalId] = React.useState(null), [query, setQuery] = React.useState(""), [category, setCategory] = React.useState("\u5168\u90E8"), [notice, setNotice] = React.useState("");
      const id = selectedId === void 0 ? localId : selectedId;
      const current = entries.find((item) => item.id === id);
      React.useEffect(() => {
        setActive(kinds.includes(kind) ? kind : "agent");
      }, [kind]);
      React.useEffect(() => {
        if (current) setActive(current.kind);
        setNotice("");
      }, [id]);
      const select = (value) => {
        if (onSelect) onSelect(value);
        if (selectedId === void 0) setLocalId(value);
        setNotice("");
      };
      const changeKind = (index) => {
        const next = kinds[index];
        select(null);
        setActive(next);
        setQuery("");
        setCategory("\u5168\u90E8");
        onKindChange?.(next);
      };
      const visible = entries.filter((item) => item.kind === active && (category === "\u5168\u90E8" || item.category === category) && `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
      const categories = ["\u5168\u90E8", ...new Set(entries.filter((item) => item.kind === active).map((item) => item.category))];
      return /* @__PURE__ */ React.createElement("section", { style: { display: "grid", gap: "var(--cs-space-4)" }, "aria-label": "\u80FD\u529B\u5E02\u573A" }, /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-toolbar" }, /* @__PURE__ */ React.createElement(Button, { onClick: () => id ? select(null) : onBack?.() }, id ? "\u8FD4\u56DE\u5E02\u573A" : `\u8FD4\u56DE${labels[kind] || "\u80FD\u529B"}`), /* @__PURE__ */ React.createElement("h2", { style: { font: "var(--cs-type-title)", margin: 0 } }, current?.name || "\u5E02\u573A")), /* @__PURE__ */ React.createElement(Tabs, { ariaLabel: "\u5E02\u573A\u8D44\u6E90\u7C7B\u578B", items: kinds.map((value) => labels[value]), value: kinds.indexOf(active), onChange: changeKind }), notice && /* @__PURE__ */ React.createElement("p", { role: "alert", className: "cs-resource-page-notice" }, notice), id ? current ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, current.description), /* @__PURE__ */ React.createElement(StatusDot, { tone: "idle", label: `${labels[current.kind]} \xB7 ${current.category}` }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h3", { style: { font: "var(--cs-type-title)" } }, current.file), /* @__PURE__ */ React.createElement("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "var(--cs-type-body)" } }, current.body)), /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-toolbar" }, /* @__PURE__ */ React.createElement(Button, { onClick: () => setNotice("\u5C1A\u672A\u8FDE\u63A5\u5E02\u573A\u5B89\u88C5\u670D\u52A1\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002") }, "\u5B89\u88C5", labels[current.kind]))) : /* @__PURE__ */ React.createElement(EmptyState, { title: "\u8D44\u6E90\u4E0D\u5B58\u5728", reason: "\u8BE5\u8D44\u6E90\u53EF\u80FD\u5DF2\u4E0B\u67B6\uFF0C\u8BF7\u8FD4\u56DE\u5E02\u573A\u91CD\u65B0\u9009\u62E9\u3002", action: "\u8FD4\u56DE\u5E02\u573A", onAction: () => select(null) }) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-toolbar" }, /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u641C\u7D22\u5E02\u573A\u8D44\u6E90", icon: "search", placeholder: "\u641C\u7D22\u540D\u79F0\u6216\u7B80\u4ECB", value: query, onChange: (event) => setQuery(event.target.value) }), /* @__PURE__ */ React.createElement(Select, { "aria-label": "\u5E02\u573A\u8D44\u6E90\u5206\u7C7B", options: categories, value: category, onChange: setCategory })), visible.length ? /* @__PURE__ */ React.createElement(CardGrid, null, visible.map((item) => /* @__PURE__ */ React.createElement(ResourceCard, { key: item.id, variant: "capability", title: item.name, icon: "fileText", description: item.description, status: /* @__PURE__ */ React.createElement(StatusDot, { tone: "idle", label: item.category }), action: "\u67E5\u770B\u8BE6\u60C5", onAction: () => select(item.id) }))) : /* @__PURE__ */ React.createElement(EmptyState, { title: "\u6CA1\u6709\u5339\u914D\u7684\u8D44\u6E90", action: "\u6E05\u9664\u7B5B\u9009", onAction: () => {
        setQuery("");
        setCategory("\u5168\u90E8");
      } })));
    }
    window.CapabilityMarketplace = CapabilityMarketplace;
  })();
})();
