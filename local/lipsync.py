#!/usr/bin/env python3
"""
ClawContent — LTX-2.3 Lipsync (Local GPU)
Split audio ~20s, render each chunk, concat.

Test: python3 local/lipsync.py --audio-path voice.mp3 --image-path avatar.jpg --output-path lipsync.mp4

Requires: ComfyUI installed locally with LTX-2.3 nodes
GPU: 24GB+ VRAM (GGUF Q4) or 40GB+ (BF16)

NOTE: This requires a running ComfyUI instance at localhost:8188
      or the full ComfyUI + LTX-2.3 setup.
      For now, uses the same chunking approach as Modal but runs locally.
"""

import argparse
import json
import os
import subprocess as sp
import sys

CHUNK_SIZE = 20


def get_duration(path):
    result = sp.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def generate_chunk_comfyui(audio_path, image_path, output_path):
    """Generate lipsync for one chunk via ComfyUI API at localhost:8188"""
    # TODO: implement ComfyUI API call
    # For now: placeholder that copies a test video
    print(f"  ⚠️  ComfyUI local lipsync not fully implemented yet", file=sys.stderr)
    print(f"  → Need ComfyUI running at localhost:8188 with LTX-2.3 nodes", file=sys.stderr)
    return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-path", required=True)
    parser.add_argument("--image-path", required=True)
    parser.add_argument("--output-path", default="lipsync.mp4")
    args = parser.parse_args()

    dur = get_duration(args.audio_path)
    out_dir = os.path.dirname(os.path.abspath(args.output_path))
    chunks_dir = os.path.join(out_dir, "lipsync_chunks")
    os.makedirs(chunks_dir, exist_ok=True)

    total_chunks = int(dur / CHUNK_SIZE) + (1 if dur % CHUNK_SIZE > 0 else 0)
    print(f"Audio: {dur:.1f}s | {total_chunks} chunks", file=sys.stderr)

    chunk_videos = []
    start = 0
    ci = 0

    while start < dur:
        length = min(CHUNK_SIZE, dur - start)
        chunk_video = os.path.join(chunks_dir, f"chunk_{ci:02d}.mp4")

        # Skip if already done (resume support)
        if os.path.exists(chunk_video) and os.path.getsize(chunk_video) > 50000:
            print(f"  ⏭️  Chunk {ci} already done", file=sys.stderr)
            chunk_videos.append(chunk_video)
            start += CHUNK_SIZE
            ci += 1
            continue

        chunk_audio = os.path.join(chunks_dir, f"chunk_{ci:02d}.mp3")
        sp.run(["ffmpeg", "-y", "-i", args.audio_path, "-ss", str(start), "-t", str(length),
                "-ar", "44100", "-ac", "2", chunk_audio], capture_output=True)

        print(f"  🎬 Chunk {ci}/{total_chunks-1} ({start:.0f}s-{start+length:.0f}s)", file=sys.stderr)

        ok = generate_chunk_comfyui(chunk_audio, args.image_path, chunk_video)
        if ok and os.path.exists(chunk_video):
            chunk_videos.append(chunk_video)
            print(f"  ✅ Chunk {ci}", file=sys.stderr)
        else:
            print(f"  ❌ Chunk {ci} — ComfyUI lipsync not available locally", file=sys.stderr)
            print(json.dumps({"status": "failed", "error": "Local lipsync requires ComfyUI + LTX-2.3. Use Cloud (Modal) instead."}))
            sys.exit(1)

        start += CHUNK_SIZE
        ci += 1

    # Concat
    if len(chunk_videos) == 1:
        sp.run(["cp", chunk_videos[0], args.output_path])
    else:
        concat_file = os.path.join(chunks_dir, "concat.txt")
        with open(concat_file, "w") as f:
            for cv in chunk_videos:
                f.write(f"file '{cv}'\n")
        sp.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_file, "-c", "copy", args.output_path],
               capture_output=True)

    print(json.dumps({"status": "completed", "output_path": args.output_path}))
