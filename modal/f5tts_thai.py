# Clawcontent — F5-TTS Thai (Modal)
# Thai voice cloning using F5-TTS-THAI model.
# Deploy: modal deploy modal/f5tts_thai.py
# Test:   modal run modal/f5tts_thai.py --text "สวัสดีครับ" --output-path test.wav
# Clone:  modal run modal/f5tts_thai.py --text "สวัสดี" --reference-audio voice.wav --output-path test.wav

import modal, os, json

app = modal.App("clawcontent-f5tts-thai")
volume = modal.Volume.from_name("f5tts-models", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "git")
    .pip_install("f5-tts", "torch", "torchaudio", "transformers", "cached_path")
)


@app.function(image=image, gpu="T4", timeout=600, volumes={"/models": volume})
def generate_speech(text: str, reference_audio_path: str = "") -> bytes:
    """Generate Thai speech from text, optionally cloning a reference voice."""
    try:
        from f5_tts.api import F5TTS
        from io import BytesIO
        import soundfile as sf

        if not text or not text.strip():
            raise ValueError("Text input is empty. Provide a non-empty string.")

        tts = F5TTS(
            model_type="F5-TTS",
            ckpt_file="VIZINTZOR/F5-TTS-THAI",
            device="cuda",
        )

        if reference_audio_path:
            if not os.path.exists(reference_audio_path):
                raise FileNotFoundError(
                    f"Reference audio not found: {reference_audio_path}"
                )
            wav, sr, _ = tts.infer(
                ref_file=reference_audio_path, ref_text="", gen_text=text
            )
        else:
            wav, sr, _ = tts.infer(gen_text=text)

        buf = BytesIO()
        sf.write(buf, wav, sr, format="WAV")
        return buf.getvalue()

    except FileNotFoundError as e:
        raise RuntimeError(f"[F5-TTS Thai] File error: {e}")
    except ValueError as e:
        raise RuntimeError(f"[F5-TTS Thai] Validation error: {e}")
    except Exception as e:
        raise RuntimeError(f"[F5-TTS Thai] Generation failed: {e}")


@app.local_entrypoint()
def main(
    text: str = "สวัสดีครับ",
    reference_audio: str = "",
    output_path: str = "output.wav",
):
    try:
        audio_bytes = generate_speech.remote(text, reference_audio)
        with open(output_path, "wb") as f:
            f.write(audio_bytes)
        print(json.dumps({"status": "completed", "output_path": output_path}))
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}))
        raise SystemExit(1)
