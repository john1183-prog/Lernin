"""
text_chunker.py - Pure helper for splitting document text into safe chunks
and coordinating card generation with per-card provenance.
"""

import re
from typing import Callable, List, Optional, Tuple, Any

CHUNK_SIZE = 14000
CHUNK_OVERLAP = 800
MAX_CHUNKS = 5
MAX_CARDS_PER_UPLOAD = 40

PAGE_MARKER_PATTERN = re.compile(r'(?:---|\[)\s*Page\s+(\d+)\s*(?:---|\])', re.IGNORECASE)


def find_page_range(chunk_text: str) -> Optional[str]:
    """Extracts a human-readable page range from page markers in the chunk text, if any."""
    matches = PAGE_MARKER_PATTERN.findall(chunk_text)
    if not matches:
        return None
    page_nums = sorted({int(m) for m in matches})
    if not page_nums:
        return None
    if len(page_nums) == 1:
        return f"p. {page_nums[0]}"
    return f"pp. {page_nums[0]}–{page_nums[-1]}"


def split_text_into_chunks(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    chunk_overlap: int = CHUNK_OVERLAP,
    max_chunks: int = MAX_CHUNKS,
) -> Tuple[List[str], bool]:
    """Splits text into chunks targeting chunk_size characters with chunk_overlap.

    Prefers splitting on paragraph breaks, then newlines, then sentence boundaries.
    Returns (chunks, is_truncated) where is_truncated is True if the document required
    more chunks than max_chunks.
    """
    clean_text = text.strip()
    if not clean_text:
        return [], False

    if len(clean_text) <= chunk_size:
        return [clean_text], False

    all_chunks: List[str] = []
    start = 0
    text_len = len(clean_text)

    while start < text_len:
        # If remaining text fits in one chunk, take it all
        if text_len - start <= chunk_size:
            chunk = clean_text[start:].strip()
            if chunk:
                all_chunks.append(chunk)
            break

        # Find a split point near start + chunk_size
        target_end = min(start + chunk_size, text_len)
        # Search window for a clean break: last 2500 characters of the target window
        window_start = max(start + 1, target_end - 2500)
        window = clean_text[window_start:target_end]

        split_offset = -1

        # 1. Paragraph break (\n\n)
        p_idx = window.rfind('\n\n')
        if p_idx != -1:
            split_offset = p_idx + 2
        else:
            # 2. Line break (\n)
            n_idx = window.rfind('\n')
            if n_idx != -1:
                split_offset = n_idx + 1
            else:
                # 3. Sentence boundary (. , ? , ! )
                sent_match = None
                for m in re.finditer(r'[\.\?!]\s+', window):
                    sent_match = m
                if sent_match:
                    split_offset = sent_match.end()
                else:
                    # 4. Word boundary (space)
                    s_idx = window.rfind(' ')
                    if s_idx != -1:
                        split_offset = s_idx + 1

        if split_offset != -1:
            end = window_start + split_offset
        else:
            end = target_end

        chunk = clean_text[start:end].strip()
        if chunk:
            all_chunks.append(chunk)

        # Calculate next start with overlap
        overlap_target = max(start + 1, end - chunk_overlap)

        # Try to align next_start with a line or word boundary
        if overlap_target < end:
            align_window = clean_text[max(start + 1, overlap_target - 200):min(end, overlap_target + 200)]
            align_idx = align_window.find('\n')
            if align_idx != -1:
                next_start = max(start + 1, overlap_target - 200) + align_idx + 1
            else:
                next_start = overlap_target
        else:
            next_start = end

        # Ensure forward progress
        if next_start <= start:
            next_start = end

        start = next_start

    is_truncated = len(all_chunks) > max_chunks
    selected_chunks = all_chunks[:max_chunks]

    return selected_chunks, is_truncated


def build_chunked_cards(
    text: str,
    call_llm_fn: Callable[[str], Tuple[List[Any], Optional[str]]],
    max_cards: int = MAX_CARDS_PER_UPLOAD,
) -> Tuple[List[Any], str, Optional[str]]:
    """Chunks text, invokes call_llm_fn per chunk, tags cards with sourceInfo,
    and returns (all_cards, combined_summary, warning_note).
    """
    chunks, is_truncated = split_text_into_chunks(text)
    if not chunks:
        return [], "", None

    all_cards: List[Any] = []
    summaries: List[str] = []

    for i, chunk in enumerate(chunks):
        if len(all_cards) >= max_cards:
            break

        chunk_cards, chunk_summary = call_llm_fn(chunk)

        page_range = find_page_range(chunk)
        source_info = {
            "chunkIndex": i + 1,
            "totalChunks": len(chunks),
            "pageRange": page_range,
        }

        for card in chunk_cards:
            # Set sourceInfo as attribute on Pydantic models or key on dicts
            if hasattr(card, "__dict__") or hasattr(card, "sourceInfo"):
                setattr(card, "sourceInfo", source_info)
            elif isinstance(card, dict):
                card["sourceInfo"] = source_info

        all_cards.extend(chunk_cards)
        if chunk_summary and str(chunk_summary).strip():
            summaries.append(str(chunk_summary).strip())

        if len(all_cards) >= max_cards:
            all_cards = all_cards[:max_cards]
            break

    combined_summary = " ".join(summaries) if summaries else ""
    warning = None
    if is_truncated:
        warning = (
            f"This is a substantial reading! We created cards from the first {len(chunks)} sections "
            f"to keep your study session bite-sized. You can upload subsequent chapters later."
        )

    return all_cards, combined_summary, warning
