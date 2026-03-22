# Clawcontent — Z-Image-Turbo Image Generation (Modal)
# Single image:  modal run modal/flux_image.py --prompt "A robot" --output-path test.jpeg
# Batch images:  modal run modal/flux_image.py --prompts-json '[{"prompt":"A","path":"a.jpg"},{"prompt":"B","path":"b.jpg"}]'
#
# Uses Z-Image-Turbo (Alibaba Tongyi-MAI)
# - Apache 2.0, ungated, no HuggingFace license needed
# - 9 steps, fast inference, boot once → gen all images
# GPU: L40S (48GB)

import modal
import os
import json

app = modal.App("clawcontent-zimage")
volume = modal.Volume.from_name("zimage-models", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .pip_install(
        "git+https://github.com/huggingface/diffusers",
        "transformers",
        "torch",
        "accelerate",
        "sentencepiece",
        "protobuf",
        "pillow",
    )
)


@app.function(
    image=image,
    gpu="L40S",
    timeout=600,
    volumes={"/models": volume},
)
def generate_image(prompt: str, output_format: str = "jpeg") -> bytes:
    """Generate a single image using Z-Image-Turbo."""
    import torch
    from diffusers import ZImagePipeline
    from io import BytesIO

    fmt = output_format.lower().strip()
    if not prompt or not prompt.strip():
        raise ValueError("Prompt must be non-empty.")

    pipe = ZImagePipeline.from_pretrained(
        "Tongyi-MAI/Z-Image-Turbo",
        torch_dtype=torch.bfloat16,
        cache_dir="/models",
    )
    pipe.to("cuda")

    result = pipe(
        prompt=prompt,
        num_inference_steps=9,
        guidance_scale=0.0,
        width=1280,
        height=720,
    )

    buf = BytesIO()
    save_format = "JPEG" if fmt == "jpeg" else "PNG"
    save_kwargs = {"quality": 90} if fmt == "jpeg" else {}
    result.images[0].save(buf, format=save_format, **save_kwargs)
    return buf.getvalue()


@app.local_entrypoint()
def main(
    prompt: str = "",
    output_path: str = "output.jpeg",
    prompts_json: str = "",
):
    """Generate images. Batch mode: boot once, gen all, save all."""

    # Batch mode: multiple prompts in one session
    if prompts_json:
        items = json.loads(prompts_json)
        print(f"Batch: {len(items)} images")

        results = []
        for i, item in enumerate(items):
            p = item.get("prompt", "")
            path = item.get("path", f"output_{i}.jpeg")
            fmt = "png" if path.lower().endswith(".png") else "jpeg"

            print(f"  [{i+1}/{len(items)}] Generating...")
            try:
                img_bytes = generate_image.remote(p, output_format=fmt)
                with open(path, "wb") as f:
                    f.write(img_bytes)
                results.append({"path": path, "status": "ok"})
                print(f"  ✅ {path}")
            except Exception as e:
                results.append({"path": path, "status": "error", "error": str(e)})
                print(f"  ❌ {path}: {e}")

        print(json.dumps({"status": "completed", "results": results}))
        return

    # Single mode
    if not prompt:
        print(json.dumps({"status": "error", "error": "No prompt provided"}))
        return

    fmt = "png" if output_path.lower().endswith(".png") else "jpeg"
    try:
        img_bytes = generate_image.remote(prompt, output_format=fmt)
        with open(output_path, "wb") as f:
            f.write(img_bytes)
        print(json.dumps({"status": "completed", "output_path": output_path}))
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}))
        raise SystemExit(1)
