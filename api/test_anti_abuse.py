import os
import sys
import unittest
from unittest.mock import patch
from starlette.requests import Request
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(__file__))

from index import (
    _client_ip,
    _rate_limit,
    _check_rate_limit,
    _motion_quota,
    _mind_map_quota,
    _check_and_increment_motion_quota,
    _check_and_increment_mind_map_quota,
    _resolve_motion_credentials,
    _resolve_mind_map_credentials,
    MOTION_FREE_LIMIT,
    MIND_MAP_FREE_LIMIT,
)


def make_request(headers=None, client_host=None):
    raw_headers = [
        (k.lower().encode("latin-1"), v.encode("latin-1"))
        for k, v in (headers or {}).items()
    ]
    scope = {
        "type": "http",
        "headers": raw_headers,
        "client": (client_host, 12345) if client_host else None,
    }
    return Request(scope)


class TestClientIpResolution(unittest.TestCase):
    def test_spoofed_leftmost_x_forwarded_for_rejected(self):
        # When an attacker sends X-Forwarded-For: "spoofed_ip, trusted_ip",
        # the rightmost (last non-empty) value must be returned as the trusted hop.
        req = make_request({"x-forwarded-for": "1.2.3.4, 203.0.113.195"})
        self.assertEqual(_client_ip(req), "203.0.113.195")

    def test_multiple_proxy_hops_picks_rightmost(self):
        req = make_request({"x-forwarded-for": "10.0.0.1, 10.0.0.2, 198.51.100.42"})
        self.assertEqual(_client_ip(req), "198.51.100.42")

    def test_x_forwarded_for_single_ip(self):
        req = make_request({"x-forwarded-for": "198.51.100.1"})
        self.assertEqual(_client_ip(req), "198.51.100.1")

    def test_x_forwarded_for_whitespace_and_empty_segments(self):
        req = make_request({"x-forwarded-for": "  , 10.0.0.1 , 203.0.113.88 ,  "})
        self.assertEqual(_client_ip(req), "203.0.113.88")

    def test_x_vercel_forwarded_for_wins_when_present(self):
        # x-vercel-forwarded-for is set by Vercel edge and takes highest priority
        req = make_request({
            "x-vercel-forwarded-for": "198.51.100.10, 10.0.0.1",
            "x-real-ip": "10.0.0.2",
            "x-forwarded-for": "spoofed.ip.1, 10.0.0.3"
        })
        self.assertEqual(_client_ip(req), "198.51.100.10")

    def test_x_real_ip_precedence_over_x_forwarded_for(self):
        req = make_request({
            "x-real-ip": "198.51.100.50",
            "x-forwarded-for": "spoofed.ip.1, 10.0.0.3"
        })
        self.assertEqual(_client_ip(req), "198.51.100.50")

    def test_direct_client_host_fallback(self):
        req = make_request({}, client_host="192.168.1.55")
        self.assertEqual(_client_ip(req), "192.168.1.55")

    def test_unknown_fallback_when_no_info(self):
        req = make_request({})
        self.assertEqual(_client_ip(req), "unknown")


class TestFreeTierQuotas(unittest.TestCase):
    def setUp(self):
        _motion_quota.clear()
        _mind_map_quota.clear()
        _rate_limit.clear()

    @patch.dict(os.environ, {"MOTION_SERVER_CLAUDE_KEY": "sk-server-test-key"})
    def test_motion_quota_shared_across_different_client_ids_same_ip(self):
        ip = "203.0.113.10"
        # 1st request with client-id-1
        req1 = make_request({"x-client-id": "device-A", "x-forwarded-for": ip})
        provider, key, used_server = _resolve_motion_credentials(req1)
        self.assertTrue(used_server)
        self.assertEqual(_motion_quota[ip], 1)

        # 2nd request with client-id-2 from same IP shares the same quota bucket
        req2 = make_request({"x-client-id": "device-B", "x-forwarded-for": ip})
        _resolve_motion_credentials(req2)
        self.assertEqual(_motion_quota[ip], 2)

        # 3rd request with client-id-3 reaches limit (MOTION_FREE_LIMIT = 3)
        req3 = make_request({"x-client-id": "device-C", "x-forwarded-for": ip})
        _resolve_motion_credentials(req3)
        self.assertEqual(_motion_quota[ip], 3)

        # 4th request from same IP must be rejected even with a completely new client-id
        req4 = make_request({"x-client-id": "device-D-spoofed", "x-forwarded-for": ip})
        with self.assertRaises(HTTPException) as ctx:
            _resolve_motion_credentials(req4)
        self.assertEqual(ctx.exception.status_code, 402)
        self.assertIn("free Motion Studio generations", ctx.exception.detail)

    @patch.dict(os.environ, {"MOTION_SERVER_CLAUDE_KEY": "sk-server-test-key"})
    def test_motion_quota_missing_client_id_still_counts_against_ip(self):
        ip = "203.0.113.20"
        # Omission of X-Client-Id does not bypass IP quota
        for _ in range(MOTION_FREE_LIMIT):
            req = make_request({"x-forwarded-for": ip})
            _resolve_motion_credentials(req)
        self.assertEqual(_motion_quota[ip], MOTION_FREE_LIMIT)

        # Next request fails
        req_over = make_request({"x-forwarded-for": ip})
        with self.assertRaises(HTTPException) as ctx:
            _resolve_motion_credentials(req_over)
        self.assertEqual(ctx.exception.status_code, 402)

    @patch.dict(os.environ, {"MOTION_SERVER_CLAUDE_KEY": "sk-server-test-key"})
    def test_byok_skips_motion_quota_even_when_ip_exhausted(self):
        ip = "203.0.113.30"
        _motion_quota[ip] = MOTION_FREE_LIMIT  # Quota exhausted for this IP

        req_byok = make_request({
            "x-forwarded-for": ip,
            "x-llm-provider": "claude",
            "x-llm-api-key": "sk-ant-user-provided-key"
        })
        provider, key, used_server = _resolve_motion_credentials(req_byok)
        self.assertEqual(provider, "claude")
        self.assertEqual(key, "sk-ant-user-provided-key")
        self.assertFalse(used_server)
        self.assertEqual(_motion_quota[ip], MOTION_FREE_LIMIT)  # Quota untouched

    @patch.dict(os.environ, {"MOTION_SERVER_CLAUDE_KEY": "sk-server-test-key"})
    def test_mind_map_quota_shared_across_different_client_ids_same_ip(self):
        ip = "203.0.113.40"
        # First 3 requests with varying client IDs
        for i in range(MIND_MAP_FREE_LIMIT):
            req = make_request({
                "x-client-id": f"device-mind-map-{i}",
                "x-forwarded-for": ip
            })
            provider, key, used_server = _resolve_mind_map_credentials(req)
            self.assertTrue(used_server)

        self.assertEqual(_mind_map_quota[ip], MIND_MAP_FREE_LIMIT)

        # 4th request rejected
        req_over = make_request({
            "x-client-id": "device-mind-map-new",
            "x-forwarded-for": ip
        })
        with self.assertRaises(HTTPException) as ctx:
            _resolve_mind_map_credentials(req_over)
        self.assertEqual(ctx.exception.status_code, 402)
        self.assertIn("free Mind Map generations", ctx.exception.detail)

    @patch.dict(os.environ, {"MOTION_SERVER_CLAUDE_KEY": "sk-server-test-key"})
    def test_mind_map_byok_skips_quota(self):
        ip = "203.0.113.50"
        _mind_map_quota[ip] = MIND_MAP_FREE_LIMIT

        req_byok = make_request({
            "x-forwarded-for": ip,
            "x-llm-provider": "gemini",
            "x-llm-api-key": "AIzaSyTestUserKey"
        })
        provider, key, used_server = _resolve_mind_map_credentials(req_byok)
        self.assertEqual(provider, "gemini")
        self.assertEqual(key, "AIzaSyTestUserKey")
        self.assertFalse(used_server)
        self.assertEqual(_mind_map_quota[ip], MIND_MAP_FREE_LIMIT)


class TestRateLimiting(unittest.TestCase):
    def setUp(self):
        _rate_limit.clear()

    def test_rate_limit_uses_trusted_ip(self):
        trusted_ip = "198.51.100.77"
        # 10 requests from same trusted IP using spoofed leftmost header
        for _ in range(10):
            req = make_request({"x-forwarded-for": f"spoofed.{_}.ip, {trusted_ip}"})
            ip = _client_ip(req)
            self.assertEqual(ip, trusted_ip)
            _check_rate_limit(ip)

        # 11th request must trigger rate limit
        req_11 = make_request({"x-forwarded-for": f"different.spoofed.ip, {trusted_ip}"})
        with self.assertRaises(HTTPException) as ctx:
            _check_rate_limit(_client_ip(req_11))
        self.assertEqual(ctx.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
