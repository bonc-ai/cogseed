# ============================================================
# Skill Security Scanner — 沙箱运行镜像
# ------------------------------------------------------------
# 设计要点：
#   - 非 root 用户运行（scanner:scanner, uid 10001）
#   - 预装 gitleaks / osv-scanner / binutils(strings)，避免运行时联网拉取
#   - 离线漏洞库：osv-scanner 使用本地数据库，运行时容器可完全断网
#   - 被测 Skill 只读挂载到 /target，扫描器无写权限
#   - 报告写到 /reports（唯一可写挂载点）
# 版本全部 pin，不用 latest/main（否则会被扫描器自己的 SR-06 判为不合规）
# ============================================================
FROM python:3.12-slim AS base

# ---- pin 版本 ----
ARG GITLEAKS_VERSION=8.18.4
ARG OSV_SCANNER_VERSION=1.9.2

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# binutils 提供 strings；ca-certificates 仅构建期需要
RUN apt-get update \
    && apt-get install --no-install-recommends -y binutils curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- gitleaks（密钥扫描）----
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gl_arch="x64" ;; \
      arm64) gl_arch="arm64" ;; \
      *) gl_arch="x64" ;; \
    esac; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gl_arch}.tar.gz" -o /tmp/gl.tgz; \
    tar -xzf /tmp/gl.tgz -C /usr/local/bin gitleaks; \
    rm -f /tmp/gl.tgz; \
    gitleaks version

# ---- osv-scanner（依赖漏洞 CVE）----
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) osv_arch="amd64" ;; \
      arm64) osv_arch="arm64" ;; \
      *) osv_arch="amd64" ;; \
    esac; \
    curl -fsSL "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${osv_arch}" -o /usr/local/bin/osv-scanner; \
    chmod +x /usr/local/bin/osv-scanner; \
    osv-scanner --version || true

# ---- pyyaml（可选，用于加载外部规则库）----
RUN pip install --no-cache-dir "pyyaml==6.0.2"

# ---- 拷入扫描器代码，保持 01_scanner / 02_rules 同级结构 ----
WORKDIR /app
COPY 01_scanner/ /app/01_scanner/
COPY 02_rules/ /app/02_rules/

# ---- 非 root 用户 ----
RUN groupadd -g 10001 scanner \
    && useradd -u 10001 -g scanner -m -s /usr/sbin/nologin scanner \
    && mkdir -p /reports \
    && chown -R scanner:scanner /reports
USER scanner

# 入口：扫描只读挂载的 /target，报告写到 /reports
ENTRYPOINT ["python3", "/app/01_scanner/skill_security_scanner.py"]
CMD ["--artifact", "/target", "--output", "/reports/report.json", "--fail-on", "DO_NOT_INSTALL"]
