"""Turning a picture into numbers for search by meaning, with the image half of an image and text model.
The model runs with ONNX Runtime, on the GPU when there is one. The site runs the text half of the same model."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
from pathlib import Path

from PIL import Image, ImageOps

from .config import Config
from .vision import BadAnswer

log = logging.getLogger("worker")


def providers(device: str) -> list[str]:
    import onnxruntime as ort

    have = ort.get_available_providers()
    if device == "cpu" or "CUDAExecutionProvider" not in have:
        return ["CPUExecutionProvider"]
    if hasattr(ort, "preload_dlls"):
        try:
            ort.preload_dlls()  # the NVIDIA libraries that came from pip
        except Exception:  # noqa: BLE001  a missing library shows up as a CPU session below, which is reported
            pass
    return ["CUDAExecutionProvider", "CPUExecutionProvider"]


def session(path: Path, device: str):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    s = ort.InferenceSession(str(path), sess_options=opts, providers=providers(device))
    return s, ("GPU" if "CUDAExecutionProvider" in s.get_providers() else "CPU")


def fetch_model(cfg: Config, repo: str, files: list[str]) -> Path:
    """A model's files: a folder on this machine, or a Hugging Face repo fetched once into models_dir."""
    local = Path(repo)
    if local.is_dir():
        return local
    from huggingface_hub import hf_hub_download

    root = cfg.dir(cfg.models_dir) / repo.replace("/", "--")
    for f in files:
        if not (root / f).exists():
            log.info("Fetching %s from %s (once).", f, repo)
            hf_hub_download(repo, f, local_dir=root)
    return root


def file_version(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()[:12]


class Embedder:
    label = "Embedding model"

    def __init__(self, cfg: Config):
        import numpy as np

        self.np = np
        e = cfg.embed
        root = fetch_model(cfg, e.model, [e.file, "preprocessor_config.json"])
        self.name = e.model
        self.version = file_version(root / e.file)
        pre = json.loads((root / "preprocessor_config.json").read_text(encoding="utf-8"))
        size = pre.get("size") or {}
        self.size = (int(size.get("width", 224)), int(size.get("height", 224)))
        self.resample = {0: Image.NEAREST, 1: Image.LANCZOS, 2: Image.BILINEAR, 3: Image.BICUBIC}.get(pre.get("resample", 2), Image.BILINEAR)
        self.scale = float(pre.get("rescale_factor", 1 / 255))
        self.mean = np.array(pre.get("image_mean", [0.5, 0.5, 0.5]), dtype=np.float32)
        self.std = np.array(pre.get("image_std", [0.5, 0.5, 0.5]), dtype=np.float32)
        self.sess, self.device = session(root / e.file, e.device)
        self.input = self.sess.get_inputs()[0].name
        outs = [o.name for o in self.sess.get_outputs()]
        self.output = next((o for o in ("pooler_output", "image_embeds") if o in outs), outs[-1])

    def vector(self, picture: bytes):
        """The whole picture, squeezed to the model's square. Nothing is cut off, so what is at the edges still counts."""
        np = self.np
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(picture))).convert("RGB").resize(self.size, self.resample)
        x = (np.asarray(im, dtype=np.float32) * self.scale - self.mean) / self.std
        v = self.sess.run([self.output], {self.input: x.transpose(2, 0, 1)[None]})[0][0].astype(np.float32)
        n = float(np.linalg.norm(v))
        if not n > 1e-6 or not np.isfinite(v).all():
            raise BadAnswer("The embedding model gave numbers that cannot be used.")
        return v / n

    def read(self, picture: bytes) -> dict:
        v = self.vector(picture)
        return {"dim": int(v.shape[0]), "vector": base64.b64encode(v.astype("<f4").tobytes()).decode()}
