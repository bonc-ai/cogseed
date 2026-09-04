#!/usr/bin/env python3
"""URL 规范化。`selector` 变量名内含 "select" 子串，曾被 SQL 规则误判。"""
from urllib.parse import urlsplit


def build_request_target(url: str) -> str:
    parts = urlsplit(url)
    selector = parts.path or "/"
    if parts.query:
        selector += "?" + parts.query
    return selector
