#!/usr/bin/env python3
"""
ClawContent — Chatterbox TTS (Local GPU)
English voice cloning. 10s reference audio for voice clone.

Test: python3 local/chatterbox_tts.py --text "Hello world" --output-path test.mp3
Clone: python3 local/chatterbox_tts.py --text "Hello" --reference-audio voice.mp3 --output-path test.mp3

Requires: pip install chatterbox-tts torch torchaudio
GPU: 8GB+ VRAM
"""

import argparse
import json
import sys

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--reference-audio", default="")
    parser.add_argument("--output-path", default="output.mp3")
    args = parser.parse_args()

    try:
        from chatterbox.tts import ChatterboxTTS
        import torchaudio
        from io import BytesIO

        print("Loading Chatterbox...", file=sys.stderr)
        model = ChatterboxTTS.from_pretrained(device="cuda")

        if args.reference_audio:
            wav = model.generate(args.text, audio_prompt_path=args.reference_audio)
        else:
            wav = model.generate(args.text)

        torchaudio.save(args.output_path, wav, model.sr)
        print(json.dumps({"status": "completed", "output_path": args.output_path}))

    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}))
        sys.exit(1)
