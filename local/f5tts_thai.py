#!/usr/bin/env python3
"""
ClawContent — F5-TTS Thai (Local GPU/CPU)
Thai voice cloning using F5-TTS-THAI model.

Test:  python3 local/f5tts_thai.py --text "สวัสดีครับ" --output-path test.wav
Clone: python3 local/f5tts_thai.py --text "สวัสดี" --reference-audio voice.wav --output-path test.wav

Requires: pip install f5-tts torch torchaudio transformers
GPU: 4GB+ VRAM (or CPU — slower)
"""

import argparse
import json
import sys

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--reference-audio", default="")
    parser.add_argument("--output-path", default="output.wav")
    args = parser.parse_args()

    try:
        from f5_tts.api import F5TTS
        import soundfile as sf

        print("Loading F5-TTS-THAI...", file=sys.stderr)
        tts = F5TTS(model_type="F5-TTS", ckpt_file="VIZINTZOR/F5-TTS-THAI")

        if args.reference_audio:
            wav, sr, _ = tts.infer(ref_file=args.reference_audio, ref_text="", gen_text=args.text)
        else:
            wav, sr, _ = tts.infer(gen_text=args.text)

        sf.write(args.output_path, wav, sr)
        print(json.dumps({"status": "completed", "output_path": args.output_path}))

    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}))
        sys.exit(1)
