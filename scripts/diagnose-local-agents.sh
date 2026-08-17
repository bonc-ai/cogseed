#!/usr/bin/env bash
# =============================================================================
# diagnose-local-agents.sh — 外部（本地 CLI）Agent 故障诊断脚本（无 Node 依赖版）
#
# 适用：macOS / Linux。不需要 Node.js / npm / pnpm，任何装了 bash 的机器
#       （macOS 自带，Linux 基本都有）复制过去直接跑：
#
#       bash diagnose-local-agents.sh
#
# 与 Node 版 scripts/diagnose-local-agents.mjs 功能对齐（检测逻辑镜像 App 的
# registry.ts / version.ts / auth-state.ts / active_config.ts / which.ts）：
#
#   1. 二进制查找   → PATH + 常见安装目录（homebrew / ~/.local/bin / ~/.codex/bin /
#                     nvm / WorkBuddy App 内置 等），支持 ORKAS_<TYPE>_PATH 覆盖
#   2. 版本探测     → 跑 `<bin> --version`（5s 超时），解析 semver，
#                     低于 claude 2.0.0 / codex 0.100.0 判为版本过低
#   3. 凭据配置检查 → settings.json / auth.json / sessions.json 存在性 + 形状，
#                     密钥一律脱敏（只显示前 4 + 后 4 字符和长度）
#   4. 模型端点     → 配置指向本地代理（CC Switch 等）时用 nc 探测端口是否在跑
#   5. Shell 配置   → 对比 ~/.zshrc 等里的 PATH 与当前 PATH（终端能跑 App 不能）
#   6. App 数据交叉 → 扫描 agent.json 里 runtime.kind==='cli' 的外部 Agent，
#                     与本机检测结果对表（定位“App 显示了本机没有的 Agent”）
#
# 安全：只读、不修改任何配置；不输出任何密钥原文。
#
# 用法：
#   bash diagnose-local-agents.sh                     # 全量诊断
#   bash diagnose-local-agents.sh --json              # 机器可读输出
#   bash diagnose-local-agents.sh --only claude,codex
#   bash diagnose-local-agents.sh --no-version-probe  # 快速模式（跳过版本探测）
#   bash diagnose-local-agents.sh --export-expected known-good.txt
#   bash diagnose-local-agents.sh --expected known-good.txt
#   bash diagnose-local-agents.sh --home /Users/xxx --data-root /path
# =============================================================================

set -u

# ─────────────────────────────────────────────────────────────────────────────
# 常量（与 Node 版 / App 保持一致）
# ─────────────────────────────────────────────────────────────────────────────

CLI_TYPES="claude codex openclaw opencode hermes workbuddy"

bin_name() {
  case "$1" in
    claude)    printf 'claude' ;;
    codex)     printf 'codex' ;;
    openclaw)  printf 'openclaw' ;;
    opencode)  printf 'opencode' ;;
    hermes)    printf 'hermes' ;;
    workbuddy) printf 'codebuddy' ;;
    *)         printf '%s' "$1" ;;
  esac
}

env_key() {
  case "$1" in
    claude)    printf 'ORKAS_CLAUDE_PATH' ;;
    codex)     printf 'ORKAS_CODEX_PATH' ;;
    openclaw)  printf 'ORKAS_OPENCLAW_PATH' ;;
    opencode)  printf 'ORKAS_OPENCODE_PATH' ;;
    hermes)    printf 'ORKAS_HERMES_PATH' ;;
    workbuddy) printf 'ORKAS_WORKBUDDY_PATH' ;;
    *)         printf '' ;;
  esac
}

VERSION_PROBE_TIMEOUT_S=5
MIN_CLAUDE="2.0.0"
MIN_CODEX="0.100.0"

PLATFORM="$(uname -s)"
IS_MAC=0
case "$PLATFORM" in
  Darwin) IS_MAC=1 ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# 小工具
# ─────────────────────────────────────────────────────────────────────────────

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' \
    | tr '\n' ' ' | sed 's/  *$//'
}

redact() {
  local v="$1" len
  len="${#v}"
  if [ "$len" -eq 0 ]; then printf '(empty)'; return; fi
  if [ "$len" -le 8 ]; then printf '***(%s)' "$len"; return; fi
  printf '%s…%s (len %s)' "${v:0:4}" "${v: -4}" "$len"
}

# 提取 JSON 顶层键的字符串值（depth==1，即根对象的成员）。
# 用 awk 跟踪花括号深度，避免误读嵌套对象里的同名键
# （例如 ~/.codex/auth.json 里 "tokens": { "access_token": ... } ——
#   App 只读顶层 access_token，这里必须一致）。
# $1 = 文件, $2 = key → 打印值（无则空）
extract_json_key() {
  awk -v target="$2" '
    function scan(s, i, n, c, j, k, name, after, v, end, ch) {
      n = length(s)
      while (i <= n) {
        c = substr(s, i, 1)
        if (in_str) {
          if (c == "\\") { i += 2; continue }
          if (c == "\"") in_str = 0
          i++
          continue
        }
        if (c == "\"") {
          j = i + 1
          k = index(substr(s, j), "\"")
          if (k > 0) {
            name = substr(s, j, k - 1)
            after = j + k
            while (after <= n && (substr(s, after, 1) == " " || substr(s, after, 1) == "\t")) after++
            if (substr(s, after, 1) == ":") {
              if (depth == 1 && name == target) {
                v = after + 1
                while (v <= n && (substr(s, v, 1) == " " || substr(s, v, 1) == "\t")) v++
                if (substr(s, v, 1) == "\"") {
                  end = v + 1
                  while (end <= n) {
                    ch = substr(s, end, 1)
                    if (ch == "\\") { end += 2; continue }
                    if (ch == "\"") break
                    end++
                  }
                  print substr(s, v + 1, end - v - 1)
                  exit
                }
              }
              i = after + 1
              continue
            }
          }
          in_str = 1
          i++
          continue
        }
        if (c == "{" || c == "[") depth++
        else if (c == "}" || c == "]") depth--
        i++
      }
    }
    { scan($0, 1) }
  ' "$1" 2>/dev/null
}

# 任意深度第一个匹配的字符串值（用于嵌套键，如 opencode provider 块里的
# type/key/baseURL、claude settings.json env 里的 ANTHROPIC_BASE_URL）。
# $1 = 文件, $2 = key → 打印值（无则空）
extract_json_key_any() {
  grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" 2>/dev/null \
    | head -n1 | sed -E "s/^\"$2\"[[:space:]]*:[[:space:]]*\"//; s/\"$//"
}

# ─────────────────────────────────────────────────────────────────────────────
# semver
# ─────────────────────────────────────────────────────────────────────────────

# $1 版本串 → 设置 SV_MAJOR SV_MINOR SV_PATCH；失败返回 1
semver_parse() {
  local raw="$1" m
  m="$(printf '%s' "$raw" | grep -oE '[v]?[0-9]+\.[0-9]+\.[0-9]+' | head -n1 | sed 's/^v//')"
  if [ -z "$m" ]; then return 1; fi
  SV_MAJOR="${m%%.*}"; SV_MINOR="${m#*.}"; SV_MINOR="${SV_MINOR%%.*}"; SV_PATCH="${m##*.}"
  return 0
}

# 比较 SV_*（已解析）与一个版本串；a < b 返回 0
semver_lt() {
  local b="$1" b_major b_minor b_patch
  b_major="${b%%.*}"; b_minor="${b#*.}"; b_minor="${b_minor%%.*}"; b_patch="${b##*.}"
  if [ "$((10#$SV_MAJOR))" -lt "$((10#$b_major))" ]; then return 0; fi
  if [ "$((10#$SV_MAJOR))" -gt "$((10#$b_major))" ]; then return 1; fi
  if [ "$((10#$SV_MINOR))" -lt "$((10#$b_minor))" ]; then return 0; fi
  if [ "$((10#$SV_MINOR))" -gt "$((10#$b_minor))" ]; then return 1; fi
  if [ "$((10#$SV_PATCH))" -lt "$((10#$b_patch))" ]; then return 0; fi
  return 1
}

# $1 = cli, $2 = detected version → 低于最低版本打印原因，否则打印空
check_min_version() {
  local cli="$1" detected="$2" min
  case "$cli" in
    claude) min="$MIN_CLAUDE" ;;
    codex)  min="$MIN_CODEX" ;;
    *)      return 0 ;;
  esac
  if ! semver_parse "$detected"; then return 0; fi
  if semver_lt "$min"; then
    printf '%s %s 低于要求的最低版本 %s' "$cli" "$detected" "$min"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 二进制查找（镜像 which.ts + registry.ts::localCliSearchDirs）
# ─────────────────────────────────────────────────────────────────────────────

# 打印某 CLI 在 PATH 之外的候选目录（一行一个）
search_dirs_for() {
  local type="$1" home="$2"
  [ -n "$home" ] && {
    printf '%s\n' "$home/.local/bin"
    printf '%s\n' "$home/.npm-global/bin"
    printf '%s\n' "$home/bin"
    printf '%s\n' "$home/.cargo/bin"
    printf '%s\n' "$home/.codex/bin"
    printf '%s\n' "$home/.nvm/versions/node/"*"/bin" 2>/dev/null
    printf '%s\n' "$home/.local/share/fnm/node-versions/"*"/installation/bin" 2>/dev/null
    printf '%s\n' "$home/.asdf/installs/nodejs/"*"/bin" 2>/dev/null
    printf '%s\n' "$home/.asdf/shims" 2>/dev/null
  }
  [ -n "${NPM_CONFIG_PREFIX:-}" ] && printf '%s\n' "$NPM_CONFIG_PREFIX/bin"
  [ -n "${VOLTA_HOME:-}" ] && printf '%s\n' "$VOLTA_HOME/bin"
  [ -n "${PNPM_HOME:-}" ] && printf '%s\n' "$PNPM_HOME"
  printf '%s\n' /opt/homebrew/bin /usr/local/bin
  if [ "$type" = "codex" ] && [ "$IS_MAC" = "1" ]; then
    printf '%s\n' /Applications/Codex.app/Contents/Resources /Applications/ChatGPT.app/Contents/Resources
  fi
  if [ "$type" = "workbuddy" ]; then
    printf '%s\n' /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin
    printf '%s\n' "$home/Applications/"*.app/Contents/Resources/app.asar.unpacked/cli/bin 2>/dev/null
    printf '%s\n' /Applications/*.app/Contents/Resources/app.asar.unpacked/cli/bin 2>/dev/null
  fi
}

# 查找可执行文件；$1 = 名字或绝对路径，$2 = 附加目录（换行分隔）
# 找到 → 打印路径 + 返回 0；否则返回 1
which_bin() {
  local name="$1" extra="$2" dir cand found
  case "$name" in
    /*|*/*)
      if [ -f "$name" ] && [ -x "$name" ]; then printf '%s' "$name"; return 0; fi
      return 1 ;;
  esac
  found="$(command -v "$name" 2>/dev/null)"
  if [ -n "$found" ]; then printf '%s' "$found"; return 0; fi
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    cand="$dir/$name"
    if [ -f "$cand" ] && [ -x "$cand" ]; then printf '%s' "$cand"; return 0; fi
  done <<EOF
$(printf '%s\n' "$extra")
EOF
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 版本探测（镜像 version.ts；5s 超时，杀子进程）
# ─────────────────────────────────────────────────────────────────────────────

# 运行一次探测；$1 = bin, $2 = 参数 → 打印版本串或返回 1
run_probe() {
  local bin="$1" arg="$2" out exit_f pid waited=0 code text ver child
  out="$(mktemp "${TMPDIR:-/tmp}/diag-probe.XXXXXX" 2>/dev/null)"
  exit_f="$(mktemp "${TMPDIR:-/tmp}/diag-probe-exit.XXXXXX" 2>/dev/null)"
  [ -z "$out" ] && out="/tmp/diag-probe.$$"
  [ -z "$exit_f" ] && exit_f="/tmp/diag-probe-exit.$$"
  ( "$bin" "$arg" >"$out" 2>&1; printf '%s' "$?" >"$exit_f" ) &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.2
    waited=$((waited + 1))
    if [ "$waited" -ge $((VERSION_PROBE_TIMEOUT_S * 5)) ]; then
      child="$(pgrep -P "$pid" 2>/dev/null)"
      if [ -n "$child" ]; then kill -9 $child 2>/dev/null; fi
      kill -9 "$pid" 2>/dev/null
      rm -f "$out" "$exit_f"
      return 1
    fi
  done
  wait "$pid" 2>/dev/null
  code="$(cat "$exit_f" 2>/dev/null)"
  rm -f "$exit_f"
  if [ "$code" != "0" ]; then rm -f "$out"; return 1; fi
  text="$(cat "$out" 2>/dev/null)"
  rm -f "$out"
  ver="$(printf '%s' "$text" | grep -oE '[v]?[0-9]+\.[0-9]+\.[0-9]+' | head -n1 | sed 's/^v//')"
  if [ -z "$ver" ]; then return 1; fi
  printf '%s' "$ver"
  return 0
}

# npm 包装包版本兜底（claude/codex）；$1 = bin, $2 = 包名, $3 = 向上层数
detect_package_version() {
  local bin="$1" pkg="$2" depth="${3:-8}" dir n=0 pkgpath name ver parent link
  dir="$(dirname "$bin")"
  if [ -L "$bin" ]; then
    link="$(readlink "$bin" 2>/dev/null)"
    case "$link" in
      /*) dir="$(dirname "$link")" ;;
      *)  dir="$(dirname "$(dirname "$bin")/$link")" ;;
    esac
  fi
  while [ "$n" -lt "$depth" ]; do
    pkgpath="$dir/package.json"
    if [ -f "$pkgpath" ]; then
      name="$(extract_json_key "$pkgpath" "name")"
      ver="$(extract_json_key "$pkgpath" "version")"
      if [ "$name" = "$pkg" ] && [ -n "$ver" ]; then
        printf '%s' "$ver" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1
        return 0
      fi
    fi
    parent="$(dirname "$dir")"
    [ "$parent" = "$dir" ] && break
    dir="$parent"
    n=$((n + 1))
  done
  return 1
}

# 完整版本探测；$1 = cli, $2 = bin → 打印版本或空
probe_cli_version() {
  local cli="$1" bin="$2" ver
  case "$cli" in
    codex)
      ver="$(detect_package_version "$bin" "@openai/codex" 6)"
      [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
      ;;
    claude)
      ver="$(detect_package_version "$bin" "@anthropic-ai/claude-code" 8)"
      [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
      ;;
  esac
  ver="$(run_probe "$bin" "--version")"
  if [ -z "$ver" ] && [ "$cli" = "hermes" ]; then
    ver="$(run_probe "$bin" "version")"
  fi
  printf '%s' "$ver"
}

# ─────────────────────────────────────────────────────────────────────────────
# 凭据 / 配置检查（镜像 auth-state.ts + active_config.ts；输出脱敏）
# ─────────────────────────────────────────────────────────────────────────────

# 全局结果变量（inspect_cli_config 设置）：
#   CFG_FILES="label:exists:parseError\n..."  CFG_AUTH_MODE  CFG_LOGGED_IN
#   CFG_KEY_PRESENT  CFG_KEY_HINT  CFG_BASE_URL  CFG_NOTES

CFG_FILES=""
CFG_AUTH_MODE=""
CFG_LOGGED_IN=0
CFG_KEY_PRESENT=0
CFG_KEY_HINT=""
CFG_BASE_URL=""
CFG_NOTES=""

cfg_add_file() {
  # $1 label, $2 path, $3 parse_error(可空)
  CFG_FILES="${CFG_FILES}${CFG_FILES:+\\n}$1|$([ -f "$2" ] && printf 1 || printf 0)|${3:-}"
}

cfg_add_note() {
  CFG_NOTES="${CFG_NOTES}${CFG_NOTES:+\\n}$1"
}

inspect_cli_config() {
  local cli="$1" home="$2" p
  CFG_FILES=""; CFG_AUTH_MODE=""; CFG_LOGGED_IN=0; CFG_KEY_PRESENT=0; CFG_KEY_HINT=""; CFG_BASE_URL=""; CFG_NOTES=""

  case "$cli" in
    claude)
      p="$home/.claude/settings.json"
      cfg_add_file "settings.json" "$p"
      if [ -f "$p" ]; then
        local key envkey baseurl
        key="$(extract_json_key "$p" "apiKey")"
        [ -z "$key" ] && key="$(extract_json_key "$p" "anthropicApiKey")"
        envkey=""
        grep -q '"ANTHROPIC_AUTH_TOKEN"' "$p" 2>/dev/null && envkey="ANTHROPIC_AUTH_TOKEN"
        if [ -z "$envkey" ] && grep -q '"ANTHROPIC_API_KEY"' "$p" 2>/dev/null; then envkey="ANTHROPIC_API_KEY"; fi
        baseurl="$(extract_json_key "$p" "baseUrl")"
        [ -z "$baseurl" ] && baseurl="$(extract_json_key "$p" "anthropicBaseUrl")"
        [ -z "$baseurl" ] && baseurl="$(extract_json_key_any "$p" "ANTHROPIC_BASE_URL")"
        [ -z "$baseurl" ] && baseurl="$(extract_json_key_any "$p" "ANTHROPIC_API_URL")"
        if [ -n "$key" ]; then
          CFG_AUTH_MODE="api"; CFG_LOGGED_IN=1; CFG_KEY_PRESENT=1; CFG_KEY_HINT="$(redact "$key")"
        elif [ -n "$envkey" ]; then
          CFG_AUTH_MODE="api"; CFG_LOGGED_IN=1; CFG_KEY_PRESENT=1; CFG_KEY_HINT="env:$envkey"
        fi
        [ -n "$baseurl" ] && CFG_BASE_URL="$baseurl"
      fi
      p="$home/.claude/.credentials.json"
      cfg_add_file ".credentials.json(OAuth)" "$p"
      if [ -f "$p" ]; then
        local token
        token="$(extract_json_key "$p" "authToken")"
        [ -z "$token" ] && token="$(extract_json_key "$p" "access_token")"
        [ -z "$token" ] && token="$(extract_json_key "$p" "token")"
        if [ -n "$token" ]; then
          CFG_AUTH_MODE="oauth"; CFG_LOGGED_IN=1; CFG_KEY_PRESENT=1; CFG_KEY_HINT="$(redact "$token")"
        fi
      fi
      ;;
    codex)
      p="$home/.codex/auth.json"
      cfg_add_file "auth.json" "$p"
      if [ -f "$p" ]; then
        local token key
        token="$(extract_json_key "$p" "access_token")"
        [ -z "$token" ] && token="$(extract_json_key "$p" "token")"
        key="$(extract_json_key "$p" "OPENAI_API_KEY")"
        if [ -n "$token" ]; then
          CFG_AUTH_MODE="oauth"; CFG_LOGGED_IN=1; CFG_KEY_PRESENT=1; CFG_KEY_HINT="$(redact "$token")"
        elif [ -n "$key" ]; then
          CFG_AUTH_MODE="api"; CFG_LOGGED_IN=1; CFG_KEY_PRESENT=1; CFG_KEY_HINT="$(redact "$key")"
        fi
      fi
      p="$home/.codex/config.toml"
      cfg_add_file "config.toml" "$p"
      if [ -f "$p" ]; then
        CFG_BASE_URL="$(grep -oE '\[model_providers\.[^]]+\][^[]*base_url[[:space:]]*=[[:space:]]*"[^"]+"' "$p" 2>/dev/null \
          | head -n1 | grep -oE 'https?://[^"]+' | head -n1)"
      fi
      ;;
    opencode)
      p="$home/.local/share/opencode/auth.json"
      cfg_add_file "auth.json" "$p"
      if [ -f "$p" ]; then
        local mode key baseurl providers
        mode="$(extract_json_key_any "$p" "type")"
        key="$(extract_json_key_any "$p" "key")"
        baseurl="$(extract_json_key_any "$p" "baseURL")"
        providers="$(grep -oE '"[a-zA-Z0-9_.-]+"[[:space:]]*:[[:space:]]*\{' "$p" 2>/dev/null | head -n3 | sed -E 's/^"([^"]+)".*/\1/' | tr '\n' ',' | sed 's/,$//')"
        if [ -n "$key" ]; then
          CFG_AUTH_MODE="$([ "$mode" = "oauth" ] && printf oauth || printf api)"
          CFG_LOGGED_IN=1; CFG_KEY_PRESENT=1; CFG_KEY_HINT="$(redact "$key")"
          [ -n "$baseurl" ] && CFG_BASE_URL="$baseurl"
        fi
        [ -n "$providers" ] && cfg_add_note "provider: $providers"
      fi
      ;;
    workbuddy)
      p="$home/.workbuddy/app/sessions.json"
      cfg_add_file "sessions.json" "$p"
      if [ -f "$p" ] && grep -q '"userId"' "$p" 2>/dev/null; then
        CFG_AUTH_MODE="oauth"; CFG_LOGGED_IN=1; CFG_KEY_PRESENT=1
        CFG_KEY_HINT="(WorkBuddy App 会话, userId 存在)"
      fi
      ;;
    *)
      if [ "$cli" = "hermes" ]; then
        cfg_add_note "Hermes 登录态由 App 管理，脚本不读取"
      else
        cfg_add_note "OpenClaw 使用自身 provider 配置，无独立凭据文件"
      fi
      ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# 端点探测（本地代理；nc，无 nc 则跳过）
# ─────────────────────────────────────────────────────────────────────────────

# $1 = baseUrl → 打印 up / down / skip / no-nc
probe_endpoint() {
  local url="$1" host port
  host="$(printf '%s' "$url" | sed -E 's#^https?://([^:/]+).*#\1#')"
  port="$(printf '%s' "$url" | sed -E 's#^https?://[^:/]+:([0-9]+).*#\1#')"
  case "$port" in *[!0-9]*) port="" ;; esac
  if [ -z "$port" ]; then
    case "$url" in https:*) port=443 ;; *) port=80 ;; esac
  fi
  case "$host" in
    127.0.0.1|localhost|0.0.0.0|::1) ;;
    *) printf 'skip'; return 0 ;;
  esac
  if command -v nc >/dev/null 2>&1; then
    if nc -z -G 1 -w 1 "$host" "$port" >/dev/null 2>&1; then printf 'up'; else printf 'down'; fi
  else
    printf 'no-nc'
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Shell 配置文件
# ─────────────────────────────────────────────────────────────────────────────

SHELL_PROFILES=".zshrc .zprofile .bashrc .bash_profile .profile .zshenv"

# 打印 shell 配置里出现在 PATH 但当前 PATH 没有的目录：一行 "file|entry"
terminal_only_path() {
  local home="$1" cur="$2" file text entry line
  for file in $SHELL_PROFILES; do
    [ -f "$home/$file" ] || continue
    while IFS= read -r line; do
      case "$line" in
        export\ PATH=*) ;;
        *) continue ;;
      esac
      entry="$(printf '%s' "$line" | sed -E 's/^[[:space:]]*export[[:space:]]+PATH=[[:space:]]*//; s/^"//; s/"$//')"
      while IFS= read -r one; do
        [ -z "$one" ] && continue
        case ":$cur:" in
          *":$one:"*) ;;
          *) printf '%s|%s\n' "$file" "$one" ;;
        esac
      done <<EOF
$(printf '%s' "$entry" | tr ':' '\n')
EOF
    done <<EOF
$(cat "$home/$file" 2>/dev/null)
EOF
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# App 数据根目录 + 外部 Agent 交叉检查
# ─────────────────────────────────────────────────────────────────────────────

candidate_data_roots() {
  local home="$1" variant_root entry
  [ -n "${ORKAS_WORKSPACE_ROOT:-}" ] && printf '%s\n' "$ORKAS_WORKSPACE_ROOT"
  printf '%s\n' "$home/.cogseed/data" "$home/.orkas/data"
  for variant_root in "$home/.cogseed/runtime-variants" "$home/.orkas/runtime-variants"; do
    for entry in "$variant_root"/*/data; do
      [ -d "$entry" ] && printf '%s\n' "$entry"
    done
  done
}

read_current_uid() {
  local root="$1" raw
  raw="$(grep -m1 -oE '"current_user_id"[[:space:]]*:[[:space:]]*"[^"]+"' "$root/users.json" 2>/dev/null)"
  [ -z "$raw" ] && return 0
  printf '%s' "$raw" | sed -E 's/^"current_user_id"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

# 扫描一个数据根里绑定 CLI 的 Agent；$1 = root, $2 = uid
# 打印 "agentId|name|cli" 一行一个
scan_cli_agents() {
  local root="$1" uid="$2" agents_dir d def id name cli
  agents_dir="$root/$uid/cloud/agents"
  [ -d "$agents_dir" ] || return 0
  for d in "$agents_dir"/*/; do
    [ -d "$d" ] || continue
    def="$d/agent.json"
    [ -f "$def" ] || continue
    if grep -q '"kind"[[:space:]]*:[[:space:]]*"cli"' "$def" 2>/dev/null; then
      id="$(basename "$d")"
      name="$(extract_json_key "$def" "name")"
      [ -z "$name" ] && name="$id"
      # runtime.cli 在 "runtime": { ... } 嵌套对象里 → 任意深度
      cli="$(extract_json_key_any "$def" "cli")"
      [ -n "$cli" ] && printf '%s|%s|%s\n' "$id" "$name" "$cli"
    fi
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# 单 CLI 检测（设置全局：CLI_TYPE BIN_FOUND BIN_PATH BIN_REAL BIN_SOURCE
#   VERSION_VALUE MIN_ERR MIN_REQUIRED NEEDS_CRED PROXY_DOWN VERDICT
#   以及 inspect_cli_config 的 CFG_*）
# ─────────────────────────────────────────────────────────────────────────────

detect_cli() {
  local type="$1" home="$2" do_probe="$3" name env_path ek
  CLI_TYPE="$type"
  BIN_FOUND=0; BIN_PATH=""; BIN_REAL=""; BIN_SOURCE=""
  VERSION_VALUE=""; MIN_ERR=""; MIN_REQUIRED=""
  NEEDS_CRED=0; PROXY_DOWN=0; VERDICT=""

  name="$(bin_name "$type")"
  env_path=""
  ek="$(env_key "$type")"
  [ -n "$ek" ] && eval "env_path=\"\${$ek:-}\""

  # 1) 二进制
  if [ -n "$env_path" ]; then
    BIN_PATH="$(which_bin "$env_path" "")"
    [ -n "$BIN_PATH" ] && BIN_SOURCE="env"
  fi
  if [ -z "$BIN_PATH" ]; then
    BIN_PATH="$(which_bin "$name" "$(search_dirs_for "$type" "$home")")"
    [ -n "$BIN_PATH" ] && BIN_SOURCE="path+search-dirs"
  fi
  if [ -n "$BIN_PATH" ]; then
    BIN_FOUND=1
    if [ -L "$BIN_PATH" ]; then
      BIN_REAL="$(readlink "$BIN_PATH" 2>/dev/null)"
      case "$BIN_REAL" in
        /*) ;;
        *) BIN_REAL="$(dirname "$BIN_PATH")/$BIN_REAL" ;;
      esac
      # 归一化（解析 ../），等价于 Node 的 fs.realpathSync
      BIN_REAL="$(cd "$(dirname "$BIN_REAL")" 2>/dev/null && pwd -P 2>/dev/null)/$(basename "$BIN_REAL")"
      [ "$BIN_REAL" = "/$(basename "$BIN_REAL")" ] && BIN_REAL=""
    fi
  fi

  # 2) 版本
  if [ "$BIN_FOUND" = "1" ] && [ "$do_probe" = "1" ]; then
    VERSION_VALUE="$(probe_cli_version "$type" "$BIN_PATH")"
    MIN_ERR="$(check_min_version "$type" "$VERSION_VALUE")"
    case "$type" in
      claude) MIN_REQUIRED="$MIN_CLAUDE" ;;
      codex)  MIN_REQUIRED="$MIN_CODEX" ;;
    esac
  fi

  # 3) 凭据 / 端点
  inspect_cli_config "$type" "$home"
  case "$type" in
    claude|codex|opencode|workbuddy) NEEDS_CRED=1 ;;
  esac
  if [ -n "$CFG_BASE_URL" ]; then
    local ep
    ep="$(probe_endpoint "$CFG_BASE_URL")"
    case "$CFG_BASE_URL" in
      *127.0.0.1*|*localhost*|*0.0.0.0*|*"::1"*) ;;
      *) ep="skip" ;;
    esac
    [ "$ep" = "down" ] && PROXY_DOWN=1
  fi

  # 4) 判定
  if [ "$BIN_FOUND" != "1" ]; then
    VERDICT="missing_binary"
  elif [ "$do_probe" = "1" ] && [ -z "$VERSION_VALUE" ]; then
    VERDICT="version_unknown"
  elif [ -n "$MIN_ERR" ]; then
    VERDICT="version_too_old"
  elif [ "$NEEDS_CRED" = "1" ] && [ "$CFG_LOGGED_IN" != "1" ]; then
    VERDICT="no_auth"
  elif [ "$PROXY_DOWN" = "1" ]; then
    VERDICT="proxy_down"
  else
    VERDICT="ok"
  fi
}

verdict_icon() {
  case "$1" in
    ok) printf 'PASS' ;;
    missing_binary) printf 'FAIL' ;;
    *) printf 'WARN' ;;
  esac
}

verdict_hint() {
  case "$1" in
    missing_binary) printf '未检测到 %s（%s）——App 不会把它列为可用 Agent；请安装对应 CLI 并确认 PATH' "$CLI_TYPE" "$(bin_name "$CLI_TYPE")" ;;
    version_unknown) printf '%s 存在但版本探测失败——在终端跑 `%s --version` 验证；App 会把它标为不可用' "$CLI_TYPE" "$(bin_name "$CLI_TYPE")" ;;
    version_too_old) printf '%s 版本过低，需要 >= %s，升级后即可使用' "$CLI_TYPE" "$MIN_REQUIRED" ;;
    no_auth) printf '%s 已安装但未登录/无 API Key 配置——运行时会被 CLI 要求登录，先完成登录' "$CLI_TYPE" ;;
    proxy_down) printf '%s 配置了本地代理但代理未运行——启动代理（如 CC Switch）或改回直连' "$CLI_TYPE" ;;
    *) printf '' ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# 期望配置快照（--export-expected / --expected）
# ─────────────────────────────────────────────────────────────────────────────

snapshot_lines() {
  printf '%s.binaryFound=%s\n' "$CLI_TYPE" "$([ "$BIN_FOUND" = "1" ] && printf 1 || printf 0)"
  printf '%s.version=%s\n' "$CLI_TYPE" "$VERSION_VALUE"
  printf '%s.authMode=%s\n' "$CLI_TYPE" "$CFG_AUTH_MODE"
  printf '%s.keyPresent=%s\n' "$CLI_TYPE" "$([ "$CFG_KEY_PRESENT" = "1" ] && printf 1 || printf 0)"
  printf '%s.baseUrl=%s\n' "$CLI_TYPE" "$CFG_BASE_URL"
}

compare_snapshot() {
  local file="$1" key expect actual field
  local pairs="binaryFound
version
authMode
keyPresent
baseUrl"
  while IFS= read -r field; do
    key="$CLI_TYPE.$field"
    expect="$(grep -m1 "^$key=" "$file" 2>/dev/null | sed "s/^$key=//")"
    case "$field" in
      binaryFound) actual="$([ "$BIN_FOUND" = "1" ] && printf 1 || printf 0)" ;;
      version) actual="$VERSION_VALUE" ;;
      authMode) actual="$CFG_AUTH_MODE" ;;
      keyPresent) actual="$([ "$CFG_KEY_PRESENT" = "1" ] && printf 1 || printf 0)" ;;
      baseUrl) actual="$CFG_BASE_URL" ;;
    esac
    if [ "$expect" != "$actual" ]; then
      printf '[DIFF] %s %s: 期望 %s, 实际 %s\n' "$CLI_TYPE" "$field" "${expect:-（空）}" "${actual:-（空）}"
    fi
  done <<EOF
$pairs
EOF
}

# ─────────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
用法: bash diagnose-local-agents.sh [选项]

检测本机外部（本地 CLI）Agent 无法使用的原因（无需 Node.js）。

选项:
  --json                  以 JSON 输出（机器可读）
  --only <a,b,c>          只检测指定 CLI（claude,codex,openclaw,opencode,hermes,workbuddy）
  --no-version-probe      跳过版本探测子进程（快速模式）
  --expected <file>       与已知良好配置快照对比（用 --export-expected 生成）
  --export-expected <file> 把本机配置状态导出为脱敏快照
  --home <dir>            指定要检查的 HOME（排查其他用户/机器时用）
  --data-root <dir>       指定应用数据根目录
  --help, -h              显示帮助

示例:
  bash diagnose-local-agents.sh
  bash diagnose-local-agents.sh --json
  bash diagnose-local-agents.sh --export-expected ./known-good.txt
  bash diagnose-local-agents.sh --expected ./known-good.txt
EOF
}

main() {
  local JSON=0 DO_PROBE=1 ONLY="" EXPECTED="" EXPORT_EXPECTED="" HOME_DIR="" DATA_ROOT=""
  local arg

  while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) JSON=1 ;;
      --no-version-probe) DO_PROBE=0 ;;
      --only)
        shift; [ $# -ge 1 ] || { printf '--only 需要一个值\n' >&2; return 2; }
        ONLY="$1"
        ;;
      --only=*) ONLY="${arg#--only=}" ;;
      --expected)
        shift; [ $# -ge 1 ] || { printf '--expected 需要一个文件路径\n' >&2; return 2; }
        EXPECTED="$1"
        ;;
      --export-expected)
        shift; [ $# -ge 1 ] || { printf '--export-expected 需要一个文件路径\n' >&2; return 2; }
        EXPORT_EXPECTED="$1"
        ;;
      --home)
        shift; [ $# -ge 1 ] || { printf '--home 需要一个目录\n' >&2; return 2; }
        HOME_DIR="$1"
        ;;
      --data-root)
        shift; [ $# -ge 1 ] || { printf '--data-root 需要一个目录\n' >&2; return 2; }
        DATA_ROOT="$1"
        ;;
      --help|-h) usage; return 0 ;;
      *) printf '未知参数: %s\n' "$arg" >&2; usage >&2; return 2 ;;
    esac
    shift
  done

  local home="${HOME_DIR:-$HOME}"
  local types="$CLI_TYPES"
  if [ -n "$ONLY" ]; then
    types="$(printf '%s' "$ONLY" | tr ',' ' ')"
  fi

  local type json_clis="" json_first=1 any_fail=0

  # ── 头 ──
  if [ "$JSON" = "0" ]; then
    printf '══════════════════════════════════════════════════════════════\n'
    printf '  外部 Agent（本地 CLI）环境诊断报告 (bash 版, 无需 Node)\n'
    printf '  时间: %s   平台: %s %s   Shell: %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(uname -s)" "$(uname -m)" "${SHELL:-bash}"
    printf '══════════════════════════════════════════════════════════════\n\n'
    printf '【机器信息】\n'
    printf '  HOME: %s\n' "$home"
    if command -v node >/dev/null 2>&1; then
      printf '  node: %s (已安装)\n' "$(node -v 2>/dev/null)"
    else
      printf '  [WARN] 系统没有 node —— npm 安装的 CLI（opencode/openclaw，及 npm 方式的 claude/codex）都装不了\n'
    fi
    printf '  PATH 目录数: %s\n' "$(printf '%s' "${PATH:-}" | tr ':' '\n' | grep -c .)"
    printf '\n'
    printf '【Shell 配置文件】(GUI 启动的 App 不会加载这些文件)\n'
    local tpo out
    tpo="$(terminal_only_path "$home" "${PATH:-}")"
    if [ -z "$tpo" ]; then
      printf '  (未发现“终端有、当前 PATH 没有”的目录)\n'
    else
      while IFS= read -r out; do
        printf '  [WARN] %s 里的 PATH 在终端才生效: %s —— 终端能跑、App 里找不到二进制时检查这里\n' "${out%%|*}" "${out#*|}"
      done <<EOF
$tpo
EOF
    fi
    printf '\n'
    printf '【CLI Agent 检测】(与 App 的 localAgents.list 一致)\n'
  fi

  # ── 逐 CLI 检测 ──
  for type in $types; do
    detect_cli "$type" "$home" "$DO_PROBE"

    case "$VERDICT" in
      missing_binary|version_too_old|version_unknown) any_fail=1 ;;
    esac

    if [ "$JSON" = "0" ]; then
      printf '  %s  %s  (%s)\n' "$(verdict_icon "$VERDICT")" "$type" "$(bin_name "$type")"
      if [ "$BIN_FOUND" = "1" ]; then
        if [ -n "$BIN_REAL" ] && [ "$BIN_REAL" != "$BIN_PATH" ]; then
          printf '      binary: %s -> %s (%s)\n' "$BIN_PATH" "$BIN_REAL" "$BIN_SOURCE"
        else
          printf '      binary: %s (%s)\n' "$BIN_PATH" "$BIN_SOURCE"
        fi
        if [ "$DO_PROBE" = "0" ]; then
          printf '      version: (已跳过版本探测 --no-version-probe)\n'
        else
          printf '      version: %s%s\n' "${VERSION_VALUE:-(探测失败)}" "$([ -n "$MIN_REQUIRED" ] && printf ' (要求 >= %s)' "$MIN_REQUIRED")"
        fi
      else
        printf '      binary: 未找到\n'
      fi
      if [ "$VERDICT" = "version_unknown" ]; then
        printf '      状态: version_unknown —— `%s --version` 无输出或无法解析\n' "$BIN_PATH"
      fi
      [ -n "$MIN_ERR" ] && printf '      状态: version_too_old — %s\n' "$MIN_ERR"
      if [ -n "$CFG_FILES" ]; then
        while IFS='|' read -r label exists err; do
          if [ "$exists" = "1" ]; then
            printf '      config: %s: 存在%s\n' "$label" "$([ -n "$err" ] && printf ' (解析失败: %s)' "$err")"
          else
            printf '      config: %s: 不存在\n' "$label"
          fi
        done <<EOF
$(printf '%b\n' "$CFG_FILES")
EOF
      fi
      if [ "$CFG_KEY_PRESENT" = "1" ]; then
        printf '      凭据: %s (%s)\n' "${CFG_AUTH_MODE:-unknown}" "$CFG_KEY_HINT"
      elif [ "$NEEDS_CRED" = "1" ]; then
        printf '      凭据: 未找到\n'
      fi
      if [ -n "$CFG_BASE_URL" ]; then
        local ep ep_txt
        ep="$(probe_endpoint "$CFG_BASE_URL")"
        case "$CFG_BASE_URL" in
          *127.0.0.1*|*localhost*|*0.0.0.0*|*"::1"*) ;;
          *) ep="skip" ;;
        esac
        case "$ep" in
          up) ep_txt="可达" ;;
          down) ep_txt="不可达" ;;
          skip) ep_txt="远端端点,不探测" ;;
          no-nc) ep_txt="无 nc,跳过" ;;
          *) ep_txt="" ;;
        esac
        printf '      端点: %s%s\n' "$CFG_BASE_URL" "$([ -n "$ep_txt" ] && printf ' (%s)' "$ep_txt")"
      fi
      if [ -n "$CFG_NOTES" ]; then
        while IFS= read -r note; do
          printf '      note: %s\n' "$note"
        done <<EOF
$(printf '%b\n' "$CFG_NOTES")
EOF
      fi
      local hint
      hint="$(verdict_hint "$VERDICT")"
      [ -n "$hint" ] && printf '      → %s\n' "$hint"
      printf '\n'
    else
      local entry
      entry="$(printf '{"type":"%s","binName":"%s","binary":{"found":%s,"path":"%s","source":"%s"},"version":"%s","minRequired":"%s","verdict":"%s","authMode":"%s","loggedIn":%s,"keyPresent":%s,"baseUrl":"%s"}' \
        "$(json_escape "$type")" "$(json_escape "$(bin_name "$type")")" \
        "$([ "$BIN_FOUND" = "1" ] && printf true || printf false)" \
        "$(json_escape "$BIN_PATH")" "$(json_escape "$BIN_SOURCE")" \
        "$(json_escape "$VERSION_VALUE")" "$(json_escape "$MIN_REQUIRED")" \
        "$VERDICT" "$(json_escape "$CFG_AUTH_MODE")" \
        "$([ "$CFG_LOGGED_IN" = "1" ] && printf true || printf false)" \
        "$([ "$CFG_KEY_PRESENT" = "1" ] && printf true || printf false)" \
        "$(json_escape "$CFG_BASE_URL")")"
      if [ "$json_first" = "1" ]; then json_clis="$entry"; json_first=0; else json_clis="$json_clis,$entry"; fi
    fi
  done

  # ── 期望配置导出 / 对比 ──
  if [ -n "$EXPORT_EXPECTED" ]; then
    if ! : > "$EXPORT_EXPECTED" 2>/dev/null; then
      printf '无法写入 %s\n' "$EXPORT_EXPECTED" >&2
      return 2
    fi
    for type in $types; do
      detect_cli "$type" "$home" "$DO_PROBE"
      snapshot_lines >> "$EXPORT_EXPECTED"
    done
    [ "$JSON" = "0" ] && printf '已导出期望配置快照 → %s\n' "$EXPORT_EXPECTED"
  fi

  if [ -n "$EXPECTED" ]; then
    if [ ! -f "$EXPECTED" ]; then
      printf '无法读取期望快照 %s\n' "$EXPECTED" >&2
      return 2
    fi
    local diff_count=0 dl
    [ "$JSON" = "0" ] && printf '【与期望配置对比】\n'
    for type in $types; do
      detect_cli "$type" "$home" "$DO_PROBE"
      dl="$(compare_snapshot "$EXPECTED")"
      if [ -n "$dl" ]; then
        diff_count=$((diff_count + 1))
        [ "$JSON" = "0" ] && printf '%s\n' "$dl"
      fi
    done
    if [ "$diff_count" = "0" ] && [ "$JSON" = "0" ]; then
      printf '  本机配置与期望快照一致 ✓\n'
    fi
    [ "$JSON" = "0" ] && printf '\n'
  fi

  # ── App 数据交叉检查 ──
  if [ "$JSON" = "0" ]; then
    printf '【App 内的外部 Agent 交叉检查】(agent.json 绑定 CLI 的 Agent)\n'
  fi
  local roots="" uid agent_row agent_id agent_name agent_cli shown=0 root seen_ids="|"
  if [ -n "$DATA_ROOT" ]; then
    [ -f "$DATA_ROOT/users.json" ] && roots="$DATA_ROOT"
  else
    roots="$(candidate_data_roots "$home")"
  fi
  for root in $roots; do
    uid="$(read_current_uid "$root")"
    [ -z "$uid" ] && continue
    while IFS='|' read -r agent_id agent_name agent_cli; do
      [ -z "$agent_id" ] && continue
      # 跨数据根去重（同一 agentId+cli 只报一次）
      case "$seen_ids" in
        *"|$agent_id:$agent_cli|"*) continue ;;
      esac
      seen_ids="$seen_ids$agent_id:$agent_cli|"
      shown=1
      if ! printf '%s' "$types" | tr ' ' '\n' | grep -qx "$agent_cli"; then
        [ "$JSON" = "0" ] && printf '  [FAIL] Agent "%s" (id: %s, cli: %s) —— runtime.cli 不是已知类型\n' "$agent_name" "$agent_id" "$agent_cli"
        any_fail=1
        continue
      fi
      detect_cli "$agent_cli" "$home" "$DO_PROBE"
      case "$VERDICT" in
        missing_binary)
          [ "$JSON" = "0" ] && printf '  [FAIL] Agent "%s" (id: %s, cli: %s)\n        本机未找到 %s（%s）——这就是「App 里显示、但本机根本没有」的原因。同步来的 Agent 只在创建它的机器上可用。\n' "$agent_name" "$agent_id" "$agent_cli" "$agent_cli" "$(bin_name "$agent_cli")"
          any_fail=1 ;;
        version_unknown)
          [ "$JSON" = "0" ] && printf '  [WARN] Agent "%s" (id: %s, cli: %s)\n        %s 已安装但版本探测失败\n' "$agent_name" "$agent_id" "$agent_cli" "$agent_cli" ;;
        version_too_old)
          [ "$JSON" = "0" ] && printf '  [WARN] Agent "%s" (id: %s, cli: %s)\n        %s\n' "$agent_name" "$agent_id" "$agent_cli" "$MIN_ERR" ;;
        no_auth)
          [ "$JSON" = "0" ] && printf '  [WARN] Agent "%s" (id: %s, cli: %s)\n        %s 已安装但未登录/无凭据——派发时会被 CLI 拒绝\n' "$agent_name" "$agent_id" "$agent_cli" "$agent_cli" ;;
        proxy_down)
          [ "$JSON" = "0" ] && printf '  [WARN] Agent "%s" (id: %s, cli: %s)\n        %s 配置的本地代理未运行\n' "$agent_name" "$agent_id" "$agent_cli" "$agent_cli" ;;
        *)
          [ "$JSON" = "0" ] && printf '  [OK] Agent "%s" (id: %s, cli: %s)\n' "$agent_name" "$agent_id" "$agent_cli" ;;
      esac
    done <<EOF
$(scan_cli_agents "$root" "$uid")
EOF
  done
  if [ "$shown" = "0" ] && [ "$JSON" = "0" ]; then
    printf '  (未在应用数据中找到绑定 CLI 的外部 Agent，或未找到应用数据目录)\n'
  fi

  # ── 输出 ──
  if [ "$JSON" = "1" ]; then
    printf '{"generatedAt":"%s","platform":"%s","arch":"%s","shell":"bash","home":"%s","clis":[%s]}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(uname -s)" "$(uname -m)" \
      "$(json_escape "$home")" "$json_clis"
  else
    printf '══════════════════════════════════════════════════════════════\n'
  fi

  [ "$any_fail" = "1" ] && return 1
  return 0
}

main "$@"
