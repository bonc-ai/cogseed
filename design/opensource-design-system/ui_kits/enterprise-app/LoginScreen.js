/* Generated from ui_kits/enterprise-app/LoginScreen.jsx by tools/build.cjs. */
(() => {
  const { PageFrame, PageHeader } = window;
  const { Button } = window.CogSeedDesignSystem_f581b5;
  function LoginScreen({ onLogin }) {
    return /* @__PURE__ */ React.createElement(PageFrame, null, /* @__PURE__ */ React.createElement(PageHeader, { windowControls: true, style: { borderBottom: 0, padding: "0 var(--cs-space-4)" } }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "var(--cs-space-6)", paddingBottom: "var(--cs-titlebar-height)" } }, /* @__PURE__ */ React.createElement("img", { src: "../../assets/brand/logo.png", width: "64", height: "64", alt: "", draggable: "false" }), /* @__PURE__ */ React.createElement("h1", { style: { margin: 0, font: "400 32px/1.2 var(--cs-font-sans)", letterSpacing: "-.02em" } }, "CogSeed"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", size: "login", onClick: onLogin }, "\u767B\u5F55")));
  }
  Object.assign(window, { LoginScreen });
})();
