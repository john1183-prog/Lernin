import os
import sys
import unittest
from unittest.mock import patch, MagicMock
import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

from index import app

client = TestClient(app)


class TestErrorSanitization(unittest.TestCase):
    """Verify client-facing responses never leak exception types, stack traces,
    or raw upstream provider bodies."""

    def test_generate_motion_unexpected_500_sanitized(self):
        with patch("index._call_claude_motion", side_effect=RuntimeError("SensitiveDatabaseConnectionLeak")):
            resp = client.post(
                "/api/generate-motion",
                json={"topic": "mitochondria and atp"},
                headers={"X-LLM-Api-Key": "test-key", "X-LLM-Provider": "claude"},
            )
            self.assertEqual(resp.status_code, 500)
            data = resp.json()
            self.assertEqual(data["detail"], "Motion generation failed. Please try again.")
            self.assertNotIn("RuntimeError", resp.text)
            self.assertNotIn("SensitiveDatabaseConnectionLeak", resp.text)

    def test_generate_motion_gemini_502_raw_body_not_leaked(self):
        mock_resp = httpx.Response(
            status_code=503,
            text='{"error": "RAW_INTERNAL_GEMINI_UPSTREAM_BODY_LEAK"}',
            request=httpx.Request("POST", "https://generativelanguage.googleapis.com"),
        )
        with patch("index._call_gemini_motion", side_effect=httpx.HTTPStatusError("Service Unavailable", request=mock_resp.request, response=mock_resp)):
            resp = client.post(
                "/api/generate-motion",
                json={"topic": "mitochondria and atp"},
                headers={"X-LLM-Api-Key": "test-key", "X-LLM-Provider": "gemini"},
            )
            self.assertEqual(resp.status_code, 502)
            data = resp.json()
            self.assertEqual(data["detail"], "Gemini error: 503")
            self.assertNotIn("RAW_INTERNAL_GEMINI_UPSTREAM_BODY_LEAK", resp.text)
            self.assertNotIn("HTTPStatusError", resp.text)

    def test_expand_motion_script_unexpected_500_sanitized(self):
        valid_motion = {
            "scene": {"name": "Test Scene", "duration": 10},
            "layers": [{"name": "layer1", "type": "text", "text": "Hello"}]
        }
        with patch("index.expand_script", side_effect=TypeError("UnexpectedNoneTypeDereference")):
            resp = client.post(
                "/api/expand-motion-script",
                json=valid_motion,
            )
            self.assertEqual(resp.status_code, 500)
            data = resp.json()
            self.assertEqual(data["detail"], "Motion script expansion failed. Please try again.")
            self.assertNotIn("TypeError", resp.text)
            self.assertNotIn("UnexpectedNoneTypeDereference", resp.text)

    def test_generate_mind_map_unexpected_500_sanitized(self):
        with patch("index._call_claude_mind_map", side_effect=KeyError("missing_internal_dict_key")):
            resp = client.post(
                "/api/generate-mind-map",
                json={"text": "A" * 100},
                headers={"X-LLM-Api-Key": "test-key", "X-LLM-Provider": "claude"},
            )
            self.assertEqual(resp.status_code, 500)
            data = resp.json()
            self.assertEqual(data["detail"], "Mind map generation failed. Please try again.")
            self.assertNotIn("KeyError", resp.text)
            self.assertNotIn("missing_internal_dict_key", resp.text)

    def test_generate_mind_map_gemini_502_raw_body_not_leaked(self):
        mock_resp = httpx.Response(
            status_code=500,
            text='{"error": "RAW_GEMINI_INTERNAL_STACK_TRACE_LEAK"}',
            request=httpx.Request("POST", "https://generativelanguage.googleapis.com"),
        )
        with patch("index._call_gemini_mind_map", side_effect=httpx.HTTPStatusError("Server Error", request=mock_resp.request, response=mock_resp)):
            resp = client.post(
                "/api/generate-mind-map",
                json={"text": "B" * 100},
                headers={"X-LLM-Api-Key": "test-key", "X-LLM-Provider": "gemini"},
            )
            self.assertEqual(resp.status_code, 502)
            data = resp.json()
            self.assertEqual(data["detail"], "Gemini error: 500")
            self.assertNotIn("RAW_GEMINI_INTERNAL_STACK_TRACE_LEAK", resp.text)
            self.assertNotIn("HTTPStatusError", resp.text)

    def test_expand_mind_map_unexpected_500_sanitized(self):
        valid_tree = {
            "root": {
                "title": "Root Node",
                "detail": "Summary text",
                "children": [
                    {"title": "Child 1", "detail": "Detail 1", "children": []},
                    {"title": "Child 2", "detail": "Detail 2", "children": []},
                ],
            }
        }
        with patch("index.expand_mind_map", side_effect=IndexError("list_index_out_of_range")):
            resp = client.post(
                "/api/expand-mind-map",
                json=valid_tree,
            )
            self.assertEqual(resp.status_code, 500)
            data = resp.json()
            self.assertEqual(data["detail"], "Mind map expansion failed. Please try again.")
            self.assertNotIn("IndexError", resp.text)
            self.assertNotIn("list_index_out_of_range", resp.text)

    def test_generate_cards_unexpected_500_sanitized(self):
        with patch("index._call_claude", side_effect=ValueError("InternalCardParserFailure")):
            resp = client.post(
                "/api/generate-cards",
                json={"text": "This is a valid long text for generating flashcards."},
                headers={"X-LLM-Api-Key": "test-key", "X-LLM-Provider": "claude"},
            )
            self.assertEqual(resp.status_code, 500)
            data = resp.json()
            self.assertEqual(data["detail"], "Card generation failed. Please try again.")
            self.assertNotIn("ValueError", resp.text)
            self.assertNotIn("InternalCardParserFailure", resp.text)

    def test_generate_cards_gemini_502_raw_body_not_leaked(self):
        mock_resp = httpx.Response(
            status_code=502,
            text='{"raw": "INTERNAL_UPSTREAM_PROMPT_ECHO"}',
            request=httpx.Request("POST", "https://generativelanguage.googleapis.com"),
        )
        with patch("index._call_gemini", side_effect=httpx.HTTPStatusError("Bad Gateway", request=mock_resp.request, response=mock_resp)):
            resp = client.post(
                "/api/generate-cards",
                json={"text": "This is a valid long text for generating flashcards."},
                headers={"X-LLM-Api-Key": "test-key", "X-LLM-Provider": "gemini"},
            )
            self.assertEqual(resp.status_code, 502)
            data = resp.json()
            self.assertEqual(data["detail"], "Gemini error: 502")
            self.assertNotIn("INTERNAL_UPSTREAM_PROMPT_ECHO", resp.text)

    def test_generate_cards_vision_unexpected_500_sanitized(self):
        with patch("index._call_claude_vision", side_effect=RuntimeError("VisionEngineCrash")):
            files = {"file": ("test.png", b"fake_png_data", "image/png")}
            data = {"deck_id": "test_deck"}
            resp = client.post(
                "/api/generate-cards-vision",
                files=files,
                data=data,
                headers={"X-LLM-Api-Key": "test-key", "X-LLM-Provider": "claude"},
            )
            self.assertEqual(resp.status_code, 500)
            resp_data = resp.json()
            self.assertEqual(resp_data["detail"], "Card generation failed. Please try again.")
            self.assertNotIn("RuntimeError", resp.text)
            self.assertNotIn("VisionEngineCrash", resp.text)

    def test_extract_ppt_text_unexpected_500_sanitized(self):
        with patch("index._extract_ppt_text", side_effect=RuntimeError("PptExtractionCrash")):
            files = {"file": ("slides.pptx", b"fake_pptx_data", "application/vnd.openxmlformats-officedocument.presentationml.presentation")}
            resp = client.post(
                "/api/extract-ppt-text",
                files=files,
            )
            self.assertEqual(resp.status_code, 500)
            data = resp.json()
            self.assertEqual(data["detail"], "PowerPoint text extraction failed. Please try again.")
            self.assertNotIn("RuntimeError", resp.text)
            self.assertNotIn("PptExtractionCrash", resp.text)


if __name__ == "__main__":
    unittest.main()
