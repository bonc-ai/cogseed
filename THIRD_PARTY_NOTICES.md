CogSeed THIRD-PARTY NOTICES
============================

CogSeed (c) 2026 BONC.  Portions (c) 2026 Orkas contributors.

This file lists third-party software components that are distributed with,
or linked into, CogSeed, together with their copyright and license
information, as required by the applicable license terms.

The full text of the licenses for vendored libraries and the package licenses
called out in section 5 is retained in this source distribution. Other npm
package license files remain in their installed package directories after
`npm install`; package metadata and the lockfile are the source of truth for
those dependencies.


--------------------------------------------------------------------
1. Production npm dependencies
--------------------------------------------------------------------

The following packages are direct runtime dependencies of CogSeed.  Unless
otherwise noted, they are used unmodified and are the property of their
respective copyright holders.

@earendil-works/pi-ai 0.79.10          MIT      https://github.com/earendil-works/pi
@larksuiteoapi/node-sdk 1.72.0        MIT      https://github.com/larksuite/node-sdk
@modelcontextprotocol/sdk 1.29.0      MIT      https://modelcontextprotocol.io
@wecom/aibot-node-sdk 1.0.7           MIT      https://github.com/WecomTeam/aibot-node-sdk
adm-zip 0.6.0                         MIT      https://github.com/cthackers/adm-zip
async-mutex 0.5.0                     MIT      https://github.com/DirtyHairy/async-mutex
better-sqlite3 12.10.0                MIT      https://github.com/WiseLibs/better-sqlite3
electron-log 5.4.3                    MIT      https://github.com/megahertz/electron-log
fastembed 2.1.0                       MIT      https://github.com/Anush008/fastembed-js
jimp 1.6.1                            MIT      https://github.com/jimp-dev/jimp
mammoth 1.12.0                        BSD-2-Clause  https://github.com/mwilliamson/mammoth.js
node-pty 1.0.0                        MIT      https://github.com/microsoft/node-pty
pdfjs-dist 6.2.108                    Apache-2.0  https://mozilla.github.io/pdf.js/
sherpa-onnx-node 1.13.6               Apache-2.0  https://github.com/k2-fsa/sherpa-onnx
socks-proxy-agent 8.0.5               MIT      https://github.com/TooTallNate/proxy-agents
sqlite-vec 0.1.9                      MIT OR Apache-2.0  https://github.com/asg017/sqlite-vec
tar 7.5.20                            BlueOak-1.0.0  https://github.com/isaacs/node-tar
tsx 4.21.0                            MIT      https://github.com/privatenumber/tsx
undici 7.29.0                         MIT      https://github.com/nodejs/undici
ws 8.21.3                             MIT      https://github.com/websockets/ws
yaml 2.9.0                            ISC      https://github.com/eemeli/yaml
zod 3.25.76                           MIT      https://github.com/colinhacks/zod


--------------------------------------------------------------------
2. Dual-licensed component used under MIT
--------------------------------------------------------------------

jszip 3.10.1
    (c) Stuart Knightley <stuart@stuartk.com>
    License: MIT OR GPL-3.0-or-later
    CogSeed uses this library under the MIT option of the dual license.
    https://github.com/Stuk/jszip

--------------------------------------------------------------------
3. Vendored renderer libraries
--------------------------------------------------------------------

The following third-party libraries are vendored under src/renderer/vendor/.
Each is released under a permissive license that permits redistribution.

DOMPurify 3.2.4
    (c) Cure53 and other contributors, https://github.com/cure53/DOMPurify
    License: Apache-2.0 OR MPL-2.0
    Vendored from: https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js
    License text: src/renderer/vendor/dompurify/LICENSE

MathJax 3.2.2 (tex-chtml.js)
    (c) The MathJax Consortium, https://www.mathjax.org/
    License: Apache-2.0
    License text: src/renderer/vendor/mathjax/LICENSE

qrcode-generator (qrcode.js)
    (c) 2009 Kazuhiko Arase, https://github.com/kazuhikoarase/qrcode-generator
    License: MIT
    'QR Code' is a registered trademark of DENSO WAVE INCORPORATED.

xterm.js (xterm.js, xterm.css, addon-fit.js)
    (c) the xterm.js authors and Source/contributors, https://xtermjs.org/
    License: MIT

Chart.js 4.5.1 (chart.umd.min.js)
    Copyright (c) 2014-2024 Chart.js Contributors
    Source: https://www.npmjs.com/package/chart.js/v/4.5.1
    License: MIT
    License text: src/renderer/vendor/chartjs/LICENSE
    CogSeed vendors the unmodified UMD distribution for offline Renderer use.

--------------------------------------------------------------------
4. Office document engine
--------------------------------------------------------------------

OfficeCLI v1.0.131
    (c) 2026 OfficeCLI, https://github.com/iOfficeAI/OfficeCLI
    License: Apache-2.0
    Source/release: https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.131
    CogSeed distributes the unmodified, platform-specific OfficeCLI binary
    under resources/officecli/ for DOCX/XLSX/PPTX document operations.
    The accompanying license text is resources/officecli/LICENSE.

--------------------------------------------------------------------
5. Separately licensed CogSeed component
--------------------------------------------------------------------

skill-sentry 2.1.0
    Component path: resources/guardrail/skill-sentry/
    Copyright: CogSeed (as declared by the component metadata)
    License: Apache-2.0
    License text: resources/guardrail/skill-sentry/LICENSE
    The component's SKILL.md and pyproject.toml explicitly declare
    Apache-2.0. This component is not relicensed by the root MIT LICENSE.

skill-declaration-core 1.3.0
    Component path: resources/guardrail/skill-declaration-core/
    Copyright: CogSeed (as declared by the component metadata)
    License: Apache-2.0
    License text: resources/guardrail/skill-declaration-core/LICENSE
    The component's SKILL.md and pyproject.toml explicitly declare
    Apache-2.0. This component is not relicensed by the root MIT LICENSE.

--------------------------------------------------------------------
6. Package license texts retained in this repository
--------------------------------------------------------------------

Exif Parser 0.1.12
    Copyright (c) 2010 Bruno Windels, Daniel Leinich
    License: MIT
    License text: third_party_licenses/exif-parser/LICENSE.md
    Package: https://registry.npmjs.org/exif-parser/-/exif-parser-0.1.12.tgz
    Package integrity: sha512-c2bQfLNbMzLPmzQuOr8fy0csy84WmwnER81W88DzTp9CYNPJ6yzOj2EZAh9pywYpqHnshVLHQJ8WzldAyfY+Iw==
    Upstream evidence: https://github.com/bwindels/exif-parser/blob/072126586f21e973f15c9da5d12db207a0fb6b10/LICENSE.md
    License SHA-256: 3c58bdcad5b1313456b7cf639574708a84a80ee6bddf1a26f0c5fc4d7ab1830b

Mammoth 1.12.0
    (c) 2013 Michael Williamson
    License: BSD-2-Clause
    License text: third_party_licenses/mammoth/LICENSE
    Source: https://github.com/mwilliamson/mammoth.js

PDF.js (pdfjs-dist) 6.2.108
    (c) Mozilla Foundation and PDF.js contributors
    License: Apache-2.0
    License text: third_party_licenses/pdfjs-dist/LICENSE
    Source: https://github.com/mozilla/pdf.js
    The directory also retains the package's notices for bundled ICC
    profiles, CMaps, standard fonts, and WebAssembly codecs:
    third_party_licenses/pdfjs-dist/LICENSE*

--------------------------------------------------------------------
7. Apache-2.0 production transitive npm dependencies
--------------------------------------------------------------------

The following unmodified components are resolved from the production npm
dependency tree and may be distributed with CogSeed. They are listed here to
make their versions, sources, and licensing explicit. Copyright belongs to the
respective authors and contributors identified by each package. The exact
package license text is retained in its installed package directory after
`npm install`; the resolved version is pinned by package-lock.json.

AWS Crypto helpers (c) Amazon.com, Inc. or its affiliates
    Source: https://github.com/aws/aws-sdk-js-crypto-helpers
    License: Apache-2.0
    @aws-crypto/crc32 5.2.0
    @aws-crypto/sha256-browser 5.2.0
    @aws-crypto/sha256-js 5.2.0
    @aws-crypto/supports-web-crypto 5.2.0
    @aws-crypto/util 5.2.0

AWS SDK for JavaScript (c) Amazon.com, Inc. or its affiliates
    Source: https://github.com/aws/aws-sdk-js-v3
    License: Apache-2.0
    @aws-sdk/client-bedrock-runtime 3.1048.0
    @aws-sdk/core 3.974.15
    @aws-sdk/credential-provider-env 3.972.41
    @aws-sdk/credential-provider-http 3.972.43
    @aws-sdk/credential-provider-ini 3.972.46
    @aws-sdk/credential-provider-login 3.972.45
    @aws-sdk/credential-provider-node 3.972.47
    @aws-sdk/credential-provider-process 3.972.41
    @aws-sdk/credential-provider-sso 3.972.45
    @aws-sdk/credential-provider-web-identity 3.972.45
    @aws-sdk/eventstream-handler-node 3.972.18
    @aws-sdk/middleware-eventstream 3.972.14
    @aws-sdk/middleware-websocket 3.972.23
    @aws-sdk/nested-clients 3.997.13
    @aws-sdk/signature-v4-multi-region 3.996.30
    @aws-sdk/token-providers 3.1048.0, 3.1056.0
    @aws-sdk/types 3.973.9
    @aws-sdk/util-locate-window 3.965.5
    @aws-sdk/xml-builder 3.972.26

AWS Lambda Invoke Store (c) Amazon.com, Inc. or its affiliates
    Source: https://github.com/awslabs/aws-lambda-invoke-store
    License: Apache-2.0
    @aws/lambda-invoke-store 0.2.4

Smithy TypeScript (c) Amazon.com, Inc. or its affiliates
    Source: https://github.com/smithy-lang/smithy-typescript
    License: Apache-2.0
    @smithy/core 3.24.5
    @smithy/credential-provider-imds 4.3.6
    @smithy/fetch-http-handler 5.4.5
    @smithy/is-array-buffer 2.2.0
    @smithy/node-http-handler 4.7.3, 4.7.5
    @smithy/signature-v4 5.4.5
    @smithy/types 4.14.2
    @smithy/util-buffer-from 2.2.0
    @smithy/util-utf8 2.3.0

Google libraries and Google Gen AI SDK (c) Google LLC and contributors
    Sources:
      https://github.com/googleapis/js-genai
      https://github.com/googleapis/google-cloud-node-core
    License: Apache-2.0
    @google/genai 1.52.0
    gaxios 7.1.4
    gcp-metadata 8.1.2
    google-auth-library 10.6.2
    google-logging-utils 1.1.3

Mistral TypeScript client (c) Mistral AI and contributors
    Source: https://github.com/mistralai/client-ts
    License: Apache-2.0
    @mistralai/mistralai 2.2.6

OpenTelemetry JavaScript (c) OpenTelemetry Authors
    Source: https://github.com/open-telemetry/opentelemetry-js
    License: Apache-2.0
    @opentelemetry/api 1.9.0
    @opentelemetry/semantic-conventions 1.41.1

OpenAI JavaScript SDK (c) OpenAI and contributors
    Source: https://github.com/openai/openai-node
    License: Apache-2.0
    openai 6.26.0

Other Apache-2.0 production components
    detect-libc 2.1.2
      Source: https://github.com/lovell/detect-libc
      License: Apache-2.0
    ecdsa-sig-formatter 1.0.11
      Source: https://github.com/Brightspace/node-ecdsa-sig-formatter
      License: Apache-2.0
    long 5.3.2
      Source: https://github.com/dcodeIO/long.js
      License: Apache-2.0
    tunnel-agent 0.6.0
      Source: https://github.com/mikeal/tunnel-agent
      License: Apache-2.0

Dual/multi-licensed production components used under a permissive option
    rc 1.2.8
      Source: https://github.com/dominictarr/rc
      License: BSD-2-Clause OR MIT OR Apache-2.0
      CogSeed uses this library under a permissive license option.
    sqlite-vec-darwin-arm64 0.1.9
    sqlite-vec-darwin-x64 0.1.9
    sqlite-vec-linux-arm64 0.1.9
    sqlite-vec-linux-x64 0.1.9
    sqlite-vec-windows-x64 0.1.9
      Source: https://github.com/asg017/sqlite-vec
      License: MIT OR Apache-2.0
      These optional platform packages accompany sqlite-vec, which is declared
      in section 1; CogSeed uses the MIT option.

--------------------------------------------------------------------
8. Adapted source code
--------------------------------------------------------------------

AI Agent Board
    Copyright (c) 2025 AI Agent Board Contributors
    Source: https://github.com/DanWahlin/ai-agent-board
    Source commit: 4f2965e72ad99e32e0375af837247cafb382f17c
    License: MIT
    License text: third_party_licenses/ai-agent-board/LICENSE
    CogSeed adapts the canonical JSON ordering used for orchestration request
    snapshots and the task-group status counter to its local task model. The
    adapted files retain the upstream copyright and SPDX license declaration.

--------------------------------------------------------------------
9. License text policy
--------------------------------------------------------------------

The license files above are copied verbatim from the exact package versions
recorded in package-lock.json. When upgrading a dependency, refresh the
corresponding retained file(s) and update the version, copyright, source,
and license entries together. The original package license files under
node_modules remain authoritative for an installed checkout.


--------------------------------------------------------------------
9. Development npm dependencies
--------------------------------------------------------------------

The following packages are build/test tooling used to develop and verify
CogSeed. They are not distributed with the packaged application.

@electron/rebuild 4.2.0                MIT        https://github.com/electron/rebuild
@eslint/js 10.0.1                      MIT        https://github.com/eslint/eslint
@types/adm-zip 0.5.8                   MIT        https://github.com/DefinitelyTyped/DefinitelyTyped
@types/node 25.6.0                     MIT        https://github.com/DefinitelyTyped/DefinitelyTyped
@vitest/coverage-v8 4.1.11             MIT        https://github.com/vitest-dev/vitest
7zip-bin 5.2.0                         MIT        https://github.com/develar/7zip-bin
electron 41.10.6                       MIT        https://github.com/electron/electron
electron-builder 26.15.7                MIT        https://github.com/electron-userland/electron-builder
eslint 10.9.0                          MIT        https://github.com/eslint/eslint
typescript 6.0.3                       Apache-2.0 https://github.com/microsoft/TypeScript
typescript-eslint 8.67.0               MIT        https://github.com/typescript-eslint/typescript-eslint
vitest 4.1.11                          MIT        https://github.com/vitest-dev/vitest
