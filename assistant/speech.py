import csv
import io
import re
import threading
import wave
from pathlib import Path

import numpy as np

LANGUAGES = {
    "zh": "中文",
    "en": "English",
    "ja": "日本語",
    "ko": "한국어",
    "fr": "Français",
    "de": "Deutsch",
    "es": "Español",
    "ru": "Русский",
}
DEFAULT_TERMS = {
    "Ka 卫星": ["卡卫星", "Ka卫星", "KA 卫星"],
    "边云协同": ["边云协调", "边缘云协同", "边云协童"],
    "LoRA": ["洛拉", "L O R A", "low rank adaptation"],
    "昇腾": ["升腾", "生腾"],
    "DCU": ["D C U", "迪西优"],
    "水电站": ["水电栈", "水电战"],
    "船舶 CCPD": ["船舶CCPD", "船舶 C C P D", "船舶西西皮迪"],
}


def words(body):
    if isinstance(body, str):
        rows = list(csv.reader(io.StringIO(body.lstrip("\ufeff"))))
        if rows and rows[0] and rows[0][0].strip().lower() in ("canonical", "标准词", "术语"):
            rows = rows[1:]
        body = {
            r[0].strip(): [a.strip() for cell in r[1:] for a in cell.split("|") if a.strip()]
            for r in rows
            if r and r[0].strip()
        }
    if not isinstance(body, dict) or len(body) > 300:
        raise ValueError("词库格式为标准词和别名数组，最多 300 个标准词")
    result = {}
    for term, aliases in body.items():
        if (
            not isinstance(term, str)
            or not 1 <= len(term.strip()) <= 64
            or not isinstance(aliases, list)
            or len(aliases) > 20
        ):
            raise ValueError("标准词或别名格式无效")
        if any(not isinstance(a, str) or not 1 <= len(a.strip()) <= 80 for a in aliases):
            raise ValueError("每条别名限 1 至 80 个字符")
        result[term.strip()] = [a.strip() for a in aliases]
    return result


def align(text, terms):
    lookup = {}
    for canonical, aliases in terms.items():
        for a in (canonical, *aliases):
            lookup[a.casefold()] = canonical
    if not lookup:
        return text
    parts = []
    for a in sorted(lookup, key=len, reverse=True):
        left = r"(?<![a-zA-Z0-9_])" if a[0].isascii() and a[0].isalnum() else ""
        right = r"(?![a-zA-Z0-9_])" if a[-1].isascii() and a[-1].isalnum() else ""
        parts.append(left + re.escape(a) + right)
    return re.sub("|".join(parts), lambda m: lookup[m[0].casefold()], text, flags=re.IGNORECASE)


def samples(blob, minimum=0.35):
    try:
        with wave.open(io.BytesIO(blob)) as w:
            if (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getcomptype()) != (
                1,
                2,
                16000,
                "NONE",
            ):
                raise ValueError("需要 16 kHz 单声道 PCM16 WAV")
            count = w.getnframes()
            if not minimum * 16000 <= count <= 16000 * 16:
                raise ValueError("语音时长超出范围")
            data = w.readframes(count)
            if len(data) != 2 * count:
                raise ValueError("音频不完整")
        return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768
    except (wave.Error, EOFError) as exc:
        raise ValueError("WAV 文件无效") from exc


class Models:
    def __init__(self, directory):
        self.path = Path(directory)
        self.lock = threading.RLock()
        self.trans_lock = threading.RLock()
        self.asr = self.speaker = self.trans = None

    def hear(self, audio, language="auto"):
        import sherpa_onnx as so

        with self.lock:
            if self.asr is None:
                self.asr = so.OfflineRecognizer.from_sense_voice(
                    model=str(self.path / "asr.onnx"),
                    tokens=str(self.path / "tokens.txt"),
                    num_threads=2,
                    use_itn=True,
                    language="auto",
                )
            stream = self.asr.create_stream()
            stream.accept_waveform(16000, audio)
            self.asr.decode_stream(stream)
            result = stream.result
            detected = str(getattr(result, "lang", "")).strip("<|>").lower()
            clean = re.sub(r"<\|[^|]*\|>", "", result.text).strip()
            if detected == "yue":
                detected = "zh"
            return clean, detected if detected in LANGUAGES else (
                language if language in LANGUAGES else ""
            )

    def voice(self, audio):
        import sherpa_onnx as so

        with self.lock:
            if self.speaker is None:
                cfg = so.SpeakerEmbeddingExtractorConfig(
                    model=str(self.path / "speaker.onnx"), num_threads=2
                )
                self.speaker = so.SpeakerEmbeddingExtractor(cfg)
            stream = self.speaker.create_stream()
            stream.accept_waveform(16000, audio)
            stream.input_finished()
            if not self.speaker.is_ready(stream):
                raise ValueError("请录制一段更长的连续讲话")
            vector = np.asarray(self.speaker.compute(stream), dtype="<f4")
            return vector / max(np.linalg.norm(vector), 0.000001)

    def translate(self, text, source, target):
        if source not in LANGUAGES or target not in LANGUAGES:
            raise ValueError("不支持的翻译语种")
        if source == target:
            return text
        import ctranslate2
        import sentencepiece

        with self.trans_lock:
            if self.trans is None:
                path = self.path / "translation"
                self.sp = sentencepiece.SentencePieceProcessor(
                    model_file=str(path / "sentencepiece.bpe.model")
                )
                self.trans = ctranslate2.Translator(
                    str(path), device="cpu", compute_type="int8", inter_threads=1, intra_threads=3
                )
            src = ["__" + source + "__"] + self.sp.encode(text, out_type=str) + ["</s>"]
            pred = self.trans.translate_batch(
                [src],
                target_prefix=[["__" + target + "__"]],
                beam_size=2,
                max_decoding_length=min(180, 18 + len(src) * 3),
            )[0].hypotheses[0]
            return self.sp.decode(
                [p for p in pred if not p.startswith("__") and p not in ("</s>", "<s>")]
            ).strip()


def identify(vector, enrolled):
    scores = sorted(
        ((float(np.dot(vector, other)), uid, name) for uid, name, other in enrolled), reverse=True
    )
    if (
        scores
        and scores[0][0] >= 0.65
        and (len(scores) == 1 or scores[0][0] - scores[1][0] >= 0.10)
    ):
        return scores[0][1], scores[0][2]
    return None
