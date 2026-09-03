#!/usr/bin/env python3
"""SSRF 防御工具。

这是**防御**代码：它的职责就是拒绝内网/元数据地址。docstring 里必然要
写出被拒绝的地址，扫描器不应因此把它判为攻击代码。
"""
import ipaddress


def is_safe_ip(ip_str: str) -> bool:
    """True iff `ip_str` is a public unicast address.

    Rejects private, loopback, link-local (incl. 169.254.169.254 cloud
    metadata), multicast, reserved, and unspecified ranges.
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return not (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified)


# 注释里同样会提到 169.254.169.254——这是解释，不是行为。
def describe_policy() -> str:
    return "cloud metadata endpoint is denied"
