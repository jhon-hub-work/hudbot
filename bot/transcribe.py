"""Hudbot speech to text, on this PC. No API is used.

Reads <run>/audio.pcm (16 kHz mono 16-bit, written by `join`) and writes <run>/transcript.json and
<run>/transcript.txt. Usage: python transcribe.py <run folder> [auto|tl|en]
"""
import json
import re
import sys
from pathlib import Path

import os
import site

import numpy as np

# torch's CUDA build ships cublas64_12.dll. ctranslate2 needs it on the DLL search path on Windows.
for site_dir in site.getsitepackages():
    torch_lib = Path(site_dir) / "torch" / "lib"
    if torch_lib.is_dir():
        os.environ["PATH"] = str(torch_lib) + os.pathsep + os.environ["PATH"]  # ctranslate2 looks DLLs up on PATH
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(torch_lib))

from faster_whisper import WhisperModel  # noqa: E402  (imported after the DLL path is set)

MODEL = "large-v3-turbo"
# Whisper invents these words on silence and noise. Same list as the Huddle room worker.
JUNK = re.compile(r"^[\s.!,]*(thank you\.?|thanks for watching[.!]?|you|bye\.?|\.+)?[\s.!,]*$", re.I)


def clock(sec):
    return f"{int(sec // 60):02d}:{int(sec % 60):02d}"


def run_model(audio, lang, device, compute_type):
    model = WhisperModel(MODEL, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        audio, language=lang, vad_filter=True, beam_size=5, condition_on_previous_text=False
    )
    return list(segments), info  # list() runs the decoding now, so GPU errors are raised here


def main():
    run = Path(sys.argv[1])
    lang = None if len(sys.argv) < 3 or sys.argv[2] == "auto" else sys.argv[2]
    audio = np.fromfile(run / "audio.pcm", dtype=np.int16).astype(np.float32) / 32768.0

    lines = []
    if audio.size >= 16000:  # at least one second of sound
        try:
            segments, info = run_model(audio, lang, "cuda", "float16")
            device = "cuda"
        except Exception as err:  # no usable GPU: slower, but fine after the meeting
            print(f"GPU transcription failed ({err}). Using the CPU, which is slower.", file=sys.stderr)
            segments, info = run_model(audio, lang, "cpu", "int8")
            device = "cpu"
        for seg in segments:
            text = seg.text.strip()
            if text and not JUNK.match(text):
                lines.append({"start": round(seg.start, 1), "end": round(seg.end, 1), "text": text})
        print(f"{len(lines)} lines, language {info.language}, device {device}")
    else:
        print("No sound was recorded.")

    (run / "transcript.json").write_text(json.dumps(lines, ensure_ascii=False, indent=1), encoding="utf-8")
    (run / "transcript.txt").write_text(
        "\n".join(f"[{clock(x['start'])}] {x['text']}" for x in lines), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
