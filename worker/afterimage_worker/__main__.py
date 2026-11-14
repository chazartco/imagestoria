"""Command line: python -m afterimage_worker [run | check | bench] ..."""
from __future__ import annotations

import argparse
import logging
import logging.handlers
import signal
import sys

from . import __version__
from .config import ConfigError, load


def _logging(path: str | None) -> None:
    fmt = logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    out = logging.StreamHandler(sys.stdout)
    out.setFormatter(fmt)
    root.addHandler(out)
    if path:
        f = logging.handlers.RotatingFileHandler(path, maxBytes=5_000_000, backupCount=3, encoding="utf-8")
        f.setFormatter(fmt)
        root.addHandler(f)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="afterimage-worker", description="Reads the pictures of an ImageStoria library on this machine.")
    p.add_argument("--config", default="worker.toml", help="the config file (default: worker.toml)")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("run", help="work until stopped (the default)")
    sub.add_parser("check", help="check the config, the site, the token and the models, then stop")
    b = sub.add_parser("bench", help="try several vision models on the same pictures and write a page to compare them")
    b.add_argument("--models", required=True, help="model names, separated by commas")
    b.add_argument("--folder", help="a folder of pictures to use")
    b.add_argument("--from-site", type=int, metavar="N", help="borrow N pictures from the site instead (they are given back untouched)")
    b.add_argument("--out", default="bench", help="where to write the page (default: bench)")
    b.add_argument("--limit", type=int, default=200, help="the most pictures to use from a folder (default: 200)")
    b.add_argument("--add", action="store_true", help="add these models to the page an earlier run wrote for the same pictures")
    args = p.parse_args(argv)

    try:
        cfg = load(args.config)
    except ConfigError as e:
        print(f"Config: {e}", file=sys.stderr)
        return 2

    if args.cmd == "bench":
        _logging(None)
        from .bench import run_bench
        return run_bench(cfg, [m.strip() for m in args.models.split(",") if m.strip()], args.folder, args.from_site, args.out, args.limit, args.add)

    from .loop import Worker
    from .site import Refused, SiteDown
    from .vision import ModelDown

    if args.cmd == "check":
        _logging(None)
        ok = True
        try:
            w = Worker(cfg)
            r = w.beat()
            print(f'Site: ok. This token is "{r.get("name")}". Waiting: {r.get("waiting")}. The site takes: {", ".join(r.get("tasks", []))}.')
            missing = [t for t in cfg.tasks if t not in r.get("tasks", [])]
            if missing:
                print(f"Note: the site does not take {', '.join(missing)} yet.")
        except (SiteDown, Refused) as e:
            print(f"Site: {e}")
            return 1
        try:
            w.ready()
            if w.vision:
                print(f"Vision model server: ok ({cfg.vision.endpoint}, {cfg.vision.model} {w.vision.version()}).")
        except ModelDown as e:
            print(f"Vision model server: {e}")
            ok = False
        for part in (w.embedder, w.facer):
            if part:
                print(f"{part.label}: {part.name}, on {part.device}.")
        print("GPU:", w.info["gpu"] or "none found")
        return 0 if ok else 1

    _logging(str(cfg.dir(cfg.log)) if cfg.log else None)
    w = Worker(cfg)

    def stop(*_):
        logging.getLogger("worker").info("Stopping after the item in hand.")
        w.stop.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    w.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
