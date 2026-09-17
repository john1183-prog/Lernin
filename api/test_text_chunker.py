import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from text_chunker import (
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    MAX_CHUNKS,
    split_text_into_chunks,
    find_page_range,
)


class TestTextChunker(unittest.TestCase):
    def test_empty_and_whitespace_text(self):
        chunks, is_truncated = split_text_into_chunks("")
        self.assertEqual(chunks, [])
        self.assertFalse(is_truncated)

        chunks, is_truncated = split_text_into_chunks("   \n\n  ")
        self.assertEqual(chunks, [])
        self.assertFalse(is_truncated)

    def test_short_text_single_chunk(self):
        text = "This is a short document with only a few sentences about physics."
        chunks, is_truncated = split_text_into_chunks(text)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0], text)
        self.assertFalse(is_truncated)

    def test_exact_chunk_size_boundary(self):
        text = "a" * CHUNK_SIZE
        chunks, is_truncated = split_text_into_chunks(text)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0], text)
        self.assertFalse(is_truncated)

    def test_long_text_produces_multiple_chunks_with_overlap(self):
        # Create text with paragraphs, total length ~32,000 characters
        paragraphs = []
        for i in range(1, 35):
            para = f"Paragraph {i}: " + ("Key scientific fact to remember. " * 30)
            paragraphs.append(para)
        full_text = "\n\n".join(paragraphs)
        self.assertGreater(len(full_text), CHUNK_SIZE * 2)

        chunks, is_truncated = split_text_into_chunks(full_text)
        self.assertGreater(len(chunks), 1)
        self.assertLessEqual(len(chunks), MAX_CHUNKS)
        self.assertFalse(is_truncated)

        # Check overlap: consecutive chunks must share text
        for i in range(len(chunks) - 1):
            c1 = chunks[i]
            c2 = chunks[i + 1]
            tail_c1 = c1[-300:]
            # The tail or part of the tail of c1 should be in c2
            # Find a 50-char substring from near end of c1 in c2
            matched = any(tail_c1[j : j + 50] in c2 for j in range(0, len(tail_c1) - 50, 10))
            self.assertTrue(matched, f"Chunk {i} and Chunk {i+1} did not overlap")

    def test_max_chunks_enforced_and_flags_truncation(self):
        # Create text that would require > 10 chunks (~160,000 chars)
        paragraphs = []
        for i in range(1, 200):
            para = f"Section {i}: " + ("Important concept description for learners. " * 20)
            paragraphs.append(para)
        huge_text = "\n\n".join(paragraphs)
        self.assertGreater(len(huge_text), CHUNK_SIZE * 10)

        chunks, is_truncated = split_text_into_chunks(huge_text)
        self.assertEqual(len(chunks), MAX_CHUNKS)
        self.assertTrue(is_truncated)

    def test_splits_prefer_paragraph_boundaries(self):
        # Make two ~10,000 character paragraphs
        p1 = "Paragraph 1 start. " + ("Body sentence. " * 500) + "\n\n"
        p2 = "Paragraph 2 start. " + ("Second body sentence. " * 500)
        text = p1 + p2

        chunks, _ = split_text_into_chunks(text, chunk_size=12000, chunk_overlap=500)
        self.assertGreaterEqual(len(chunks), 2)
        # Chunk 1 should end cleanly at or before paragraph 1 end
        self.assertTrue(chunks[0].startswith("Paragraph 1 start."))

    def test_find_page_range(self):
        self.assertIsNone(find_page_range("No page markers in this text"))
        self.assertEqual(find_page_range("--- Page 3 ---\nContent here"), "p. 3")
        self.assertEqual(
            find_page_range("--- Page 2 ---\nText\n--- Page 3 ---\nMore text\n--- Page 7 ---"),
            "pp. 2–7",
        )
        self.assertEqual(find_page_range("[Page 12] Single slide"), "p. 12")
        self.assertEqual(find_page_range("[Page 4] start ... [Page 9] end"), "pp. 4–9")


from text_chunker import (
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    MAX_CHUNKS,
    split_text_into_chunks,
    find_page_range,
    build_chunked_cards,
)


class TestCardGenerationIntegration(unittest.TestCase):
    def test_single_chunk_generation_with_provenance(self):
        def fake_llm(chunk):
            return [
                {"front": "What is force?", "back": "Mass times acceleration", "type": "basic"},
                {"front": "F = {{c1::ma}}", "back": "Formula", "type": "cloze"},
            ], "Physics summary"

        text = "This is a brief text under 14k chars."
        cards, summary, warning = build_chunked_cards(text, fake_llm)

        self.assertEqual(len(cards), 2)
        self.assertEqual(summary, "Physics summary")
        self.assertIsNone(warning)

        # Check sourceInfo
        for c in cards:
            self.assertIn("sourceInfo", c)
            self.assertEqual(c["sourceInfo"]["chunkIndex"], 1)
            self.assertEqual(c["sourceInfo"]["totalChunks"], 1)
            self.assertIsNone(c["sourceInfo"]["pageRange"])

    def test_multi_chunk_generation_with_pages_and_card_cap(self):
        call_count = 0

        def fake_llm(chunk_text):
            nonlocal call_count
            call_count += 1
            # Return 8 cards per chunk
            cards = [
                {"front": f"Chunk {call_count} Q{j}", "back": f"Ans {j}", "type": "basic"}
                for j in range(1, 9)
            ]
            return cards, f"Summary {call_count}"

        # Synthesize 3-chunk text with page markers
        pages = []
        for p in range(1, 15):
            page_content = f"--- Page {p} ---\n" + ("Important lesson content. " * 75)
            pages.append(page_content)
        full_text = "\n\n".join(pages)

        cards, summary, warning = build_chunked_cards(full_text, fake_llm)

        self.assertEqual(call_count, 3)
        self.assertEqual(len(cards), 24)  # 3 chunks * 8 cards
        self.assertLessEqual(len(cards), 40)
        self.assertIsNone(warning)
        self.assertIn("Summary 1 Summary 2 Summary 3", summary)

        # Verify page ranges and chunk indexes
        c1 = cards[0]
        self.assertEqual(c1["sourceInfo"]["chunkIndex"], 1)
        self.assertEqual(c1["sourceInfo"]["totalChunks"], 3)
        self.assertIsNotNone(c1["sourceInfo"]["pageRange"])

        last_card = cards[-1]
        self.assertEqual(last_card["sourceInfo"]["chunkIndex"], 3)
        self.assertEqual(last_card["sourceInfo"]["totalChunks"], 3)
        self.assertIsNotNone(last_card["sourceInfo"]["pageRange"])

    def test_truncation_warning_when_exceeding_max_chunks(self):
        call_count = 0

        def fake_llm(chunk_text):
            nonlocal call_count
            call_count += 1
            return [{"front": "Q", "back": "A", "type": "basic"}], f"Summary {call_count}"

        # Create massive text (> 5 chunks, ~100k chars)
        paragraphs = []
        for i in range(1, 150):
            paragraphs.append(f"Chapter {i}: " + ("Deep subject matter details. " * 30))
        massive_text = "\n\n".join(paragraphs)

        cards, summary, warning = build_chunked_cards(massive_text, fake_llm)

        # Capped at exactly 5 chunks
        self.assertEqual(call_count, 5)
        self.assertIsNotNone(warning)
        self.assertIn("substantial reading", warning.lower())
        self.assertIn("first 5 sections", warning.lower())

    def test_hard_cap_at_40_cards(self):
        def fake_llm(chunk_text):
            # Returns 25 cards per chunk
            return [{"front": f"Q{j}", "back": f"A{j}"} for j in range(25)], "Summary"

        paragraphs = [f"Para {i}: " + ("Text " * 200) for i in range(25)]
        text = "\n\n".join(paragraphs)

        cards, summary, warning = build_chunked_cards(text, fake_llm, max_cards=40)
        self.assertEqual(len(cards), 40)


if __name__ == "__main__":
    unittest.main()
