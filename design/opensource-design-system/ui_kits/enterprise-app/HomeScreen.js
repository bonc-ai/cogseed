/* Generated from ui_kits/enterprise-app/HomeScreen.jsx by tools/build.cjs. */
(() => {
  const { PageFrame, PageHeader, PageScroll, ContinueWorkDialog } = window;
  const { Composer, Button } = window.CogSeedDesignSystem_f581b5;
  const HOME_SCENARIOS = [
    { label: "\u6DF1\u5EA6\u7814\u7A76", agent: "DeepResearcher", template: "\u6DF1\u5EA6\u7814\u7A76 [\u4E3B\u9898]\uFF1A\u6536\u96C6\u8D44\u6599\uFF0C\u6309\u5173\u952E\u7EF4\u5EA6\u5BF9\u6BD4\u8BC1\u636E\uFF0C\u6807\u51FA\u6765\u6E90\u94FE\u63A5\uFF0C\u6700\u540E\u7ED9\u7ED3\u8BBA\u548C\u53EF\u6267\u884C\u5EFA\u8BAE" },
    { label: "UI \u8BBE\u8BA1", agent: "UIDesigner", template: "\u5E2E\u6211\u8BBE\u8BA1 [\u9875\u9762/\u4EA7\u54C1/\u6D41\u7A0B] \u7684 UI\uFF1A\u5148\u660E\u786E\u5E03\u5C40\u3001\u89C6\u89C9\u65B9\u5411\u3001\u7EC4\u4EF6\u72B6\u6001\u548C\u54CD\u5E94\u5F0F\u65B9\u6848\uFF0C\u518D\u7ED9\u51FA\u9ED8\u8BA4 HTML \u8BBE\u8BA1\u7A3F" },
    { label: "AI/\u641C\u7D22\u66DD\u5149", agent: "SeoGeoAgent", template: "\u5E2E\u6211\u5206\u6790 [\u7F51\u7AD9/\u9875\u9762 URL] \u7684 SEO \u548C GEO\uFF1A\u6293\u53D6\u9875\u9762\uFF0C\u8BCA\u65AD\u6280\u672F\u3001\u5185\u5BB9\u548C\u7ED3\u6784\u5316\u6570\u636E\u95EE\u9898\uFF0C\u627E\u589E\u957F\u673A\u4F1A\u5E76\u8F93\u51FA\u884C\u52A8\u8BA1\u5212" },
    { label: "\u6574\u7406\u6587\u6863", agent: "OfficeWriter", template: "\u5E2E\u6211\u6574\u7406 [\u6750\u6599/\u6587\u4EF6]\uFF1A\u63D0\u53D6\u91CD\u70B9\u3001\u7406\u6E05\u7ED3\u6784\uFF0C\u6574\u7406\u6210\u53EF\u4EA4\u4ED8\u7684\u6587\u6863\u3001\u8868\u683C\u3001\u6F14\u793A\u6216 PDF \u7248\u672C" },
    { label: "\u5F00\u53D1\u8F6F\u4EF6", agent: "ProductDeveloper", template: "\u5E2E\u6211\u5F00\u53D1 [\u5E94\u7528/\u529F\u80FD]\uFF1A\u5148\u786E\u8BA4\u9700\u6C42\u548C\u8FB9\u754C\uFF0C\u518D\u8BBE\u8BA1\u65B9\u6848\u3001\u5B9E\u73B0\u4EE3\u7801\u3001\u8DD1\u6D4B\u8BD5\uFF0C\u5E76\u544A\u8BC9\u6211\u600E\u4E48\u9A8C\u6536" }
  ];
  const SUGGESTIONS = ["\u7A7A\u95F4\u6A21\u5F0F", "\u7EE7\u7EED\u4E4B\u524D\u7684\u5DE5\u4F5C", ...HOME_SCENARIOS.map((s) => s.label)];
  function HomeScreen({ collapsed, onExpand, onOpenTask, onSubmit, onConnectAgent, spaces = [] }) {
    const [txt, setTxt] = React.useState(""), [effort, setEffort] = React.useState("\u81EA\u52A8"), [recipient, setRecipient] = React.useState({ id: "cogseed", name: "cogseed", kind: "agent" }), [spaceId, setSpaceId] = React.useState("");
    const [continueOpen, setContinueOpen] = React.useState(false), [selection, setSelection] = React.useState(null), [hour, setHour] = React.useState(() => (/* @__PURE__ */ new Date()).getHours());
    React.useEffect(() => {
      const timer = setInterval(() => setHour((/* @__PURE__ */ new Date()).getHours()), 6e4);
      return () => clearInterval(timer);
    }, []);
    const greeting = hour < 6 ? "\u8D77\u5F97\u771F\u65E9" : hour < 12 ? "\u65E9\u4E0A\u597D" : hour < 18 ? "\u4E0B\u5348\u597D" : "\u665A\u4E0A\u597D";
    function choose(s) {
      setTxt(s.template);
      setRecipient({ id: s.agent, name: s.agent, kind: "agent" });
      const match = /\[[^\]]+\]/.exec(s.template);
      setSelection({ start: match.index, end: match.index + match[0].length, revision: Date.now() });
    }
    function submit() {
      if (!txt.trim()) return;
      onSubmit({ title: txt.trim(), agentName: recipient?.name || "cogseed", content: "empty", initialMessage: txt.trim(), spaceId });
      setTxt("");
    }
    return /* @__PURE__ */ React.createElement(PageFrame, { className: "cs-home", home: true }, /* @__PURE__ */ React.createElement(PageHeader, { collapsed, onExpand, style: { borderBottom: 0 } }), /* @__PURE__ */ React.createElement(PageScroll, { className: "cs-home-scroll" }, /* @__PURE__ */ React.createElement("div", { className: "cs-home-content" }, /* @__PURE__ */ React.createElement("h1", { className: "cs-home-greeting" }, greeting, "\uFF0C\u670B\u53CB"), /* @__PURE__ */ React.createElement("div", { className: "cs-brand-composer" }, /* @__PURE__ */ React.createElement("img", { className: "cs-brand-mascot", src: "../../assets/brand/cogseed-squirrel-perch.png", alt: "", draggable: "false" }), /* @__PURE__ */ React.createElement(
      Composer,
      {
        placement: "home",
        value: txt,
        onChange: setTxt,
        placeholder: "\u8F93\u5165 @ \u9009\u62E9\u667A\u80FD\u4F53\u3001\u6280\u80FD",
        recipient,
        onRecipientChange: setRecipient,
        editorSelection: selection,
        reasoningEffort: effort,
        onReasoningEffortChange: setEffort,
        spaceOptions: spaces.map((s) => ({ id: s.id, name: s.name })),
        spaceId,
        onSpaceChange: setSpaceId,
        onSend: submit,
        contextTags: [{ label: `@ ${recipient?.name || "cogseed"}`, selected: true }]
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "cs-home-suggestions" }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => onOpenTask({ title: "\u7A7A\u95F4\u6A21\u5F0F", agentName: "\u7A7A\u95F4\u6784\u5EFA\u5E08", content: "empty" }) }, "\u7A7A\u95F4\u6A21\u5F0F"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setContinueOpen(true) }, "\u7EE7\u7EED\u4E4B\u524D\u7684\u5DE5\u4F5C"), HOME_SCENARIOS.map((s) => /* @__PURE__ */ React.createElement(Button, { key: s.label, variant: "ghost", size: "sm", onClick: () => choose(s) }, s.label))))), continueOpen ? /* @__PURE__ */ React.createElement(ContinueWorkDialog, { onClose: () => setContinueOpen(false), onOpenTask }) : null);
  }
  Object.assign(window, { HomeScreen, SUGGESTIONS, HOME_SCENARIOS });
})();
