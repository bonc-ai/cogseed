#!/usr/bin/env python3
"""url_safety 的测试。攻击地址在这里是断言输入，不是攻击载荷。"""
import unittest

from scripts.url_safety import is_safe_ip


class TestIsSafeIp(unittest.TestCase):
    def test_rejects_cloud_metadata(self):
        self.assertFalse(is_safe_ip("169.254.169.254"))

    def test_rejects_private_ranges(self):
        for ip in ("10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1"):
            self.assertFalse(is_safe_ip(ip))

    def test_allows_public(self):
        self.assertTrue(is_safe_ip("8.8.8.8"))
