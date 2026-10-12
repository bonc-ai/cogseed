---
name: sample-prose-only
description: "纯散文安全守则样本：禁止某行为的说明不等于该行为。"
---

# Authoring safety gates

- **Credentials and private context**: do not read `.env`, `~/.ssh`, `~/.aws/credentials`,
  shell history, keychains, or browser cookies.
- **Download-and-execute**: do not use `curl | sh`, `wget | sh`, or unknown raw IP downloads.
- **Dynamic execution**: do not build steps around `eval`, `exec`, or base64 decode-then-run flows.
