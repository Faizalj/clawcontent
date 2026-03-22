# Clawcontent — LTX-2.3 Lipsync (Modal)
# Generates lipsync video from avatar image + audio.
# Deploy: modal deploy modal/lipsync.py
# Test:   modal run modal/lipsync.py --audio-path voice.mp3 --image-path avatar.jpg --output-path lipsync.mp4

import modal
import os
import time
import json
import urllib.request
import urllib.error

app = modal.App("clawcontent-lipsync")
volume = modal.Volume.from_name("ltx23-comfyui", create_if_missing=True)
hf_secret = modal.Secret.from_dotenv(path=os.path.expanduser("~/.env"))

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg")
    .run_commands(
        "git clone https://github.com/Comfy-Org/ComfyUI.git /comfyui",
        "cd /comfyui && pip install -r requirements.txt",
        "cd /comfyui/custom_nodes && git clone https://github.com/city96/ComfyUI-GGUF.git",
        "cd /comfyui/custom_nodes/ComfyUI-GGUF && pip install -r requirements.txt",
        "cd /comfyui/custom_nodes && git clone https://github.com/kijai/ComfyUI-KJNodes.git",
        "cd /comfyui/custom_nodes/ComfyUI-KJNodes && pip install -r requirements.txt",
        "cd /comfyui/custom_nodes && git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git",
        "cd /comfyui/custom_nodes/ComfyUI-VideoHelperSuite && pip install -r requirements.txt",
        "pip install huggingface_hub[hf_xet]",
    )
)


def build_workflow(num_frames: int = 497, width: int = 768, height: int = 512, seed: int = 42) -> dict:
    """Build the ComfyUI workflow for LTX-2.3 lipsync generation."""
    prompt = (
        "Close up portrait of the person talking, face only, no hands visible, "
        "no arms, no body, minimal facial expression, neutral calm face, "
        "only lips move gently, still head, still eyes, steady locked camera"
    )
    negative = (
        "hands, fingers, arms, body, exaggerated expression, eyebrow raise, "
        "wide eyes, surprised, head movement, head turning, camera movement"
    )

    return {
        "175": {"class_type": "VAELoaderKJ", "inputs": {"vae_name": "ltx-2.3-22b-distilled_audio_vae.safetensors", "device": "main_device", "weight_dtype": "bf16"}},
        "181": {"class_type": "VAELoaderKJ", "inputs": {"vae_name": "ltx-2.3-22b-distilled_video_vae.safetensors", "device": "main_device", "weight_dtype": "bf16"}},
        "191": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "ltx-2.3-22b-distilled-BF16.gguf"}},
        "189": {"class_type": "DualCLIPLoaderGGUF", "inputs": {"clip_name1": "gemma-3-12b-it-qat-UD-Q4_K_XL.gguf", "clip_name2": "ltx-2.3-22b-distilled_embeddings_connectors.safetensors", "type": "ltxv"}},
        "186": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["191", 0], "lora_name": "ltx-2.3-22b-distilled-lora-384.safetensors", "strength_model": 0.6}},
        "45": {"class_type": "LoadImage", "inputs": {"image": "input_image.png"}},
        "232": {"class_type": "LoadAudio", "inputs": {"audio": "input_audio.mp3"}},
        "228": {"class_type": "LTXVAudioVAEEncode", "inputs": {"audio": ["232", 0], "audio_vae": ["175", 0]}},
        "219": {"class_type": "SolidMask", "inputs": {"value": 0.0, "width": 8, "height": 8}},
        "226": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["228", 0], "mask": ["219", 0]}},
        "16": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["189", 0]}},
        "11": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["189", 0]}},
        "32": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": width, "height": height, "length": num_frames, "batch_size": 1}},
        "210": {"class_type": "LTXVImgToVideoInplace", "inputs": {"vae": ["181", 0], "image": ["45", 0], "latent": ["32", 0], "strength": 1.0, "bypass": False}},
        "24": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["210", 0], "audio_latent": ["226", 0]}},
        "10": {"class_type": "LTXVConditioning", "inputs": {"positive": ["16", 0], "negative": ["11", 0], "frame_rate": 25.0}},
        "36": {"class_type": "CFGGuider", "inputs": {"model": ["186", 0], "positive": ["10", 0], "negative": ["10", 1], "cfg": 1.0}},
        "215": {"class_type": "ManualSigmas", "inputs": {"sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"}},
        "1": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral_cfg_pp"}},
        "15": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "13": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["15", 0], "guider": ["36", 0], "sampler": ["1", 0], "sigmas": ["215", 0], "latent_image": ["24", 0]}},
        "146": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["13", 0]}},
        "149": {"class_type": "VAEDecodeTiled", "inputs": {"samples": ["146", 0], "vae": ["181", 0], "tile_size": 512, "overlap": 64, "temporal_size": 4096, "temporal_overlap": 8}},
        "150": {"class_type": "LTXVAudioVAEDecode", "inputs": {"samples": ["146", 1], "audio_vae": ["175", 0]}},
        "43": {"class_type": "VHS_VideoCombine", "inputs": {"images": ["149", 0], "audio": ["150", 0], "frame_rate": 25, "loop_count": 0, "filename_prefix": "lipsync", "format": "video/h264-mp4", "pingpong": False, "save_output": True}},
    }


def _ensure_models():
    """Download BF16 model if not cached on volume."""
    bf16_path = "/models/unet/ltx-2.3-22b-distilled-BF16.gguf"
    if not os.path.exists(bf16_path):
        print("Downloading BF16 model...")
        os.makedirs("/models/unet", exist_ok=True)
        from huggingface_hub import hf_hub_download
        import shutil
        path = hf_hub_download(
            "unsloth/LTX-2.3-GGUF",
            "distilled/ltx-2.3-22b-distilled-BF16.gguf",
            local_dir="/tmp/hf",
        )
        shutil.move(path, bf16_path)
        volume.commit()


def _symlink_models():
    """Symlink volume models into ComfyUI directories."""
    mapping = {
        "unet": ["/comfyui/models/diffusion_models", "/comfyui/models/unet"],
        "vae": ["/comfyui/models/vae"],
        "text_encoders": ["/comfyui/models/text_encoders", "/comfyui/models/clip"],
        "loras": ["/comfyui/models/loras"],
    }
    for src_sub, dst_dirs in mapping.items():
        src_dir = f"/models/{src_sub}"
        if not os.path.exists(src_dir):
            continue
        for dst in dst_dirs:
            os.makedirs(dst, exist_ok=True)
            for f in os.listdir(src_dir):
                s, d = os.path.join(src_dir, f), os.path.join(dst, f)
                if not os.path.exists(d):
                    os.symlink(s, d)


def _start_comfyui() -> "subprocess.Popen":
    """Start ComfyUI server and wait until ready."""
    import subprocess as sp
    proc = sp.Popen(
        ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-auto-launch"],
        cwd="/comfyui", stdout=sp.PIPE, stderr=sp.STDOUT,
    )
    for _ in range(60):
        time.sleep(2)
        try:
            urllib.request.urlopen("http://localhost:8188/system_stats", timeout=2)
            print("ComfyUI ready")
            return proc
        except Exception:
            pass
    raise RuntimeError("ComfyUI failed to start within 120s")


def _submit_and_wait(workflow: dict, proc) -> bytes:
    """Submit workflow to ComfyUI and poll for result. Returns video bytes."""
    data = json.dumps({"prompt": workflow}).encode()
    req = urllib.request.Request(
        "http://localhost:8188/prompt", data=data,
        headers={"Content-Type": "application/json"},
    )

    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:500]}")
        proc.kill()
        return b""

    prompt_id = result.get("prompt_id", "")
    print(f"Submitted prompt: {prompt_id}")

    for _ in range(180):
        time.sleep(5)
        try:
            resp = urllib.request.urlopen(f"http://localhost:8188/history/{prompt_id}")
            history = json.loads(resp.read())
            if prompt_id not in history:
                continue

            status = history[prompt_id].get("status", {})
            if status.get("completed"):
                for _nid, out in history[prompt_id].get("outputs", {}).items():
                    for key in ["videos", "gifs", "images"]:
                        if key in out:
                            for fi in out[key]:
                                fp = os.path.join("/comfyui/output", fi.get("subfolder", ""), fi["filename"])
                                if os.path.exists(fp):
                                    print(f"Output: {fp} ({os.path.getsize(fp) / 1024 / 1024:.1f}MB)")
                                    with open(fp, "rb") as f:
                                        proc.kill()
                                        return f.read()

            elif status.get("status_str") == "error":
                for m in status.get("messages", []):
                    if isinstance(m, list) and len(m) > 1 and isinstance(m[1], dict):
                        print(f"Error node {m[1].get('node_id', '?')}: {m[1].get('exception_message', '')[:200]}")
                proc.kill()
                return b""
        except Exception:
            pass

    proc.kill()
    return b""


@app.function(image=image, gpu="A100-40GB", timeout=3600, volumes={"/models": volume}, secrets=[hf_secret])
def generate_lipsync(audio_bytes: bytes, image_bytes: bytes, seed: int = 42) -> bytes:
    """Generate lipsync video from image bytes + audio bytes. Returns MP4 bytes."""
    import subprocess as sp

    _ensure_models()
    _symlink_models()

    # Write input files
    os.makedirs("/comfyui/input", exist_ok=True)
    with open("/comfyui/input/input_image.png", "wb") as f:
        f.write(image_bytes)
    with open("/comfyui/input/input_audio.mp3", "wb") as f:
        f.write(audio_bytes)

    # Calculate frames from audio duration (must be 8k+1 at 25fps)
    dur = float(sp.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0",
         "/comfyui/input/input_audio.mp3"],
        capture_output=True, text=True,
    ).stdout.strip())
    raw_frames = int(dur * 25)
    k = round((raw_frames - 1) / 8)
    num_frames = k * 8 + 1
    print(f"Audio: {dur:.1f}s -> {num_frames} frames")

    proc = _start_comfyui()
    workflow = build_workflow(num_frames=num_frames, seed=seed)
    return _submit_and_wait(workflow, proc)


@app.local_entrypoint()
def main(
    audio_path: str = "voice.mp3",
    image_path: str = "avatar.jpg",
    output_path: str = "lipsync.mp4",
):
    """Split audio into ~20s chunks, render each via Modal, concat locally."""
    import subprocess as sp

    with open(image_path, "rb") as f:
        image_bytes = f.read()

    # Get audio duration
    dur = float(sp.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", audio_path],
        capture_output=True, text=True,
    ).stdout.strip())

    print(f"Audio: {dur:.1f}s | Image: {len(image_bytes) / 1024:.0f}KB")

    CHUNK_SIZE = 20
    chunk_videos = []
    start = 0
    ci = 0

    while start < dur:
        length = min(CHUNK_SIZE, dur - start)
        chunk_audio = f"/tmp/lipsync_chunk_{ci}.mp3"

        # Split audio chunk locally
        sp.run([
            "ffmpeg", "-y", "-i", audio_path,
            "-ss", str(start), "-t", str(length),
            "-ar", "44100", "-ac", "2", chunk_audio,
        ], capture_output=True)

        with open(chunk_audio, "rb") as f:
            audio_bytes = f.read()

        print(f"  Chunk {ci} ({start:.0f}s-{start+length:.0f}s, {length:.0f}s)...")

        # Send to Modal — reuses same warm container
        video_bytes = generate_lipsync.remote(audio_bytes, image_bytes, seed=42 + ci)

        if video_bytes:
            chunk_video = f"/tmp/lipsync_chunk_{ci}.mp4"
            with open(chunk_video, "wb") as f:
                f.write(video_bytes)
            chunk_videos.append(chunk_video)
            print(f"  ✅ Chunk {ci} done")
        else:
            print(f"  ❌ Chunk {ci} failed")

        start += CHUNK_SIZE
        ci += 1

    if not chunk_videos:
        print(json.dumps({"status": "failed", "output_path": output_path}))
        return

    # Concat all chunks locally
    if len(chunk_videos) == 1:
        sp.run(["cp", chunk_videos[0], output_path])
    else:
        concat_file = "/tmp/lipsync_concat.txt"
        with open(concat_file, "w") as f:
            for cv in chunk_videos:
                f.write(f"file '{cv}'\n")
        sp.run([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", concat_file, "-c", "copy", output_path,
        ], capture_output=True)

    print(f"✅ {len(chunk_videos)} chunks → {output_path}")
    print(json.dumps({"status": "completed", "output_path": output_path}))
