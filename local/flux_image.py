#!/usr/bin/env python3
"""
ClawContent — Z-Image-Turbo (Local GPU)
Runs directly on local NVIDIA GPU — no Modal needed.

Single:  python3 local/flux_image.py --prompt "A robot" --output-path test.jpeg
Batch:   python3 local/flux_image.py --prompts-json '[{"prompt":"A","path":"a.jpg"}]'

Requires: pip install diffusers transformers torch accelerate pillow
GPU: 16GB+ VRAM (FP16) or 8GB+ (with cpu offload)
"""

import argparse
import json
import os
import sys

_pipe = None

def get_pipe():
    global _pipe
    if _pipe is None:
        import torch
        from diffusers import ZImagePipeline

        print("Loading Z-Image-Turbo...", file=sys.stderr)
        _pipe = ZImagePipeline.from_pretrained(
            "Tongyi-MAI/Z-Image-Turbo",
            torch_dtype=torch.bfloat16,
        )

        # Check VRAM — use CPU offload if < 20GB
        if torch.cuda.is_available():
            vram = torch.cuda.get_device_properties(0).total_mem / 1024**3
            if vram < 20:
                print(f"  GPU VRAM: {vram:.0f}GB — using CPU offload", file=sys.stderr)
                _pipe.enable_model_cpu_offload()
            else:
                print(f"  GPU VRAM: {vram:.0f}GB — full GPU mode", file=sys.stderr)
                _pipe.to("cuda")
        else:
            print("  No CUDA GPU — running on CPU (slow!)", file=sys.stderr)

    return _pipe


def generate_image(prompt, output_path, width=1280, height=720):
    from io import BytesIO

    pipe = get_pipe()
    fmt = "png" if output_path.lower().endswith(".png") else "jpeg"

    result = pipe(
        prompt=prompt,
        num_inference_steps=9,
        guidance_scale=0.0,
        width=width,
        height=height,
    )

    save_format = "JPEG" if fmt == "jpeg" else "PNG"
    save_kwargs = {"quality": 90} if fmt == "jpeg" else {}
    result.images[0].save(output_path, format=save_format, **save_kwargs)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", default="")
    parser.add_argument("--output-path", default="output.jpeg")
    parser.add_argument("--prompts-json", default="")
    args = parser.parse_args()

    if args.prompts_json:
        items = json.loads(args.prompts_json)
        print(f"Batch: {len(items)} images", file=sys.stderr)
        results = []
        for i, item in enumerate(items):
            path = item.get("path", f"output_{i}.jpeg")
            print(f"  [{i+1}/{len(items)}] Generating...", file=sys.stderr)
            try:
                generate_image(item["prompt"], path)
                results.append({"path": path, "status": "ok"})
                print(f"  ✅ {path}", file=sys.stderr)
            except Exception as e:
                results.append({"path": path, "status": "error", "error": str(e)})
                print(f"  ❌ {path}: {e}", file=sys.stderr)
        print(json.dumps({"status": "completed", "results": results}))

    elif args.prompt:
        try:
            generate_image(args.prompt, args.output_path)
            print(json.dumps({"status": "completed", "output_path": args.output_path}))
        except Exception as e:
            print(json.dumps({"status": "error", "error": str(e)}))
            sys.exit(1)
    else:
        print(json.dumps({"status": "error", "error": "No prompt provided"}))
