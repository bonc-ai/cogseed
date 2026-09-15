/* Generated from components/composer/states.card.demo.jsx by tools/build.cjs. */
(() => {
  const { Composer, ComposerQueue, ComposerAttachments, ComposerVoice, ComposerNotice, ComposerRichDraft } = window.CogSeedDesignSystem_f581b5;
  const TAGS = [{ label: "@ \u9879\u76EE\u52A9\u7406", selected: true }, { label: "\u534E\u4E1C\u56E2\u961F\u7A7A\u95F4" }];
  const SAMPLE_FILES = [
    { id: "a", name: "\u9879\u76EE\u53F0\u8D26_2026Q3.xlsx", size: "1.2 MB", status: "ready" },
    { id: "b", name: "\u5BA2\u6237\u8D70\u8BBF\u7EAA\u8981.docx", size: "680 KB", status: "uploading" },
    { id: "c", name: "\u8D22\u52A1\u62A5\u8868.pdf", size: "3.4 MB", status: "ready" },
    { id: "d", name: "\u4EA4\u4ED8\u540E\u76D1\u6D4B\u8865\u5145\u8D44\u6599_\u534E\u4E1C\u56E2\u961F_2026\u5E74\u7B2C\u4E09\u5B63\u5EA6.docx", size: "820 KB", status: "ready" },
    { id: "e", name: "\u5BA2\u6237\u73B0\u573A\u8BB0\u5F55.mp4", size: "8.1 MB", status: "ready", video: true }
  ];
  function Example({ title, rule, children }) {
    return /* @__PURE__ */ React.createElement("section", { className: "cs-state-example" }, /* @__PURE__ */ React.createElement("h2", null, title), /* @__PURE__ */ React.createElement("div", { className: "cs-state-stage" }, children));
  }
  function Draft({ initial = "", phase = "idle", notice, sendAllowed, inputDisabled, ...rest }) {
    const [value, setValue] = React.useState(initial), [feedback, setFeedback] = React.useState(""), [effort, setEffort] = React.useState("\u81EA\u52A8");
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
      Composer,
      {
        value,
        onChange: setValue,
        phase,
        sendAllowed,
        inputDisabled,
        contextTags: TAGS,
        spaceBound: true,
        reasoningEffort: effort,
        onReasoningEffortChange: setEffort,
        onSend: () => {
          setValue("");
          setFeedback("\u6D88\u606F\u5DF2\u53D1\u9001");
        },
        onStop: () => setFeedback("\u5DF2\u53D1\u51FA\u505C\u6B62\u8BF7\u6C42"),
        onQueue: () => {
          setValue("");
          setFeedback("\u6D88\u606F\u5DF2\u52A0\u5165\u961F\u5217");
        },
        afterInput: notice && /* @__PURE__ */ React.createElement(ComposerNotice, { message: notice }),
        ...rest
      }
    ), feedback && /* @__PURE__ */ React.createElement("p", { className: "cs-state-feedback", role: "status" }, feedback));
  }
  function QueueExample({ editing = false }) {
    const [items, setItems] = React.useState([{ id: "q1", text: "\u8BF7\u6309\u56E2\u961F\u6C47\u603B\u5230\u671F\u5BA2\u6237\u3002" }, { id: "q2", text: "\u518D\u8865\u5145\u672A\u6765 30 \u5929\u7684\u63D0\u9192\u6E05\u5355\u3002" }]);
    const [text, setText] = React.useState("\u8BF7\u540C\u65F6\u6807\u6CE8\u7F3A\u5931\u6750\u6599\u3002");
    const [running, setRunning] = React.useState(true), [status, setStatus] = React.useState("\u6B63\u5728\u6267\u884C \xB7 \u70B9\u51FB\u505C\u6B62\u56DE\u590D\uFF0CEnter \u5C06\u6587\u5B57\u52A0\u5165\u961F\u5217");
    const stop = () => {
      const next = items[0];
      if (next) {
        setItems(items.slice(1));
        setStatus("\u5F53\u524D\u56DE\u590D\u5DF2\u505C\u6B62\uFF0C\u6B63\u5728\u5904\u7406\uFF1A" + next.text);
      } else {
        setRunning(false);
        setStatus("\u5F53\u524D\u56DE\u590D\u5DF2\u505C\u6B62\u3002");
      }
    };
    return /* @__PURE__ */ React.createElement("div", { className: "cs-queue-composition" }, /* @__PURE__ */ React.createElement(ComposerQueue, { items, onChange: setItems, initialEditingId: editing ? "q1" : null }), /* @__PURE__ */ React.createElement(
      Composer,
      {
        value: text,
        onChange: setText,
        contextTags: TAGS,
        phase: running ? "running" : "idle",
        onStop: stop,
        onSend: () => setText(""),
        onQueue: () => {
          setItems((v) => [...v, { id: "q-" + Date.now(), text }]);
          setText("");
        },
        afterInput: /* @__PURE__ */ React.createElement(ComposerNotice, { message: status })
      }
    ));
  }
  function Sending() {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Example, { title: "01 \u7A7A\u767D\uFF0F\u53EF\u53D1\u9001" }, /* @__PURE__ */ React.createElement(Draft, null), /* @__PURE__ */ React.createElement("div", { className: "cs-state-gap" }), /* @__PURE__ */ React.createElement(Draft, { initial: "\u8BF7\u6838\u5BF9\u8FD9\u4EFD\u9879\u76EE\u6750\u6599\u3002" })), /* @__PURE__ */ React.createElement(Example, { title: "02 \u9996\u9875\u63D0\u4EA4\u4E2D" }, /* @__PURE__ */ React.createElement(Draft, { placement: "home", initial: "\u8BF7\u6838\u5BF9\u8FD9\u4EFD\u9879\u76EE\u6750\u6599\u3002", phase: "submitting", notice: "\u6B63\u5728\u63D0\u4EA4\u6D88\u606F\u2026" })), /* @__PURE__ */ React.createElement(Example, { title: "03 \u6267\u884C\u4E2D" }, /* @__PURE__ */ React.createElement(QueueExample, null)), /* @__PURE__ */ React.createElement(Example, { title: "04 \u505C\u6B62\u4E2D" }, /* @__PURE__ */ React.createElement(Draft, { phase: "stopping", notice: "\u6B63\u5728\u505C\u6B62\u56DE\u590D\u2026" })), /* @__PURE__ */ React.createElement(Example, { title: "05 \u961F\u5217\u7F16\u8F91" }, /* @__PURE__ */ React.createElement(QueueExample, { editing: true })));
  }
  function FilesExample({ initial, dragging = false }) {
    const [items, setItems] = React.useState(initial), [drag, setDrag] = React.useState(dragging);
    const add = (names) => setItems((v) => [...v, ...names.map((name, i) => ({ id: Date.now() + "-" + i, name, size: "\u5DF2\u5C31\u7EEA", status: "ready" }))]);
    const notice = items.some((i) => i.status === "uploading") ? "\u9644\u4EF6\u4ECD\u5728\u4E0A\u4F20\uFF0C\u5B8C\u6210\u540E\u53EF\u53D1\u9001\u3002" : void 0;
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        onDragOver: (e) => {
          e.preventDefault();
          setDrag(true);
        },
        onDragLeave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false);
        },
        onDrop: (e) => {
          e.preventDefault();
          setDrag(false);
          add(Array.from(e.dataTransfer.files).map((f) => f.name));
        },
        onPaste: (e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            add(Array.from(e.clipboardData.files).map((f) => f.name));
          }
        }
      },
      /* @__PURE__ */ React.createElement(
        Draft,
        {
          initial: "\u8BF7\u6838\u5BF9\u9644\u4EF6\u5185\u5BB9\u3002",
          sendAllowed: notice ? false : void 0,
          notice,
          onAttach: () => add(["\u8865\u5145\u6750\u6599.pdf"]),
          beforeInput: /* @__PURE__ */ React.createElement(ComposerAttachments, { items, dragging: drag, onRemove: (id) => setItems((v) => v.filter((i) => i.id !== id)) })
        }
      )
    );
  }
  function Attachments() {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Example, { title: "01 \u6DFB\u52A0\uFF0F\u62D6\u5165\uFF0F\u7C98\u8D34" }, /* @__PURE__ */ React.createElement(FilesExample, { initial: [], dragging: true })), /* @__PURE__ */ React.createElement(Example, { title: "02 \u4E0A\u4F20\u4E2D\uFF0F\u5C31\u7EEA" }, /* @__PURE__ */ React.createElement(FilesExample, { initial: SAMPLE_FILES.slice(0, 2) })), /* @__PURE__ */ React.createElement(Example, { title: "\u4E0A\u4F20\u5931\u8D25\u63D0\u793A" }, /* @__PURE__ */ React.createElement(Draft, { initial: "\u8BF7\u6838\u5BF9\u9644\u4EF6\u5185\u5BB9\u3002", beforeInput: /* @__PURE__ */ React.createElement(ComposerAttachments, { items: [SAMPLE_FILES[0]] }), afterInput: /* @__PURE__ */ React.createElement(ComposerNotice, { tone: "error", message: "\u8D22\u52A1\u62A5\u8868.pdf \u4E0A\u4F20\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u6DFB\u52A0\u3002" }) })), /* @__PURE__ */ React.createElement(Example, { title: "03 \u591A\u9644\u4EF6\u4E0E\u957F\u540D\u79F0" }, /* @__PURE__ */ React.createElement(FilesExample, { initial: SAMPLE_FILES.map((i) => ({ ...i, status: "ready" })) })), /* @__PURE__ */ React.createElement(Example, { title: "04 \u56FE\u7247\u9644\u4EF6" }, /* @__PURE__ */ React.createElement(FilesExample, { initial: [{ id: "scan", name: "\u6750\u6599\u626B\u63CF\u9875.png", size: "240 KB", status: "ready", thumbnail: "attachment-preview.svg" }] })));
  }
  function Recording({ state = "idle" }) {
    const [recording, setRecording] = React.useState(state === "recording");
    const [text, setText] = React.useState(state === "recording" ? "\u8BF7\u6574\u7406\u4ECA\u5929\u7684\u5BA2\u6237\u8D70\u8BBF\u8BB0\u5F55" : "");
    return /* @__PURE__ */ React.createElement(
      Composer,
      {
        value: text,
        onChange: setText,
        contextTags: TAGS,
        onSend: () => setText(""),
        voiceActive: recording,
        onVoice: () => {
          if (recording) setRecording(false);
          else {
            setRecording(true);
            setText("\u8BF7\u6574\u7406\u4ECA\u5929\u7684\u5BA2\u6237\u8D70\u8BBF\u8BB0\u5F55");
          }
        },
        voicePanel: recording ? /* @__PURE__ */ React.createElement(ComposerVoice, { onCancel: () => {
          setText("");
          setRecording(false);
        } }) : null
      }
    );
  }
  function Voice() {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Example, { title: "\u70B9\u51FB\u9EA6\u514B\u98CE\u5F00\u59CB" }, /* @__PURE__ */ React.createElement(Recording, null)), /* @__PURE__ */ React.createElement(Example, { title: "01 \u5F55\u97F3\u4E0E\u5B9E\u65F6\u8F6C\u5199" }, /* @__PURE__ */ React.createElement(Recording, { state: "recording" })), /* @__PURE__ */ React.createElement(Example, { title: "02 \u7ED3\u675F\u5F55\u97F3" }, /* @__PURE__ */ React.createElement(Recording, { state: "recording" })), /* @__PURE__ */ React.createElement(Example, { title: "03 \u8F6C\u5199\u5B8C\u6210" }, /* @__PURE__ */ React.createElement(Draft, { initial: "\u8BF7\u6574\u7406\u4ECA\u5929\u7684\u5BA2\u6237\u8D70\u8BBF\u8BB0\u5F55\uFF0C\u5E76\u5217\u51FA\u540E\u7EED\u5F85\u529E\u3002" })), /* @__PURE__ */ React.createElement(Example, { title: "04 \u9EA6\u514B\u98CE\u6743\u9650\u4E0D\u8DB3" }, /* @__PURE__ */ React.createElement(ComposerNotice, { tone: "error", message: "\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE\u3002\u8BF7\u5728\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u5141\u8BB8\u8BBF\u95EE\u540E\uFF0C\u518D\u70B9\u51FB\u9EA6\u514B\u98CE\u3002" })), /* @__PURE__ */ React.createElement(Example, { title: "05 \u672A\u68C0\u6D4B\u5230\u8BBE\u5907" }, /* @__PURE__ */ React.createElement(ComposerNotice, { tone: "error", message: "\u672A\u68C0\u6D4B\u5230\u9EA6\u514B\u98CE\u8BBE\u5907\uFF0C\u8BF7\u68C0\u67E5\u9EA6\u514B\u98CE\u662F\u5426\u8FDE\u63A5\u3002" })), /* @__PURE__ */ React.createElement(Example, { title: "06 \u53D6\u6D88\u540E\u7684\u7ED3\u679C" }, /* @__PURE__ */ React.createElement(Draft, null)));
  }
  function RichExample() {
    return /* @__PURE__ */ React.createElement(Draft, { sendAllowed: false, editor: /* @__PURE__ */ React.createElement(ComposerRichDraft, null) });
  }
  function Editing() {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Example, { title: "01 \u591A\u884C\u8F93\u5165" }, /* @__PURE__ */ React.createElement(Draft, { initial: "\u8BF7\u6838\u5BF9\u8FD9\u4EFD\u9879\u76EE\u6E05\u5355\u3002\n\u6309\u5BA2\u6237\u5217\u51FA\u7F3A\u5931\u6750\u6599\u3002\n\u6700\u540E\u7ED9\u51FA\u8865\u5145\u5EFA\u8BAE\u3002" })), /* @__PURE__ */ React.createElement(Example, { title: "02 \u8FBE\u5230\u6700\u5927\u9AD8\u5EA6" }, /* @__PURE__ */ React.createElement(Draft, { initial: Array.from({ length: 16 }, (_, i) => i + 1 + ". \u6838\u5BF9\u5BA2\u6237\u6750\u6599\u4E0E\u9879\u76EE\u5BA1\u67E5\u53E3\u5F84\uFF0C\u5217\u51FA\u9700\u8981\u8865\u5145\u7684\u4FE1\u606F\u3002").join("\n") })), /* @__PURE__ */ React.createElement(Example, { title: "03 \u6B63\u6587\u5185\u6280\u80FD\u6807\u7B7E" }, /* @__PURE__ */ React.createElement(RichExample, null)), /* @__PURE__ */ React.createElement(Example, { title: "04 \u6700\u5C0F\u5BBD\u5EA6" }, /* @__PURE__ */ React.createElement(Draft, { width: 480, initial: "\u8BF7\u6309\u56E2\u961F\u6574\u7406\u5BA2\u6237\u4FE1\u606F\u3002\n\u4FDD\u7559\u98CE\u9669\u4E8B\u9879\u548C\u540E\u7EED\u8DDF\u8FDB\u4EBA\u3002" })));
  }
  function Blocked() {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Example, { title: "01 \u9644\u4EF6\u4E0A\u4F20\u4E2D" }, /* @__PURE__ */ React.createElement(
      Draft,
      {
        initial: "\u8BF7\u5206\u6790\u8FD9\u4EFD\u6750\u6599\u3002",
        sendAllowed: false,
        beforeInput: /* @__PURE__ */ React.createElement(ComposerAttachments, { items: [SAMPLE_FILES[1]] }),
        afterInput: /* @__PURE__ */ React.createElement(ComposerNotice, { message: "\u9644\u4EF6\u4ECD\u5728\u4E0A\u4F20\uFF0C\u5B8C\u6210\u540E\u518D\u53D1\u9001\u3002" })
      }
    )), /* @__PURE__ */ React.createElement(Example, { title: "02 \u667A\u80FD\u4F53\u4E0D\u53EF\u7528" }, /* @__PURE__ */ React.createElement(
      Draft,
      {
        initial: "\u8BF7\u7EE7\u7EED\u6838\u5BF9\u6750\u6599\u3002",
        inputDisabled: true,
        afterInput: /* @__PURE__ */ React.createElement(ComposerNotice, { tone: "error", message: "\u5F53\u524D\u4F1A\u8BDD\u7ED1\u5B9A\u7684\u667A\u80FD\u4F53\u5DF2\u505C\u7528\uFF0C\u8BF7\u5728\u667A\u80FD\u4F53\u7BA1\u7406\u4E2D\u91CD\u65B0\u542F\u7528\uFF0C\u6216\u53E6\u5EFA\u4EFB\u52A1\u3002" })
      }
    )), /* @__PURE__ */ React.createElement(Example, { title: "03 \u5E26\u9644\u4EF6\u4E0D\u80FD\u6392\u961F" }, /* @__PURE__ */ React.createElement(
      Draft,
      {
        initial: "\u8BF7\u540C\u65F6\u67E5\u770B\u8865\u5145\u6750\u6599\u3002",
        phase: "running",
        sendAllowed: false,
        beforeInput: /* @__PURE__ */ React.createElement(ComposerAttachments, { items: [SAMPLE_FILES[0]] }),
        afterInput: /* @__PURE__ */ React.createElement(ComposerNotice, { message: "\u5E26\u9644\u4EF6\u7684\u6D88\u606F\u6682\u4E0D\u652F\u6301\u6392\u961F\uFF0C\u8BF7\u7B49\u5F85\u5F53\u524D\u56DE\u590D\u7ED3\u675F\u540E\u53D1\u9001\u3002" })
      }
    )), /* @__PURE__ */ React.createElement(Example, { title: "04 \u4EC5\u6709\u9644\u4EF6" }, /* @__PURE__ */ React.createElement(
      Draft,
      {
        sendAllowed: false,
        beforeInput: /* @__PURE__ */ React.createElement(ComposerAttachments, { items: [SAMPLE_FILES[0]] }),
        afterInput: /* @__PURE__ */ React.createElement(ComposerNotice, { message: "\u6DFB\u52A0\u4EFB\u52A1\u8BF4\u660E\u540E\u518D\u53D1\u9001\u3002" })
      }
    )), /* @__PURE__ */ React.createElement(Example, { title: "05 \u4EC5\u6709\u6D88\u606F\u5F15\u7528" }, /* @__PURE__ */ React.createElement(
      Draft,
      {
        sendAllowed: true,
        beforeInput: /* @__PURE__ */ React.createElement("div", { className: "cs-quote-sample" }, "\u5F15\u7528\u6D88\u606F \xB7 \u8BF7\u91CD\u70B9\u6838\u5BF9\u672A\u6765 30 \u5929\u5185\u5230\u671F\u7684\u9879\u76EE\u3002")
      }
    )));
  }
  function ComposerStatesPreview() {
    return /* @__PURE__ */ React.createElement("div", { className: "cs-state-sections" }, [[Sending, "sending", "01 \u53D1\u9001\u4E0E\u6392\u961F"], [Attachments, "attachments", "02 \u9644\u4EF6"], [Voice, "voice", "03 \u8BED\u97F3"], [Editing, "editing", "04 \u6B63\u6587\u7F16\u8F91"], [Blocked, "blocked", "05 \u4E0D\u53EF\u53D1\u9001"]].map(
      ([View, id, title]) => /* @__PURE__ */ React.createElement("section", { className: "cs-state-group", id, key: id }, /* @__PURE__ */ React.createElement("h2", { className: "cs-state-group-title" }, title), /* @__PURE__ */ React.createElement(View, null))
    ));
  }
  window.ComposerStatesPreview = ComposerStatesPreview;
})();
