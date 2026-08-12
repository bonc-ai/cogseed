# 首次启动网络指南（受限网络环境）

> 适用：中国大陆网络环境下第一次 clone 后启动 Mate Agent。
> 依据：2026-08-05/06 一次完整的真实首启记录（已跑通到 Electron 起窗），所有数据均为实测。

首次启动需要从 **7 个不同来源**下载约 **250MB** 资源。这些下载全部发生在 `./run.sh` 启动 Electron **之前**，任何一个失败，应用就起不来。

两条关键结论：

**1. 没有一个"全局最优"的网络设置。** 不同来源的最优路径互相矛盾——有的必须走代理，有的走代理反而慢 200 倍。按域名分别处理是唯一可行的办法。

**2. 本机代理会静默截断大响应体。** 这是首启失败的头号原因，而且极具迷惑性：连接会被**干净地关闭**，所以 curl 返回 exit 0、Node 的 `fetch` 正常 resolve，看起来像下载成功了，实际文件是残的。实测两例：

| 资源 | 实际拿到 | 应有大小 |
|---|---|---|
| OfficeCLI | 20,971,520（= 正好 20 MiB） | 33,391,392 |
| Whisper 模型 | 10,485,760（= 正好 10 MiB） | 59,707,625 |

不同源站（GitHub / HuggingFace）、不同客户端（Node `https.get` / curl）都截断在 2 的整数次幂 MiB 边界上。**破解办法是显式分块 Range 请求**（见第三节），每块 4MB 根本跑不到截断阈值——不仅不会残，速度还快十倍以上（180 KB/s vs 17 KB/s）。

> 如果没有各脚本里 pin 死的 sha256，这些残档会被当成正常二进制装进 `resources/`。
> 那一晚它拦下了三次。**不要以"反正校验很慢"为由弱化任何一处 sha256 校验。**

---

## 一、实测速率对照

| 来源 | 用途 | 直连 | 走代理 | 结论 |
|---|---|---|---|---|
| `registry.npmmirror.com` | npm 依赖 | **4.4 MB/s** | 10 KB/s | 必须直连 |
| `nodejs.org` | Node 运行时 52MB | **2.4 MB/s** | 10.7 KB/s | 必须直连 |
| `cdn.npmmirror.com/binaries/node` | Node 镜像（备选） | **1.8 MB/s** | — | 直连 |
| `storage.googleapis.com` | 嵌入模型 52MB | 20.8 KB/s | 13.4 KB/s | 直连略优 |
| `github.com/.../releases` | CPython 25MB + uv 21MB | **0 B/s（不通）** | 20 KB/s | 必须走代理 |
| `github.com/.../OfficeCLI` | OfficeCLI 33MB | 21 KB/s → 后测 **0（不通）** | 18.7 KB/s（会截断） | 走代理 + 分块 |
| `huggingface.co` | Whisper 模型 57MB | **0 B/s（不通）** | 通，但会截断 | 走代理 + 分块 |

> GitHub 的直连表现不稳定：python-build-standalone 直连返回 `code 000`（完全不通），
> OfficeCLI 直连早期能拿到 `206`，同一晚稍后再测就变成 30s 超时 `000`。
> 同一域名不同时刻结果不同，不要假定其中一种恒定可用。
>
> 分块下载时代理侧的**单块**速率远高于整文件下载，因为没触发截断逻辑。上表"走代理"
> 一列是整文件直下的速率，仅用于说明"为什么不能整文件直下"，不代表分块方案的实际表现。

**代理是本机 HTTP 代理（`http://127.0.0.1:1087`）。** 注意环境变量里的
`ALL_PROXY=socks5://127.0.0.1:1087` 实测无效（socks5 端口不通），只有 HTTP 代理可用。

**代理支持 `Range`。** 实测 `-r 30000000-30000099` 返回 `206` + 精确 100 字节，
`accept-ranges: bytes`。这是分块方案成立的前提，也是唯一能绕过截断的口子。

**环境变量对 Node 脚本无效。** `HTTP_PROXY` / `HTTPS_PROXY` 只对 curl 之类的工具生效。
本仓库所有下载脚本要么用 `https.get`（`fetch-officecli.cjs`、`ensure-runtime.cjs`、
`fetch-embedding-model.mjs`），要么用 Node 内置 `fetch`/undici（`fetch-whisper.cjs`），
**两者都不读代理环境变量**。所以"给某一步单独开代理"这个思路在这个仓库里是行不通的，
只能靠预先把文件放到脚本要找的位置。

---

## 二、八道下载门（按顺序）

| # | 资源 | 大小 | 来源 | 触发点 |
|---|---|---|---|---|
| 1 | npm 依赖 | ~700MB | npm registry | `npm install` |
| 2 | CPython 3.12.13 | 25MB | GitHub | `bin/ensure-runtime.cjs` |
| 3 | uv 0.11.21 | 21MB | GitHub | 同上 |
| 4 | Node 24.17.0 | 52MB | nodejs.org | 同上 |
| 5 | 嵌入模型 bge-small-zh | 52MB | Google GCS | `scripts/fetch-embedding-model.mjs` |
| 6 | OfficeCLI v1.0.131 | 33,391,392 B | GitHub Releases | `scripts/fetch-officecli.cjs` |
| 7 | FFmpeg | — | 本地复制 | `scripts/fetch-ffmpeg.cjs` |
| 8 | Whisper 模型 base-q5_1 | 59,707,625 B | HuggingFace | `scripts/fetch-whisper.cjs` |

FFmpeg 不下载，从已安装的 npm 包（`ffmpeg-static`、`@ffprobe-installer`）本地复制。
Windows VC runtime 仅 Windows 需要。

**macOS 上 Whisper 只缺一个文件。** `whisper-cli` 已经 vendored 在仓库里
（`vendor/whisper/v1.8.6/darwin-arm64/whisper-cli`，静态构建），脚本只是把它复制过去。
`runtime-gate.cjs` 里那两个 whisper.cpp / OpenBLAS 的 GitHub zip **仅 win32-x64 目标才下载**。
所以 mac 首启在这一步的网络需求就是 57MB 的模型，别被 NOTICE 文本里列的一堆 URL 吓到。

---

## 三、推荐操作顺序

### 第 1 步：npm 依赖（直连国内镜像）

仓库根目录 `.npmrc` 已配置 npmmirror。安装时**必须绕开代理**，否则国内 CDN 流量被绕到境外节点，慢 400 倍：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    npm install
```

### 第 2 步：预置运行时（GitHub 部分走代理）

`bin/ensure-runtime.cjs` 有两个硬伤（见第四节），受限网络下必然失败。用带续传的 curl 先把三个包拉到本地缓存：

```bash
CACHE=~/.cache/mate-agent-runtime && mkdir -p "$CACHE"

# CPython + uv：GitHub，必须走代理，单调续传
for URL in \
  "https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.12.13%2B20260610-aarch64-apple-darwin-install_only_stripped.tar.gz" \
  "https://github.com/astral-sh/uv/releases/download/0.11.21/uv-aarch64-apple-darwin.tar.gz"
do
  F="$CACHE/$(basename "${URL%%\?*}" | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))')"
  touch "$F"
  for i in $(seq 1 40); do
    OFF=$(stat -f%z "$F"); SZ_DONE=$(curl -sI -x http://127.0.0.1:1087 "$URL" | awk '/content-length/{print $2}' | tr -d '\r' | tail -1)
    curl -sL -x http://127.0.0.1:1087 --max-time 900 --speed-time 60 --speed-limit 3000 -r "${OFF}-" "$URL" >> "$F"
    [ "$(stat -f%z "$F")" -ge "${SZ_DONE:-999999999}" ] && break
  done
done

# Node：直连，20 秒搞定
curl -L --noproxy '*' -o "$CACHE/node-v24.17.0-darwin-arm64.tar.gz" \
  https://nodejs.org/dist/v24.17.0/node-v24.17.0-darwin-arm64.tar.gz
```

校验（三个都必须 MATCH，期望值在 `resources/runtime/manifest.json`）：

```bash
shasum -a 256 "$CACHE"/*.tar.gz
```

然后让 `ensure-runtime.cjs` 从缓存读取。它自己的 size / sha256 / 解包 / 自检**照常执行**，只是传输层换成本地文件——校验强度不变。参考 `docs/` 同目录下的 shim 写法，或直接把缓存文件放进它的临时目录。

### 第 3 步：嵌入模型（直连 + 手动续传）

`scripts/fetch-embedding-model.mjs` 用裸 `https.get`，无重试无续传，断一次整个 postinstall 就失败。手动拉：

```bash
F=resources/embedding-model/fast-bge-small-zh-v1.5.tar.gz
TARGET=54584282
mkdir -p resources/embedding-model && touch "$F"
until [ "$(stat -f%z "$F")" -ge $TARGET ]; do
  OFF=$(stat -f%z "$F")
  curl -s --noproxy '*' --max-time 600 --speed-time 60 --speed-limit 3000 -r "${OFF}-" \
    https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-zh-v1.5.tar.gz >> "$F"
done
tar -xzf "$F" -C resources/embedding-model/
rm "$F"    # 必须删除：资源门禁要求该目录下只有模型文件夹
```

**最后一步的 `rm` 不能省。** `packaged-resource-gate` 会把残留的 `.tar.gz`
判为 `unexpected embedding-model payload` 而失败。

### 第 4 步：分块拉取 OfficeCLI 和 Whisper 模型

**不要指望脚本自己下这两个。** 它们不走代理，而直连这两个域名都不通；就算走代理也会被
静默截断。用下面这个分块工具预先拉好，脚本会在启动时校验通过并跳过下载。

```bash
#!/bin/bash
# chunk-fetch.sh — 用固定大小的 Range 分块穿过会截断的代理。
# 每块必须返回精确的请求长度才追加，否则原地重试；输出长度不可能超过 total。
set -u
url="$1"; out="$2"; total="$3"; want_sha="$4"; label="$5"
chunk=$((4 * 1024 * 1024)); tmp="${out}.chunk"
: > "$out"; offset=0
while [ "$offset" -lt "$total" ]; do
  end=$((offset + chunk - 1)); [ "$end" -ge "$total" ] && end=$((total - 1))
  want=$((end - offset + 1)); ok=0
  for try in 1 2 3 4 5 6; do
    curl -sS -L --max-time 240 -r "${offset}-${end}" -o "$tmp" "$url" >/dev/null 2>&1
    got=$(stat -f%z "$tmp" 2>/dev/null || echo 0)
    [ "$got" -eq "$want" ] && { ok=1; break; }
    echo "[$label] chunk @${offset} try $try: got $got want $want"; sleep 2
  done
  [ "$ok" -eq 1 ] || { echo "[$label] FAILED at $offset"; rm -f "$tmp"; exit 2; }
  cat "$tmp" >> "$out"; offset=$((end + 1))
  echo "[$label] $offset / $total"
done
rm -f "$tmp"
[ "$(shasum -a 256 "$out" | cut -d' ' -f1)" = "$want_sha" ] \
  && echo "[$label] DONE" || { echo "[$label] SHA MISMATCH"; exit 4; }
```

期望的 size / sha256 从代码里取，不要抄这里的常量：OfficeCLI 见
`scripts/fetch-officecli.cjs` 的 `SHA256` 映射；Whisper 模型见
`bin/runtime-gate.cjs` 的 `WHISPER_RUNTIME_CONTRACT.model`。

```bash
# OfficeCLI —— 直接落到成品路径（不要留 .part 后缀，理由见第五节）
./chunk-fetch.sh \
  'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.131/officecli-mac-arm64' \
  resources/officecli/officecli-mac-arm64 \
  33391392 1a10e73e73e1a3aa278d75af8e966ce932691bbf9958a06578638c42181894fb officecli
chmod 755 resources/officecli/officecli-mac-arm64
xattr -d com.apple.quarantine resources/officecli/officecli-mac-arm64 2>/dev/null

# Apache-2.0 要求随附 LICENSE，脚本抓它同样会超时，手动补
curl -sSL -o resources/officecli/LICENSE \
  https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/v1.0.131/LICENSE

# Whisper 模型 —— 落到脚本的缓存目录，它会自己校验并复制到 runtime 下
mkdir -p ~/.cache/orkas-runtime/whisper
./chunk-fetch.sh \
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin' \
  ~/.cache/orkas-runtime/whisper/ggml-base-q5_1.bin \
  59707625 422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898 whisper-model
```

缓存目录可以用 `ORKAS_RUNTIME_CACHE_DIR` 覆盖，默认
`~/.cache/orkas-runtime/whisper/`。`hf-mirror.com` 同路径也可达（实测 200），可作备用源。

验证这一步做对了——两行都应该是"跳过"，且整个过程不发任何网络请求：

```
[officecli] officecli-mac-arm64 present and verified, skipping
[fetch-whisper] Whisper already ready for darwin-arm64
```

### 第 5 步：启动

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    ./run.sh
```

前面都做对的话，`ensure-dev-dependencies` 会在几秒内以
`[dev-deps] built-in dependencies ready` 通过，然后 `run.sh` 注册
`mateagent://` / `orkas://` 协议、编译 KSTAR 引擎、拉起 Electron。

> 注意 `prepare-source-protocol.cjs` 在 `ensure-dev-dependencies` **之后**执行。
> 如果之前每次都卡在下载，这个协议注册其实一次都没跑过。

---

## 四、已知缺陷（值得修）

这三条不是环境问题，是启动流程对受限网络的适配缺口。任何同类网络环境的开发者都会撞上：

| 文件 | 缺陷 | 后果 |
|---|---|---|
| `scripts/fetch-embedding-model.mjs` | 裸 `https.get`，无重试、无续传 | 断一次，整个 postinstall 失败 |
| `bin/ensure-runtime.cjs` | 裸 `https.get`，不读 `HTTPS_PROXY` | GitHub 不通时必然失败，且无法通过环境变量补救 |
| `bin/ensure-runtime.cjs` | `DOWNLOAD_TIMEOUT_MS` 硬编码 10 分钟墙钟，无 CLI 开关 | 20 KB/s 下 25MB 需 38 分钟，必然超时；即使下载正常进行也会被杀 |
| `scripts/fetch-whisper.cjs` | Node 内置 `fetch`，不读代理；`arrayBuffer()` 整个 57MB 读进内存；无分块无续传 | 任何中断都从 0 重来；受限网络下几乎不可能靠它自己下完 |
| `scripts/fetch-officecli.cjs` | 服务端忽略 `Range` 返回 200 时，`rmSync(outPath)` 删掉已有部分重下 | 已经下好的完整文件会被删除（详见第五节） |
| 全部下载脚本 | 无一支持"预置缓存文件"的官方入口（whisper 的 `ORKAS_RUNTIME_CACHE_DIR` 是唯一例外，且未文档化） | 受限网络下只能靠猜路径手工投放 |

`scripts/fetch-officecli.cjs` 有两点设计是对的、值得推广：**停滞超时**（无进度才中断，
而非墙钟）和 **sha256 pin + 已存在即跳过**。它的续传逻辑则不要照抄。

建议的修复方向（未实施）：

1. 所有下载脚本统一走一个支持 `HTTPS_PROXY` / 分块 Range / 停滞超时的下载工具函数
2. 墙钟超时改为停滞超时，或至少提供 `--timeout-ms` 开关
3. 统一支持一个缓存目录环境变量，允许离线/预置安装（whisper 已有，推广到其余脚本）
4. 服务端忽略 `Range` 时不要删除本地文件——先校验本地是否已经完整，再决定是否重下

---

## 五、踩过的坑

**`curl --retry` 不能和 `-C -` 混用。** curl 内部重试会重开输出文件，把已下载内容冲掉——
实测文件从 19MB 掉回 9MB。正确做法是自己控制循环，每轮用
`stat` 取实际大小、显式 `-r <offset>-` 追加写入，保证单调只增。

**`| tail -N` 会吞掉退出码。** `npm install 2>&1 | tail -40` 的退出码来自 `tail`，
永远是 0。npm 实际失败（`EIDLETIMEOUT`）会被完全掩盖。

**并发下载会互相抢带宽。** 用 curl 探测速率时，如果同时有下载在跑，探测结果会是 0 B/s。
测速前先确认没有其它下载进程。

**`-C -` 续传在服务端忽略 `Range` 时会让文件倒退甚至变脏。** 实测 OfficeCLI 一轮循环里
出现 `29910344 → 23358936`（变小），最终停在 35,607,328——**比真实的 33,391,392 还大**，
是几轮截断叠出来的垃圾。原因是服务端时而返回 206 时而返回 200，curl 在两种语义间摇摆。
用显式 `-r start-end` 分块可以完全避免：每块长度确定，长度对不上就不写入。

**下载完成后不要把文件留在 `.part` 后缀就去跑脚本。** `fetch-officecli.cjs` 找不到成品，
会对这个已经完整的 `.part` 发起续传，而它在服务端返回 200 时执行 `rmSync` 删档重下。
正确做法是**先改名成成品路径 + `chmod 755`**，让脚本走"已存在即跳过"分支。

**`pkill` 之后立刻 rename 是个陷阱。** macOS 上 rename 不切断已打开的 fd，fd 跟着 inode 走。
被杀进程缓冲区里的数据仍可能在改名**之后**落盘，追加到你刚改好名的成品上。实测这样
凭空多出 348,912 字节，且改名当时校验是通过的——是下一轮 sha 校验才暴露。
杀进程后要 `lsof` 确认没有残留持有者，再动文件；改完名务必**重新校验一次 sha256**。

**`$PIPESTATUS` 在 zsh 里是空的。** zsh 用小写 `$pipestatus`（数组）。
`cmd | grep x; echo $PIPESTATUS[0]` 在 zsh 下拿不到退出码，会误判成功。
跨 shell 的可靠写法是不要管道，直接 `cmd >/dev/null 2>&1; echo $?`。
