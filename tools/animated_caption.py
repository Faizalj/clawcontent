#!/usr/bin/env python3
"""
Animated Caption v3 — Playwright + segment-based (no word timing needed)
Shows full sentence caption synced to audio segments

Usage: python3 animated_caption.py --transcript script.json --video input.mp4 --output final.mp4
"""

import json
import os
import argparse
import numpy as np
from PIL import Image

DEFAULT_W, DEFAULT_H = 1920, 1080
FPS = 24

_browser = None
_page = None


def get_page():
    global _browser, _page
    if _page is None:
        from playwright.sync_api import sync_playwright
        _pw = sync_playwright().start()
        _browser = _pw.chromium.launch()
        _page = _browser.new_page(viewport={"width": W, "height": 100})
    return _page


def render_text_png(text):
    """Render Thai text as transparent PNG via Playwright"""
    escaped = text.replace("<", "&lt;").replace(">", "&gt;")

    html = f"""<html><body style="margin:0;padding:0;background:transparent;width:{W}px;height:100px;display:flex;align-items:center;justify-content:center;">
<div style="
  background:rgba(7,10,13,0.80);
  padding:10px 30px;
  border-radius:8px;
  font-family:'Sarabun','Noto Sans Thai',sans-serif;
  font-size:38px;
  font-weight:700;
  color:white;
  text-align:center;
  max-width:1800px;
  line-height:1.4;
">{escaped}</div>
</body></html>"""

    page = get_page()
    page.set_content(html)
    png_bytes = page.screenshot(omit_background=True)
    img = Image.open(__import__('io').BytesIO(png_bytes)).convert("RGBA")
    return np.array(img)


def burn_captions(video_path, transcript_path, output_path):
    """Burn segment-based captions onto video"""
    from moviepy import VideoFileClip, VideoClip, CompositeVideoClip

    with open(transcript_path) as f:
        data = json.load(f)

    segments = data["segments"]
    print(f"🎬 Burning {len(segments)} caption segments...")

    video = VideoFileClip(video_path)

    # Auto-detect resolution from input video
    global W, H, _browser, _page
    W, H = video.w, video.h
    is_vertical = H > W
    print(f"   Video: {W}x{H} ({'vertical' if is_vertical else 'landscape'})")

    # Re-init page with correct width
    if _browser:
        _browser.close()
        _browser = None
        _page = None

    # Pre-render all segment PNGs
    print("   Rendering captions...")
    seg_frames = {}
    for i, seg in enumerate(segments):
        seg_frames[i] = render_text_png(seg["text"])
        if i % 10 == 0:
            print(f"   {i}/{len(segments)}")

    empty_frame = np.zeros((100, W, 4), dtype=np.uint8)
    # Caption position: 75% for vertical (per memory), bottom area for landscape
    caption_y = int(H * 0.75) if is_vertical else (H - 100 - 40)

    def make_frame(t):
        # Find active segment
        active = None
        for i, seg in enumerate(segments):
            if seg["start"] <= t <= seg["end"]:
                active = i
                break

        caption = seg_frames.get(active, empty_frame) if active is not None else empty_frame

        full = np.zeros((H, W, 4), dtype=np.uint8)
        ch = min(caption.shape[0], 100)
        cw = min(caption.shape[1], W)
        x_offset = (W - cw) // 2  # center horizontally
        full[caption_y:caption_y + ch, x_offset:x_offset + cw] = caption[:ch, :cw]
        return full

    caption_clip = VideoClip(make_frame, duration=video.duration).with_fps(FPS)
    final = CompositeVideoClip([video, caption_clip], size=(W, H))

    print("   Encoding...")
    final.write_videofile(
        output_path,
        fps=FPS,
        codec="libx264",
        audio_codec="aac",
        bitrate="5000k",
        threads=8,
        logger="bar"
    )

    # Cleanup
    if _browser:
        _browser.close()
        _browser = None
        _page = None

    print(f"✅ Done: {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    burn_captions(args.video, args.transcript, args.output)
