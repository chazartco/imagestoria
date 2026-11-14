"""The worker's main loop: ask the site for work, read the pictures, hand the results in.
It is polite. It backs off when the site or the model server is away, it never spins,
and it holds nothing on disk that matters, so it picks up where it left off after a reboot."""
from __future__ import annotations

import logging
import platform
import random
import socket
import subprocess
import threading
import time

from . import __version__
from .config import Config
from .site import Refused, Site, SiteDown
from .vision import BadAnswer, ModelDown, VisionModel

log = logging.getLogger("worker")


def gpu_name() -> str:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
        return "; ".join(f"{n.strip()}, {round(int(m) / 1024)} GB" for n, m in (line.split(",") for line in out if "," in line))
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""


class Backoff:
    """Waits that double from 5 seconds to 5 minutes, with a little randomness so several workers do not knock together."""

    def __init__(self, first: float = 5.0, most: float = 300.0):
        self.first, self.most, self.now = first, most, first

    def next(self) -> float:
        d = self.now * random.uniform(0.8, 1.2)
        self.now = min(self.most, self.now * 2)
        return d

    def reset(self) -> None:
        self.now = self.first


class Worker:
    def __init__(self, cfg: Config, site: Site | None = None, sleep=time.sleep):
        self.cfg = cfg
        self.site = site or Site(cfg.site, cfg.token)
        self.sleep = sleep
        self.scenes: list[str] = []
        self.doing = "starting"
        self.stop = threading.Event()
        self.holding: set[str] = set()
        self.vision: VisionModel | None = None
        self.embedder = None
        self.facer = None
        if "caption" in cfg.tasks or "place" in cfg.tasks:
            v = cfg.vision
            self.vision = VisionModel(v.endpoint, v.model, v.api_key, v.timeout, v.extra, v.max_edge, max_tokens=v.max_tokens)
        if "embed" in cfg.tasks:
            from .embed import Embedder
            self.embedder = Embedder(cfg)
        if "faces" in cfg.tasks:
            from .faces import FaceReader
            self.facer = FaceReader(cfg)
        self.info = {"host": socket.gethostname(), "os": f"{platform.system()} {platform.release()}"[:120], "gpu": gpu_name(), "version": __version__}

    def models(self) -> dict:
        m = {}
        if self.vision:
            for t in ("caption", "place"):
                if t in self.cfg.tasks:
                    m[t] = self.cfg.vision.model
        if self.embedder:
            m["embed"] = self.embedder.name
        if self.facer:
            m["faces"] = self.facer.name
        return m

    # ----- the site -----

    def beat(self) -> dict:
        r = self.site.heartbeat({**self.info, "doing": self.doing, "models": self.models()})
        self.scenes = r.get("scenes") or self.scenes
        return r

    def _beats(self) -> None:
        """Runs beside the main loop. Says the worker is alive once a minute, which also keeps its claims from running out."""
        while not self.stop.wait(60):
            try:
                self.beat()
            except (SiteDown, Refused):
                pass

    # ----- one item -----

    def read(self, item: dict, task: str, files: dict) -> tuple[dict, dict]:
        """Do one task for one item. Returns what was found and which model found it."""
        if task == "caption":
            data = self.vision.caption(files["display"](), self.scenes, item.get("kind", "photo"))
            return data, {"name": self.vision.model, "version": self.vision.version()}
        if task == "place":
            data = self.vision.place(files["display"]())
            return data, {"name": self.vision.model, "version": self.vision.version()}
        if task == "embed":
            return self.embedder.read(files["display"]()), {"name": self.embedder.name, "version": self.embedder.version}
        if task == "faces":
            src = self.cfg.faces.source if item.get("kind") != "video" and (item.get("mime") or "").startswith("image/") else "display"
            return self.facer.read(files[src](), files["display"]), {"name": self.facer.name, "version": self.facer.version}
        raise BadAnswer(f"This worker does not know the task {task}.")

    def work_on(self, item: dict) -> None:
        cache: dict[str, bytes] = {}

        def getter(kind: str):
            def get() -> bytes:
                if kind not in cache:
                    link = item["files"].get(kind) or item["files"]["display"]
                    cache[kind] = self.site.fetch(link)
                return cache[kind]
            return get

        files = {"display": getter("display"), "orig": getter("orig")}
        for task in item["tasks"]:
            t0 = time.monotonic()
            try:
                data, model = self.read(item, task, files)
                out = {"itemId": item["id"], "task": task, "model": model, "data": data}
                note = _note(task, data)
            except BadAnswer as e:
                out = {"itemId": item["id"], "task": task, "error": str(e)[:480]}
                note = f"FAILED {e}"
            except Refused as e:
                out = {"itemId": item["id"], "task": task, "error": f"The file could not be fetched: {e}"[:480]}
                note = f"FAILED {e}"
            r = self.site.results([out])
            for no in r.get("refused", []):
                note = f"REFUSED {no.get('reason')}"
            log.info("item %s %s %.1fs %s", item["id"][:8], task, time.monotonic() - t0, note)

    # ----- the loop -----

    def ready(self) -> None:
        if self.vision:
            self.vision.ready()

    def once(self) -> int:
        """One round: claim a batch and work through it. Returns how many items were handed out."""
        self.ready()
        got = self.site.claim(self.cfg.tasks, self.cfg.batch)
        if got.get("paused"):
            self.doing = "paused on the site"
            return -1
        items = got.get("items", [])
        self.holding = {i["id"] for i in items}
        for n, item in enumerate(items):
            if self.stop.is_set():
                break
            self.doing = f"{', '.join(item['tasks'])}: item {n + 1} of {len(items)}"
            self.work_on(item)
            self.holding.discard(item["id"])
        return len(items)

    def run(self) -> None:
        log.info("ImageStoria worker %s. Site %s. Tasks: %s. %s", __version__, self.cfg.site, ", ".join(self.cfg.tasks), self.info["gpu"] or "No NVIDIA GPU found.")
        threading.Thread(target=self._beats, daemon=True).start()
        back, said = Backoff(), ""

        def wait(why: str, seconds: float) -> None:
            nonlocal said
            if why != said:
                log.info("%s", why)
                said = why
            self.doing = why[:190]
            self.stop.wait(seconds) if self.sleep is time.sleep else self.sleep(seconds)

        while not self.stop.is_set():
            if not self.cfg.may_work():
                wait(f"Outside working hours ({self.cfg.hours}). Waiting.", 60)
                continue
            try:
                if not self.scenes:
                    self.beat()
                n = self.once()
                back.reset()
                if n == -1:
                    wait("Paused on the site. Waiting.", self.cfg.idle_seconds)
                elif n == 0:
                    wait("Nothing to do. Waiting for new pictures.", self.cfg.idle_seconds * random.uniform(0.9, 1.1))
                else:
                    said = ""
            except SiteDown as e:
                wait(f"The site is not reachable: {e} Trying again shortly.", back.next())
            except ModelDown as e:
                self.release()
                wait(f"{e} Trying again shortly.", back.next())
            except Refused as e:
                # A revoked token will not start working again by itself. Keep waiting, slowly, so a fixed config or a new token is picked up on restart.
                wait(f"The site refused this worker: {e}", 300 if e.status in (401, 403) else back.next())
        self.release()

    def release(self) -> None:
        """Give back what is still held, so the site hands it out again at once."""
        if not self.holding:
            return
        try:
            self.site.release(sorted(self.holding))
        except (SiteDown, Refused):
            pass
        self.holding.clear()


def _note(task: str, data: dict) -> str:
    if task == "caption":
        return f'{data["scene"]}, {len(data["objects"])} objects: {data["caption"][:90]}'
    if task == "place":
        return f'{data["place"] or "no place"} ({data["confidence"]:.2f})'
    if task == "faces":
        return f'{len(data.get("faces", []))} faces'
    if task == "embed":
        return f'{data.get("dim", "?")} numbers'
    return "ok"
