import asyncio
import os
import tempfile
from pathlib import Path

MAX_AUDIO_BYTES = int(os.getenv("TRANSCRIBE_MAX_BYTES", str(5 * 1024 * 1024)))
DEFAULT_LANGUAGE = os.getenv("TRANSCRIBE_LANGUAGE", "en-US").strip() or "en-US"

_recognizer = None


class TranscriptionError(Exception):
    pass


def _get_recognizer():
    global _recognizer
    if _recognizer is None:
        try:
            import speech_recognition as sr
        except ImportError as exc:
            raise TranscriptionError(
                "SpeechRecognition is not installed. Run: pip install 'SpeechRecognition>=3.10.0'"
            ) from exc
        _recognizer = sr.Recognizer()
    return _recognizer


def _transcribe_bytes(data: bytes, filename: str, language: str) -> str:
    if not data:
        raise TranscriptionError("Empty audio upload.")
    if len(data) > MAX_AUDIO_BYTES:
        raise TranscriptionError("Audio file is too large.")

    import speech_recognition as sr

    recognizer = _get_recognizer()
    suffix = Path(filename or "voice.wav").suffix.lower() or ".wav"
    if suffix not in {".wav", ".aiff", ".aif", ".flac"}:
        raise TranscriptionError("Upload a WAV recording.")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name

    try:
        with sr.AudioFile(path) as source:
            audio = recognizer.record(source)
        try:
            text = recognizer.recognize_google(audio, language=language or DEFAULT_LANGUAGE)
        except sr.UnknownValueError as exc:
            raise TranscriptionError("No speech detected in the recording.") from exc
        except sr.RequestError as exc:
            raise TranscriptionError(f"Speech recognition service is unavailable: {exc}") from exc
    finally:
        Path(path).unlink(missing_ok=True)

    cleaned = " ".join(str(text).split())
    if not cleaned:
        raise TranscriptionError("No speech detected in the recording.")
    return cleaned


async def transcribe_audio(data: bytes, filename: str, language: str | None = None) -> str:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        _transcribe_bytes,
        data,
        filename,
        language or DEFAULT_LANGUAGE,
    )
