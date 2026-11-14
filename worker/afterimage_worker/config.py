"""The worker's settings, read from one TOML file."""
from __future__ import annotations

import datetime as dt
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

TASKS = ("caption", "embed", "faces", "place")


class ConfigError(Exception):
    pass


@dataclass
class Vision:
    endpoint: str = "http://127.0.0.1:11434/v1"
    model: str = ""
    api_key: str = ""
    max_edge: int = 1024
    timeout: float = 180.0
    max_tokens: int = 700
    # Extra fields sent with every request, for a model server that needs them.
    extra: dict = field(default_factory=dict)


@dataclass
class Embed:
    # A folder holding the ONNX export of an image and text model, or a Hugging Face repo id to fetch it from once.
    model: str = "onnx-community/siglip2-base-patch16-224-ONNX"
    file: str = "onnx/vision_model.onnx"
    device: str = "auto"  # auto, cuda or cpu


@dataclass
class Faces:
    # "open" uses models with a permissive licence. "insightface" uses the InsightFace buffalo_l pack,
    # which is for non-commercial research use only.
    models: str = "open"
    min_size: int = 40       # the shorter side of a face box, in pixels of the file that was read
    min_score: float = 0.6   # how sure the detector must be
    min_sharpness: float = 80.0
    max_faces: int = 40
    device: str = "auto"
    source: str = "orig"     # orig or display


@dataclass
class Config:
    site: str = ""
    token: str = ""
    tasks: tuple = ("caption",)
    batch: int = 4
    idle_seconds: float = 60.0
    hours: str = ""          # "22:00-07:00" works only between those times. Empty works at any time.
    log: str = "worker.log"
    models_dir: str = "models"
    vision: Vision = field(default_factory=Vision)
    embed: Embed = field(default_factory=Embed)
    faces: Faces = field(default_factory=Faces)
    path: Path = Path("worker.toml")

    def window(self) -> tuple[dt.time, dt.time] | None:
        if not self.hours.strip():
            return None
        try:
            a, b = self.hours.split("-")
            return dt.time.fromisoformat(a.strip()), dt.time.fromisoformat(b.strip())
        except ValueError as e:
            raise ConfigError(f'hours must look like "22:00-07:00", not "{self.hours}".') from e

    def may_work(self, now: dt.datetime | None = None) -> bool:
        """True when the clock is inside the working hours. A window may cross midnight."""
        w = self.window()
        if not w:
            return True
        t = (now or dt.datetime.now()).time()
        a, b = w
        return a <= t < b if a <= b else (t >= a or t < b)

    def dir(self, name: str) -> Path:
        p = Path(name)
        return p if p.is_absolute() else self.path.parent / p


def _section(cls, raw: dict, name: str):
    known = {f for f in cls.__dataclass_fields__}
    extra = set(raw) - known
    if extra:
        raise ConfigError(f"Unknown setting in [{name}]: {', '.join(sorted(extra))}.")
    return cls(**raw)


def load(path: str | Path) -> Config:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"There is no config file at {p}. Copy worker.example.toml to worker.toml and fill it in.")
    try:
        # utf-8-sig: Notepad and PowerShell on Windows may put a byte-order mark at the start of the file
        raw = tomllib.loads(p.read_text(encoding="utf-8-sig"))
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{p} is not valid TOML: {e}") from e
    vision = _section(Vision, raw.pop("vision", {}), "vision")
    embed = _section(Embed, raw.pop("embed", {}), "embed")
    faces = _section(Faces, raw.pop("faces", {}), "faces")
    known = set(Config.__dataclass_fields__) - {"vision", "embed", "faces", "path"}
    extra = set(raw) - known
    if extra:
        raise ConfigError(f"Unknown setting: {', '.join(sorted(extra))}.")
    c = Config(**raw, vision=vision, embed=embed, faces=faces, path=p.resolve())
    c.tasks = tuple(c.tasks)
    c.site = c.site.rstrip("/")
    if not c.site.startswith(("http://", "https://")):
        raise ConfigError('site must be the address of your ImageStoria, such as "https://photos.example.com".')
    if not c.token or "PASTE" in c.token:
        raise ConfigError("token is empty. Make one on the site: People and settings, Workers, Make a token.")
    bad = [t for t in c.tasks if t not in TASKS]
    if bad or not c.tasks:
        raise ConfigError(f"tasks must be chosen from {', '.join(TASKS)}.")
    if "caption" in c.tasks or "place" in c.tasks:
        if not c.vision.model:
            raise ConfigError("Set model under [vision] to the name of the vision model your model server runs.")
    if not 1 <= c.batch <= 64:
        raise ConfigError("batch must be between 1 and 64.")
    if c.faces.models not in ("open", "insightface"):
        raise ConfigError('models under [faces] must be "open" or "insightface".')
    c.window()
    return c
