/* Generated from components/composer/composer.card.demo.jsx by tools/build.cjs. */
(() => {
  const { Composer, Button } = window.CogSeedDesignSystem_f581b5;
  const { ComposerStatesPreview } = window;
  const SECTIONS = [["scenes", "\u9996\u9875\u4E0E\u5BF9\u8BDD"], ["automation", "\u81EA\u52A8\u5316\u8868\u5355"], ["base", "\u57FA\u7840\u5165\u53E3\u4E0E\u5BBD\u5EA6"], ["spaces", "\u5DE5\u4F5C\u7A7A\u95F4\u9009\u62E9"], ["sending", "\u53D1\u9001\u4E0E\u6392\u961F"], ["attachments", "\u9644\u4EF6"], ["voice", "\u8BED\u97F3"], ["editing", "\u6B63\u6587\u7F16\u8F91"], ["blocked", "\u4E0D\u53EF\u53D1\u9001"]];
  function SceneExample({ placement }) {
    const [value, setValue] = React.useState("");
    return /* @__PURE__ */ React.createElement("div", { className: "cs-scene-example" }, /* @__PURE__ */ React.createElement("h3", null, placement === "home" ? "\u65B0\u5EFA\u4EFB\u52A1\u9996\u9875" : "\u5DF2\u6709\u5BF9\u8BDD"), /* @__PURE__ */ React.createElement("p", { className: "cs-state-rule" }, placement === "home" ? "\u6B63\u6587\u9ED8\u8BA4\u6700\u5C0F 80px\uFF0C\u6700\u9AD8 260px\u3002" : "\u6B63\u6587\u9ED8\u8BA4\u6700\u5C0F 64px\uFF0C\u6700\u9AD8 200px\u3002", "\u5E95\u680F\u3001\u9644\u4EF6\u548C\u5F15\u7528\u53E6\u8BA1\u9AD8\u5EA6\u3002", placement === "home" ? "\u9996\u9875\u4E0D\u663E\u793A\u8BBF\u95EE\u6743\u9650\u5165\u53E3\u3002" : "\u8BBF\u95EE\u6743\u9650\u6CBF\u7528\u5F53\u524D\u4F1A\u8BDD\u8BBE\u7F6E\u3002"), /* @__PURE__ */ React.createElement(Composer, { placement, value, onChange: setValue, onSend: () => setValue(""), contextTags: [{ label: "@ \u9879\u76EE\u52A9\u7406" }] }));
  }
  function Demo() {
    const [active, setActive] = React.useState("scenes");
    React.useEffect(() => {
      let frame = 0;
      const update = () => {
        frame = 0;
        let current = SECTIONS[0][0];
        for (const [id] of SECTIONS) {
          if (document.getElementById(id)?.getBoundingClientRect().top <= 120) current = id;
        }
        setActive(current);
      };
      const scroll = () => {
        if (!frame) frame = requestAnimationFrame(update);
      };
      window.addEventListener("scroll", scroll, { passive: true });
      const initial = requestAnimationFrame(() => {
        const id = location.hash.slice(1);
        if (SECTIONS.some(([key]) => key === id)) document.getElementById(id)?.scrollIntoView();
        update();
      });
      return () => {
        window.removeEventListener("scroll", scroll);
        cancelAnimationFrame(frame);
        cancelAnimationFrame(initial);
      };
    }, []);
    const [autoText, setAutoText] = React.useState(""), [autoRefs, setAutoRefs] = React.useState([]);
    const [txt, setTxt] = React.useState("");
    const [effort, setEffort] = React.useState("\u81EA\u52A8");
    const [space, setSpace] = React.useState(true);
    const [empty, setEmpty] = React.useState(false);
    const [previewWidth, setPreviewWidth] = React.useState(900);
    const [revision, setRevision] = React.useState(0);
    const reset = () => {
      setTxt("");
      setRevision((v) => v + 1);
    };
    return /* @__PURE__ */ React.createElement("div", { className: "cs-composer-review-layout" }, /* @__PURE__ */ React.createElement("aside", { className: "cs-composer-review-nav" }, /* @__PURE__ */ React.createElement("div", { className: "cs-review-nav-title" }, "\u8F93\u5165\u53F0 \xB7 \u5FEB\u901F\u5B9A\u4F4D"), /* @__PURE__ */ React.createElement("nav", { "aria-label": "\u8F93\u5165\u53F0\u72B6\u6001\u76EE\u5F55" }, SECTIONS.map(([id, label]) => /* @__PURE__ */ React.createElement("a", { key: id, href: "#" + id, "aria-current": active === id ? "location" : void 0 }, label)))), /* @__PURE__ */ React.createElement("main", { className: "cs-state-gallery" }, /* @__PURE__ */ React.createElement("h1", null, "\u8F93\u5165\u53F0"), /* @__PURE__ */ React.createElement("section", { id: "scenes" }, /* @__PURE__ */ React.createElement("h2", { className: "cs-state-group-title" }, "\u9996\u9875\u4E0E\u5BF9\u8BDD"), /* @__PURE__ */ React.createElement(SceneExample, { placement: "home" }), /* @__PURE__ */ React.createElement(SceneExample, { placement: "conversation" })), /* @__PURE__ */ React.createElement("section", { id: "automation", className: "cs-state-group" }, /* @__PURE__ */ React.createElement("h2", { className: "cs-state-group-title" }, "\u81EA\u52A8\u5316\u8868\u5355"), /* @__PURE__ */ React.createElement("p", { className: "cs-state-rule" }, "\u4EC5\u6B63\u6587\u3001\u9644\u4EF6\u4E0E @ \u5165\u53E3\u3002Enter \u6362\u884C\uFF0C\u8868\u5355\u5E95\u90E8\u521B\u5EFA\u52A8\u4F5C\u63D0\u4EA4\uFF1B\u5F15\u7528\u7531\u5BBF\u4E3B\u4FDD\u5B58\u5E76\u5728\u7F16\u8F91\u65F6\u6062\u590D\u3002"), /* @__PURE__ */ React.createElement(
      Composer,
      {
        placement: "automation",
        value: autoText,
        onChange: setAutoText,
        selectedMentions: autoRefs,
        onMentionsChange: setAutoRefs,
        placeholder: "\u8F93\u5165 @ \u9009\u62E9\u667A\u80FD\u4F53\u3001\u6280\u80FD\u3001\u8FDE\u63A5\u5668\u6216\u8D44\u6599\u5E93\u6587\u4EF6",
        mentionItems: [
          { id: "default", kind: "agent", name: "cogseed" },
          { id: "summary", kind: "skill", name: "\u5DE5\u4F5C\u603B\u7ED3" },
          { id: "calendar", kind: "connector", name: "\u65E5\u5386" },
          { id: "guide", kind: "library", name: "\u5DE5\u4F5C\u6D41\u7A0B.pdf" }
        ]
      }
    )), /* @__PURE__ */ React.createElement("section", { id: "base", className: "cs-state-group" }, /* @__PURE__ */ React.createElement("h2", { className: "cs-state-group-title" }, "\u57FA\u7840\u5165\u53E3\u4E0E\u5BBD\u5EA6"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "var(--cs-space-2)", flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: !space ? "primary" : "secondary", "aria-pressed": !space, onClick: () => {
      setSpace(false);
      reset();
    } }, "\u666E\u901A\u4EFB\u52A1"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: space ? "primary" : "secondary", "aria-pressed": space, onClick: () => {
      setSpace(true);
      reset();
    } }, "\u7A7A\u95F4\u4EFB\u52A1"), /* @__PURE__ */ React.createElement(Button, { size: "sm", "aria-pressed": empty, onClick: () => {
      setEmpty((v) => !v);
      reset();
    } }, empty ? "\u6062\u590D\u5185\u5BB9" : "\u67E5\u770B\u7A7A\u5217\u8868")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "var(--cs-space-2)", marginTop: "var(--cs-space-3)" } }, [480, 720, 900].map((w) => /* @__PURE__ */ React.createElement(Button, { key: w, size: "sm", "aria-pressed": previewWidth === w, variant: previewWidth === w ? "primary" : "secondary", onClick: () => setPreviewWidth(w) }, w, "px"))), /* @__PURE__ */ React.createElement("div", { style: { paddingTop: "var(--cs-space-3)" } }, /* @__PURE__ */ React.createElement(
      Composer,
      {
        width: "min(" + previewWidth + "px, 100%)",
        key: revision,
        value: txt,
        onChange: setTxt,
        reasoningEffort: effort,
        onReasoningEffortChange: setEffort,
        spaceBound: space,
        onSpaceChange: (id) => setSpace(Boolean(id)),
        mentionItems: empty ? [] : void 0,
        onSend: () => setTxt(""),
        contextTags: [{ label: "@ \u9879\u76EE\u52A9\u7406", selected: true }, ...space ? [{ label: "\u534E\u4E1C\u56E2\u961F\u7A7A\u95F4" }] : []]
      }
    ))), /* @__PURE__ */ React.createElement("section", { id: "spaces", className: "cs-state-group" }, /* @__PURE__ */ React.createElement("h2", { className: "cs-state-group-title" }, "\u5DE5\u4F5C\u7A7A\u95F4\u9009\u62E9"), /* @__PURE__ */ React.createElement("p", { className: "cs-state-rule" }, "\u70B9\u51FB\u5165\u53E3\u53EF\u641C\u7D22\u5E76\u5207\u6362\u5DE5\u4F5C\u7A7A\u95F4\uFF1B\u5F53\u524D\u7A7A\u95F4\u4EC5\u7528\u5BF9\u52FE\u8868\u793A\u3002\u9ED8\u8BA4\u5DE5\u4F5C\u533A\u4E0D\u7ED1\u5B9A\u7A7A\u95F4\uFF0C@ \u5206\u7C7B\u968F\u4E4B\u53D8\u5316\uFF1B\u5207\u6362\u4E0D\u81EA\u52A8\u6E05\u7A7A\u65E2\u6709\u5F15\u7528\u3002"), /* @__PURE__ */ React.createElement("div", { style: { paddingTop: "var(--cs-space-3)" } }, /* @__PURE__ */ React.createElement(Composer, { spaceBound: true, contextTags: [{ label: "@ \u9879\u76EE\u52A9\u7406" }, { label: "\u534E\u4E1C\u56E2\u961F\u7A7A\u95F4" }] }))), /* @__PURE__ */ React.createElement("section", { className: "cs-state-group" }, /* @__PURE__ */ React.createElement("h2", { className: "cs-state-group-title" }, "\u6267\u884C\u914D\u7F6E\u80FD\u529B\u9650\u5236"), /* @__PURE__ */ React.createElement(Composer, { modelName: "\u667A\u80FD\u4F53\u5F53\u524D\u6A21\u578B", providerName: "\u5916\u63A5\u667A\u80FD\u4F53", modelSupported: false, effortSupported: false })), /* @__PURE__ */ React.createElement(ComposerStatesPreview, null)));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(Demo, null));
})();
