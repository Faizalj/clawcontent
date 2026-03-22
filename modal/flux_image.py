# Clawcontent — Flux Image Generation (Modal)
# Deploy: modal deploy modal/flux_image.py
# Test:   modal run modal/flux_image.py --prompt "A robot cooking" --output-path test.jpeg
#
# Uses black-forest-labs/FLUX.1-schnell (ungated, fast, free).
# Models are cached on a Modal volume to avoid re-downloading on each run.
# GPU: L40S (48GB VRAM, good balance of cost and performance).

import modal
import os
import json

app = modal.App("clawcontent-flux")
volume = modal.Volume.from_name("flux-models", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "diffusers",
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
    secrets=[modal.Secret.from_dotenv(path=os.path.expanduser("~/.env"))],
)
def generate_image(prompt: str, output_format: str = "jpeg") -> bytes:
    """Generate an image from a text prompt using FLUX.1-schnell.

    Args:
        prompt: Text description of the image to generate.
        output_format: "jpeg" or "png". Defaults to "jpeg".

    Returns:
        Raw image bytes in the requested format.
    """
    from diffusers import FluxPipeline
    import torch
    from io import BytesIO

    fmt = output_format.lower().strip()
    if fmt not in ("jpeg", "png"):
        raise ValueError(f"Unsupported output_format '{output_format}'. Use 'jpeg' or 'png'.")

    if not prompt or not prompt.strip():
        raise ValueError("Prompt must be a non-empty string.")

    try:
        pipe = FluxPipeline.from_pretrained(
            "black-forest-labs/FLUX.1-schnell",
            torch_dtype=torch.bfloat16,
            cache_dir="/models",
        )
        pipe.to("cuda")
    except Exception as exc:
        raise RuntimeError(f"Failed to load FLUX.1-schnell model: {exc}") from exc

    try:
        result = pipe(prompt, num_inference_steps=4, guidance_scale=0.0)
        generated_image = result.images[0]
    except Exception as exc:
        raise RuntimeError(f"Image generation failed: {exc}") from exc

    buf = BytesIO()
    save_format = "JPEG" if fmt == "jpeg" else "PNG"
    save_kwargs = {"quality": 90} if fmt == "jpeg" else {}
    generated_image.save(buf, format=save_format, **save_kwargs)

    # Persist a copy to the volume for later retrieval
    ext = "jpg" if fmt == "jpeg" else "png"
    import hashlib
    import time

    filename = f"{int(time.time())}_{hashlib.md5(prompt.encode()).hexdigest()[:8]}.{ext}"
    volume_path = f"/models/outputs/{filename}"
    os.makedirs("/models/outputs", exist_ok=True)
    with open(volume_path, "wb") as f:
        f.write(buf.getvalue())
    volume.commit()

    print(json.dumps({"url": volume_path, "status": "completed"}))

    return buf.getvalue()


@app.local_entrypoint()
def main(prompt: str = "A beautiful landscape", output_path: str = "output.jpeg"):
    """Local entrypoint — invokes the remote generate_image function and saves the result."""
    fmt = "png" if output_path.lower().endswith(".png") else "jpeg"

    try:
        img_bytes = generate_image.remote(prompt, output_format=fmt)
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        raise SystemExit(1)

    with open(output_path, "wb") as f:
        f.write(img_bytes)

    print(json.dumps({"status": "completed", "output_path": output_path}))
