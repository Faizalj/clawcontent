#!/usr/bin/env python3
"""
Fix Caption Typos — Replace Whisper Thai text with correct script text

Takes Whisper JSON (has timing) + script .md (has correct text)
Outputs fixed JSON with correct text + original timing

Algorithm: Sequence alignment using difflib
- Concatenate all texts into single strings
- Use SequenceMatcher to find character-level alignment
- Map Whisper segment boundaries to script text positions
- Extract corresponding script text for each segment

Usage:
  python3 fix_caption_typos.py --whisper transcript.json --script script.md --output fixed.json
  python3 fix_caption_typos.py --whisper transcript.json --script script.md --output fixed.json --diff
"""

import json
import os
import re
import argparse
import copy
from difflib import SequenceMatcher


def extract_speech_lines(script_path):
    """Extract speech lines from script .md, stripping markdown formatting"""
    with open(script_path, encoding="utf-8") as f:
        content = f.read()

    lines = content.split("\n")
    speech = []
    in_notes = False

    for line in lines:
        stripped = line.strip()
        # Stop at Notes section
        if re.match(r"^##\s+Notes", stripped):
            in_notes = True
        if in_notes:
            continue
        # Skip empty, headers, separators
        if not stripped:
            continue
        if stripped.startswith("#"):
            continue
        if stripped == "---":
            continue
        # Remove surrounding quotes
        stripped = stripped.strip('"')
        if stripped:
            speech.append(stripped)

    return speech


def build_char_mapping(whisper_full, script_full):
    """
    Build a mapping from whisper character positions to script character positions
    using SequenceMatcher alignment blocks.
    """
    matcher = SequenceMatcher(None, whisper_full, script_full, autojunk=False)
    blocks = matcher.get_matching_blocks()

    # Build position mapping: whisper_pos → script_pos
    # For matched blocks, positions correspond directly
    # For gaps, interpolate linearly
    mapping = {}  # whisper_pos → script_pos

    for block in blocks:
        w_start, s_start, size = block
        for i in range(size):
            mapping[w_start + i] = s_start + i

    return mapping, blocks


def align_script_to_segments(speech_lines, segments):
    """
    Align script text to Whisper segments using sequence alignment.

    1. Concatenate texts (strip spaces for alignment, track positions)
    2. Use SequenceMatcher to find matching character blocks
    3. For each Whisper segment, find corresponding script text range
    """
    # Build concatenated texts with segment boundary tracking
    whisper_texts = [s["text"].strip() for s in segments]

    # Build whisper full text and track segment boundaries
    whisper_parts = []
    seg_boundaries = []  # (start_pos, end_pos) in whisper_full for each segment
    pos = 0
    for text in whisper_texts:
        clean = text.replace(" ", "")
        start = pos
        pos += len(clean)
        seg_boundaries.append((start, pos))
        whisper_parts.append(clean)
    whisper_full = "".join(whisper_parts)

    # Build script full text
    script_full = "".join(line.replace(" ", "") for line in speech_lines)

    # Also keep script with spaces for output, tracking char positions
    script_with_spaces = " ".join(speech_lines)
    # Map: nospace_pos → original text around that position
    script_nospace_to_pos = []
    nsi = 0
    for ci, ch in enumerate(script_with_spaces):
        if ch != " ":
            script_nospace_to_pos.append(ci)
            nsi += 1

    # Get matching blocks
    matcher = SequenceMatcher(None, whisper_full, script_full, autojunk=False)
    blocks = matcher.get_matching_blocks()

    # Build whisper_pos → script_pos mapping using matching blocks
    # For positions between blocks, interpolate
    w2s = [None] * len(whisper_full)
    for w_start, s_start, size in blocks:
        for i in range(size):
            w2s[w_start + i] = s_start + i

    # Interpolate gaps linearly between known anchor points
    # Collect anchor points (positions with known mappings)
    anchors = [(i, w2s[i]) for i in range(len(w2s)) if w2s[i] is not None]

    if anchors:
        # Fill before first anchor
        first_w, first_s = anchors[0]
        for i in range(first_w):
            w2s[i] = max(0, first_s - (first_w - i))

        # Fill between anchors
        for k in range(len(anchors) - 1):
            w1, s1 = anchors[k]
            w2, s2 = anchors[k + 1]
            gap = w2 - w1
            if gap > 1:
                for i in range(1, gap):
                    frac = i / gap
                    w2s[w1 + i] = int(s1 + frac * (s2 - s1))

        # Fill after last anchor
        last_w, last_s = anchors[-1]
        for i in range(last_w + 1, len(w2s)):
            w2s[i] = min(last_s + (i - last_w), len(script_full) - 1)

    # For each segment, find the script text range
    # First pass: get raw script nospace positions for each segment
    raw_positions = []
    for seg_idx, (w_start, w_end) in enumerate(seg_boundaries):
        if w_start >= len(w2s) or w_end <= 0:
            raw_positions.append((0, 0))
            continue
        s_start = w2s[w_start] if w_start < len(w2s) else len(script_full)
        s_end = w2s[min(w_end - 1, len(w2s) - 1)] + 1 if w_end > 0 else 0
        s_start = max(0, min(s_start, len(script_full)))
        s_end = max(s_start, min(s_end, len(script_full)))
        raw_positions.append((s_start, s_end))

    # Second pass: ensure no overlaps and no gaps between consecutive segments
    # Each segment starts exactly where the previous one ended
    adjusted = []
    prev_end = 0
    for seg_idx, (s_start, s_end) in enumerate(raw_positions):
        adj_start = prev_end
        if seg_idx == len(raw_positions) - 1:
            adj_end = len(script_full)
        else:
            adj_end = s_end
        adjusted.append((adj_start, adj_end))
        prev_end = adj_end

    # Extract text for each segment
    result_texts = []
    prev_orig_end = 0  # Track previous segment's end to prevent overlap
    for adj_start, adj_end in adjusted:
        if adj_start < len(script_nospace_to_pos) and adj_end > 0:
            orig_start = script_nospace_to_pos[adj_start]
            orig_end_idx = min(adj_end - 1, len(script_nospace_to_pos) - 1)
            orig_end = script_nospace_to_pos[orig_end_idx] + 1 if orig_end_idx >= 0 else 0

            # Don't go backward past previous segment's end
            orig_start = max(orig_start, prev_orig_end)

            # Snap end forward to nearest space (word boundary)
            while orig_end < len(script_with_spaces) and script_with_spaces[orig_end] != " ":
                orig_end += 1

            text = script_with_spaces[orig_start:orig_end].strip()
            prev_orig_end = orig_end
        else:
            text = ""
        result_texts.append(text)

    return result_texts


def similarity(a, b):
    """Calculate text similarity ratio"""
    return SequenceMatcher(None, a.replace(" ", ""), b.replace(" ", "")).ratio()


def fix_typos(whisper_path, script_path, output_path, show_diff=False):
    """Main function: fix Whisper text using script as source of truth"""

    # Load Whisper JSON
    with open(whisper_path, encoding="utf-8") as f:
        data = json.load(f)

    segments = data["segments"]
    speech_lines = extract_speech_lines(script_path)

    print(f"Whisper segments: {len(segments)}")
    print(f"Script speech lines: {len(speech_lines)}")

    # Align script text to segments
    fixed_texts = align_script_to_segments(speech_lines, segments)

    # Build output
    output = copy.deepcopy(data)

    # Replace top-level text
    output["text"] = " ".join(fixed_texts)

    changes = 0
    for i, (seg, new_text) in enumerate(zip(output["segments"], fixed_texts)):
        old_text = seg["text"].strip()
        new_text = new_text.strip()

        if old_text != new_text:
            changes += 1
            if show_diff:
                sim = similarity(old_text, new_text)
                marker = "!!" if sim < 0.5 else "~" if sim < 0.8 else " "
                print(f"  {marker} [{seg['start']:6.1f}s] WHISPER: {old_text[:70]}")
                print(f"  {marker}          SCRIPT:  {new_text[:70]}")
                print()

        seg["text"] = new_text

    # Write output
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nFixed {changes}/{len(segments)} segments")
    print(f"Output: {output_path}")

    return changes


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fix Whisper Thai typos using script as source of truth")
    parser.add_argument("--whisper", required=True, help="Whisper JSON transcript")
    parser.add_argument("--script", required=True, help="Script .md file (correct text)")
    parser.add_argument("--output", required=True, help="Output fixed JSON path")
    parser.add_argument("--diff", action="store_true", help="Show before/after diff")
    args = parser.parse_args()

    fix_typos(args.whisper, args.script, args.output, show_diff=args.diff)
