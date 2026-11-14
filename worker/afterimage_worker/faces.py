"""Finding the faces in a picture, and turning each into numbers that can be compared with other faces.

Two sets of models, chosen in the config file:

  open         YuNet (detector, MIT licence) and AuraFace v1 (recogniser, Apache 2.0). May be used for anything.
  insightface  The InsightFace buffalo_l pack. More accurate on hard pictures. Its models are for
               non-commercial research use only, so this is for your own library and not for a product.

A face is left out when it is too small, too blurred, or the detector is not sure it is a face.
The cut-offs are min_size, min_sharpness and min_score under [faces] in the config file.
"""
from __future__ import annotations

import base64
import io
import logging

from PIL import Image, ImageOps

from .config import Config
from .embed import fetch_model, file_version, session
from .vision import BadAnswer

log = logging.getLogger("worker")

# Where the two eyes, the nose and the two corners of the mouth sit in the 112 x 112 picture a recogniser expects.
TEMPLATE = ((38.2946, 51.6963), (73.5318, 51.5014), (56.0252, 71.7366), (41.5493, 92.3655), (70.7299, 92.2041))


def iou(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def inside(a, b) -> float:
    """How much of the smaller box lies in the other. A face cut by the edge of a part is a small box inside the whole one."""
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    small = min(a[2] * a[3], b[2] * b[3])
    return inter / small if small > 0 else 0.0


def keep_best(faces: list[dict], overlap: float = 0.4, within: float = 0.6) -> list[dict]:
    """Of faces found more than once (in the whole picture and again in a part of it), keep the surest."""
    out: list[dict] = []
    for f in sorted(faces, key=lambda f: -f["score"]):
        if all(iou(f["box"], o["box"]) < overlap and inside(f["box"], o["box"]) < within for o in out):
            out.append(f)
    return out


def similarity(np, src, dst):
    """The turn, scale and shift that best lays the five points of a face on the template (Umeyama's method)."""
    src, dst = np.asarray(src, dtype=np.float64), np.asarray(dst, dtype=np.float64)
    ms, md = src.mean(0), dst.mean(0)
    s, d = src - ms, dst - md
    u, sv, vt = np.linalg.svd(d.T @ s / len(src))
    e = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        e[1, 1] = -1
    r = u @ e @ vt
    scale = (sv * e.diagonal()).sum() / s.var(0).sum()
    m = np.eye(3)
    m[:2, :2] = scale * r
    m[:2, 2] = md - scale * r @ ms
    return m


def sharpness(np, gray) -> float:
    """How much fine detail a face holds: the spread of its second differences. A blurred face scores low."""
    g = gray.astype(np.float32)
    lap = g[1:-1, :-2] + g[1:-1, 2:] + g[:-2, 1:-1] + g[2:, 1:-1] - 4 * g[1:-1, 1:-1]
    return float(lap.var())


class FaceReader:
    label = "Face models"

    def __init__(self, cfg: Config):
        import numpy as np

        self.np = np
        self.cfg = cfg.faces
        self.insight = None
        if self.cfg.models == "insightface":
            self._load_insightface(cfg)
        else:
            det = fetch_model(cfg, "opencv/face_detection_yunet", ["face_detection_yunet_2023mar.onnx"]) / "face_detection_yunet_2023mar.onnx"
            rec = fetch_model(cfg, "fal/AuraFace-v1", ["glintr100.onnx"]) / "glintr100.onnx"
            self.det, _ = session(det, self.cfg.device)
            self.rec, self.device = session(rec, self.cfg.device)
            self.name = "yunet-2023mar+auraface-v1"
            self.version = file_version(rec)
            self.det_in = self.det.get_inputs()[0].name
            self.det_out = [o.name for o in self.det.get_outputs()]
            self.rec_in = self.rec.get_inputs()[0].name

    def _load_insightface(self, cfg: Config) -> None:
        try:
            from insightface.app import FaceAnalysis
        except ImportError as e:
            raise RuntimeError('models = "insightface" needs the extra packages. Install them with: sh install.sh "gpu,insightface"') from e
        from .embed import providers

        app = FaceAnalysis(name="buffalo_l", root=str(cfg.dir(cfg.models_dir) / "insightface"), allowed_modules=["detection", "recognition"], providers=providers(self.cfg.device))
        app.prepare(ctx_id=0, det_size=(640, 640))
        self.insight = app
        self.device = "GPU" if "CUDAExecutionProvider" in providers(self.cfg.device) else "CPU"
        self.name = "insightface-buffalo_l"
        self.version = "non-commercial"

    # ----- the open models -----

    def _detect_part(self, im: Image.Image, ox: int, oy: int) -> list[dict]:
        """Faces in one piece of the picture, placed back where they are in the whole. The detector sees 640 x 640."""
        np = self.np
        scale = 640 / max(im.size)
        small = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.BILINEAR)
        canvas = np.zeros((640, 640, 3), dtype=np.float32)
        canvas[: small.height, : small.width] = np.asarray(small, dtype=np.float32)[:, :, ::-1]  # the detector wants blue first
        outs = dict(zip(self.det_out, self.det.run(self.det_out, {self.det_in: canvas.transpose(2, 0, 1)[None]})))
        found = []
        for stride in (8, 16, 32):
            cols = 640 // stride
            cls, obj = outs[f"cls_{stride}"][0, :, 0], outs[f"obj_{stride}"][0, :, 0]
            score = np.sqrt(np.clip(cls, 0, 1) * np.clip(obj, 0, 1))
            for i in np.nonzero(score >= self.cfg.min_score)[0]:
                row, col = divmod(int(i), cols)
                b, k = outs[f"bbox_{stride}"][0, i], outs[f"kps_{stride}"][0, i]
                w, h = float(np.exp(b[2])) * stride, float(np.exp(b[3])) * stride
                cx, cy = (col + float(b[0])) * stride, (row + float(b[1])) * stride
                pts = [((float(k[2 * n]) + col) * stride / scale + ox, (float(k[2 * n + 1]) + row) * stride / scale + oy) for n in range(5)]
                found.append({"box": [(cx - w / 2) / scale + ox, (cy - h / 2) / scale + oy, w / scale, h / scale], "score": float(score[i]), "pts": pts})
        return found

    def _detect(self, im: Image.Image) -> list[dict]:
        """The whole picture first. A large picture is then looked at again in overlapping parts, so small faces in a group are found."""
        faces = self._detect_part(im, 0, 0)
        long = max(im.size)
        n = 3 if long > 4000 else 2 if long > 1600 else 1
        if n > 1:
            tw, th = im.width / (n - 0.25 * (n - 1)), im.height / (n - 0.25 * (n - 1))
            for r in range(n):
                for c in range(n):
                    x, y = round(c * tw * 0.75), round(r * th * 0.75)
                    box = (x, y, min(im.width, round(x + tw)), min(im.height, round(y + th)))
                    faces += self._detect_part(im.crop(box), x, y)
        return keep_best(faces)

    def _read_open(self, im: Image.Image) -> tuple[list[dict], dict]:
        np = self.np
        skipped = {"small": 0, "blurred": 0}
        kept, crops = [], []
        for f in self._detect(im):
            x, y, w, h = f["box"]
            if min(w, h) < self.cfg.min_size:
                skipped["small"] += 1
                continue
            m = similarity(np, f["pts"], TEMPLATE)
            inv = np.linalg.inv(m)
            crop = im.transform((112, 112), Image.AFFINE, (inv[0, 0], inv[0, 1], inv[0, 2], inv[1, 0], inv[1, 1], inv[1, 2]), Image.BICUBIC)
            a = np.asarray(crop, dtype=np.float32)
            sharp = sharpness(np, a.mean(2))
            if sharp < self.cfg.min_sharpness:
                skipped["blurred"] += 1
                continue
            f["sharpness"] = sharp
            kept.append(f)
            crops.append(((a - 127.5) / 127.5).transpose(2, 0, 1))
        vecs = []
        for i in range(0, len(crops), 16):
            vecs += list(self.rec.run(None, {self.rec_in: np.stack(crops[i : i + 16])})[0])
        for f, v in zip(kept, vecs):
            f["vector"] = v
        return kept, skipped

    # ----- InsightFace -----

    def _read_insightface(self, im: Image.Image) -> tuple[list[dict], dict]:
        np = self.np
        from insightface.utils import face_align

        bgr = np.ascontiguousarray(np.asarray(im)[:, :, ::-1])
        skipped = {"small": 0, "blurred": 0}
        kept = []
        for f in self.insight.get(bgr):
            x1, y1, x2, y2 = (float(v) for v in f.bbox)
            if float(f.det_score) < self.cfg.min_score:
                continue
            if min(x2 - x1, y2 - y1) < self.cfg.min_size:
                skipped["small"] += 1
                continue
            sharp = sharpness(np, face_align.norm_crop(bgr, f.kps).astype(np.float32).mean(2))
            if sharp < self.cfg.min_sharpness:
                skipped["blurred"] += 1
                continue
            kept.append({"box": [x1, y1, x2 - x1, y2 - y1], "score": float(f.det_score), "sharpness": sharp, "vector": f.embedding})
        return kept, skipped

    # ----- what the site is sent -----

    def read(self, picture: bytes, fallback=None) -> dict:
        np = self.np
        try:
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(picture))).convert("RGB")
        except Exception:  # noqa: BLE001  an original this machine cannot open (HEIC, TIFF variants): use the copy the site made
            if fallback is None:
                raise BadAnswer("This picture could not be opened.") from None
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(fallback()))).convert("RGB")
        faces, skipped = self._read_insightface(im) if self.insight else self._read_open(im)
        out = []
        for f in faces:
            v = np.asarray(f["vector"], dtype=np.float32)
            n = float(np.linalg.norm(v))
            if not n > 1e-6 or not np.isfinite(v).all():
                continue
            x, y, w, h = f["box"]
            x, y = max(0.0, x), max(0.0, y)
            w, h = min(im.width - x, w), min(im.height - y, h)
            size = min(w, h)
            # one number for "how good a likeness is this": sure, large and sharp are each worth up to a third
            quality = round(float(f["score"]) * min(1.0, size / 160) ** 0.5 * min(1.0, f["sharpness"] / 800) ** 0.5, 3)
            out.append({"box": [round(x / im.width, 5), round(y / im.height, 5), round(w / im.width, 5), round(h / im.height, 5)],
                        "score": round(float(f["score"]), 3), "quality": quality, "size": round(size), "sharpness": round(f["sharpness"], 1),
                        "vector": base64.b64encode((v / n).astype("<f4").tobytes()).decode()})
        out.sort(key=lambda f: -f["quality"])
        return {"w": im.width, "h": im.height, "faces": out[: self.cfg.max_faces], "skipped": skipped}
