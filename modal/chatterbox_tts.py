# Clawcontent — Chatterbox TTS (Modal)
# English voice cloning. 10s reference audio for voice clone.
# Deploy: modal deploy modal/chatterbox_tts.py
# Test:   modal run modal/chatterbox_tts.py --text "Hello world" --output-path test.mp3
# Clone:  modal run modal/chatterbox_tts.py --text "Hello" --reference-audio voice.mp3 --output-path test.mp3

import modal, os, json

app = modal.App("clawcontent-chatterbox")
volume = modal.Volume.from_name("chatterbox-models", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("chatterbox-tts", "torch", "torchaudio")
)


@app.function(image=image, gpu="T4", timeout=600, volumes={"/models": volume})
def generate_speech(text: str, reference_audio_path: str = "") -> bytes:
    """Generate speech from text, optionally cloning a reference voice."""
    try:
        from chatterbox.tts import ChatterboxTTS
        import torchaudio
        from io import BytesIO

        if not text or not text.strip():
            raise ValueError("Text input is empty. Provide a non-empty string.")

        model = ChatterboxTTS.from_pretrained(device="cuda", cache_dir="/models")

        if reference_audio_path:
            if not os.path.exists(reference_audio_path):
                raise FileNotFoundError(
                    f"Reference audio not found: {reference_audio_path}"
                )
            wav = model.generate(text, audio_prompt_path=reference_audio_path)
        else:
            wav = model.generate(text)

        buf = BytesIO()
        torchaudio.save(buf, wav, model.sr, format="mp3")
        return buf.getvalue()

    except FileNotFoundError as e:
        raise RuntimeError(f"[Chatterbox TTS] File error: {e}")
    except ValueError as e:
        raise RuntimeError(f"[Chatterbox TTS] Validation error: {e}")
    except Exception as e:
        raise RuntimeError(f"[Chatterbox TTS] Generation failed: {e}")


@app.local_entrypoint()
def main(
    text: str = "Hello world",
    reference_audio: str = "",
    output_path: str = "output.mp3",
):
    try:
        audio_bytes = generate_speech.remote(text, reference_audio)
        with open(output_path, "wb") as f:
            f.write(audio_bytes)
        print(json.dumps({"status": "completed", "output_path": output_path}))
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}))
        raise SystemExit(1)
