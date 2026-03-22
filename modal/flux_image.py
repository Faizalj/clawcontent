# Clawcontent — Z-Image-Turbo Image Generation (Modal)
# Deploy: modal run modal/flux_image.py --prompt "A robot cooking" --output-path test.jpeg
#
# Uses Z-Image-Turbo (Alibaba Tongyi-MAI)
# - Apache 2.0, ungated, no HuggingFace license needed
# - 8 NFEs (9 steps), fast inference
# - Requires ZImagePipeline from diffusers (installed from source)
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
    """Generate an image using Z-Image-Turbo."""
    import torch
    from diffusers import ZImagePipeline
    from io import BytesIO

    fmt = output_format.lower().strip()
    if fmt not in ("jpeg", "png"):
        raise ValueError(f"Unsupported format '{output_format}'. Use 'jpeg' or 'png'.")
    if not prompt or not prompt.strip():
        raise ValueError("Prompt must be non-empty.")

    try:
        pipe = ZImagePipeline.from_pretrained(
            "Tongyi-MAI/Z-Image-Turbo",
            torch_dtype=torch.bfloat16,
            cache_dir="/models",
        )
        pipe.to("cuda")
    except Exception as exc:
        raise RuntimeError(f"Failed to load Z-Image-Turbo: {exc}") from exc

    try:
        result = pipe(
            prompt=prompt,
            num_inference_steps=9,
            guidance_scale=0.0,
            width=1280,
            height=720,
        )
        generated_image = result.images[0]
    except Exception as exc:
        raise RuntimeError(f"Image generation failed: {exc}") from exc

    buf = BytesIO()
    save_format = "JPEG" if fmt == "jpeg" else "PNG"
    save_kwargs = {"quality": 90} if fmt == "jpeg" else {}
    generated_image.save(buf, format=save_format, **save_kwargs)

    return buf.getvalue()


@app.local_entrypoint()
def main(prompt: str = "A beautiful landscape", output_path: str = "output.jpeg"):
    fmt = "png" if output_path.lower().endswith(".png") else "jpeg"

    try:
        img_bytes = generate_image.remote(prompt, output_format=fmt)
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        raise SystemExit(1)

    with open(output_path, "wb") as f:
        f.write(img_bytes)

    print(json.dumps({"status": "completed", "output_path": output_path}))
