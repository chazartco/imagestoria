"""Try several vision models on the same pictures, and write a page to read them side by side.
Models are not chosen on paper: run this on your own photos and pick the one whose answers you like."""
from __future__ import annotations

import html
import io
import json
import logging
import re
import statistics
import subprocess
import time
from pathlib import Path

import httpx
from PIL import Image, ImageOps

from .config import Config
from .site import Refused, Site, SiteDown
from .vision import BadAnswer, ModelDown, VisionModel, caption_prompt, to_jpeg

log = logging.getLogger("worker")
PICS = (".jpg", ".jpeg", ".png", ".webp")


def vram_used() -> int | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
        return sum(int(x) for x in out.split())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _unload(endpoint: str, model: str) -> None:
    """Ask Ollama to drop a model from the GPU so the next one is measured alone. Other servers ignore this."""
    try:
        httpx.post(re.sub(r"/v1$", "", endpoint.rstrip("/")) + "/api/generate", json={"model": model, "keep_alive": 0}, timeout=30)
    except httpx.HTTPError:
        pass


def gather(cfg: Config, site: Site, folder: str | None, from_site: int | None, out: Path, limit: int) -> list[dict]:
    """The pictures to try, each saved once as a JPEG the models are shown and a smaller one for the page."""
    pics_dir = out / "pics"
    pics_dir.mkdir(parents=True, exist_ok=True)
    raw: list[tuple[str, str, bytes]] = []
    if folder:
        files = sorted(p for p in Path(folder).rglob("*") if p.suffix.lower() in PICS)
        step = max(1, len(files) // limit)
        for p in files[::step][:limit]:
            raw.append((p.name, "photo", p.read_bytes()))
    else:
        held: list[str] = []
        try:
            while len(raw) < (from_site or 0):
                got = site.claim(["caption"], min(64, from_site - len(raw))).get("items", [])
                if not got:
                    break
                for it in got:
                    held.append(it["id"])
                    raw.append((it["id"], it.get("kind", "photo"), site.fetch(it["files"]["display"])))
                log.info("borrowed %d pictures", len(raw))
        finally:
            # nothing was read for the site, so everything goes back in line untouched
            for i in range(0, len(held), 500):
                site.release(held[i : i + 500])
    pics = []
    for n, (name, kind, data) in enumerate(raw):
        try:
            jpeg, size = to_jpeg(data, cfg.vision.max_edge)
        except Exception as e:  # a file Pillow cannot open is left out, not fatal
            log.info("left out %s: %s", name, e)
            continue
        small = ImageOps.exif_transpose(Image.open(io.BytesIO(jpeg)))
        small.thumbnail((560, 560), Image.LANCZOS)
        f = pics_dir / f"{n:04d}.jpg"
        small.save(f, "JPEG", quality=82)
        pics.append({"n": n, "name": name, "kind": kind, "jpeg": jpeg, "file": f"pics/{f.name}", "w": small.width, "h": small.height})
    return pics


def run_bench(cfg: Config, models: list[str], folder: str | None, from_site: int | None, out_dir: str, limit: int, add: bool = False) -> int:
    if not folder and not from_site:
        print("Give --folder with pictures, or --from-site N to borrow N pictures from the site.")
        return 2
    out = Path(out_dir)
    site = Site(cfg.site, cfg.token)
    try:
        scenes = site.heartbeat({"doing": "bench"}).get("scenes") or []
    except (SiteDown, Refused) as e:
        print(f"The site is needed for its list of scenes: {e}")
        return 1
    pics = gather(cfg, site, folder, from_site, out, limit)
    if not pics:
        print("No pictures to try.")
        return 1
    log.info("%d pictures, %d models", len(pics), len(models))
    v = cfg.vision
    base_vram = vram_used()
    summary, answers = [], {m: {} for m in models}
    for m in models:
        for other in models:
            _unload(v.endpoint, other)
        time.sleep(2)
        model = VisionModel(v.endpoint, m, v.api_key, v.timeout, v.extra, v.max_edge, max_tokens=v.max_tokens)
        row = {"model": m, "version": "", "ok": 0, "retried": 0, "failed": 0, "times": [], "vram": None, "error": ""}
        try:
            model.ready()
            t0 = time.monotonic()
            model.ask(pics[0]["jpeg"], "Say hello as JSON: {\"hello\": \"...\"}", {"type": "object", "properties": {"hello": {"type": "string"}}, "required": ["hello"]}, "hello")
            row["load"] = round(time.monotonic() - t0, 1)
        except (ModelDown, BadAnswer) as e:
            row["error"] = str(e)
            summary.append(row)
            log.info("%s could not start: %s", m, e)
            continue
        row["version"] = model.version()
        peak = 0
        for p in pics:
            t0 = time.monotonic()
            calls = {"n": 0}
            ask = model.ask

            def counted(*a, _ask=ask, **k):
                calls["n"] += 1
                return _ask(*a, **k)

            model.ask = counted
            try:
                data = model.caption(p["jpeg"], scenes, p["kind"])
                row["ok"] += 1
                answers[m][p["n"]] = data
            except BadAnswer as e:
                row["failed"] += 1
                answers[m][p["n"]] = {"error": str(e)}
            except ModelDown as e:
                row["error"] = str(e)
                break
            finally:
                model.ask = ask
            if calls["n"] > 1:
                row["retried"] += 1
            dt = time.monotonic() - t0
            row["times"].append(dt)
            answers[m][p["n"]]["seconds"] = round(dt, 2)
            used = vram_used()
            if used:
                peak = max(peak, used)
            if (p["n"] + 1) % 20 == 0:
                log.info("%s: %d of %d, %.1fs each", m, p["n"] + 1, len(pics), statistics.mean(row["times"]))
        row["vram"] = peak or None
        summary.append(row)
    for other in models:
        _unload(v.endpoint, other)
    for row in summary:
        t = row.pop("times")
        row["mean"] = round(statistics.mean(t), 2) if t else None
        row["median"] = round(statistics.median(t), 2) if t else None
        row["slowest"] = round(max(t), 2) if t else None
    if add and (out / "results.json").exists():
        # keep what an earlier run found for other models on the same pictures, so a model can be tried later and compared
        old = json.loads((out / "results.json").read_text(encoding="utf-8"))
        if [p["name"] for p in old.get("pictures", [])] == [p["name"] for p in pics]:
            summary = [r for r in old["summary"] if r["model"] not in models] + summary
            answers = {**{m: {int(k): a for k, a in old["answers"][m].items()} for m in old["answers"] if m not in models}, **answers}
        else:
            log.info("The earlier run used other pictures, so it is not kept.")
    meta = {"pictures": len(pics), "max_edge": v.max_edge, "endpoint": v.endpoint, "idle_vram": base_vram, "prompt": caption_prompt(scenes), "when": time.strftime("%Y-%m-%d %H:%M")}
    (out / "results.json").write_text(json.dumps({"meta": meta, "summary": summary, "answers": answers, "pictures": [{k: p[k] for k in ("n", "name", "kind", "file")} for p in pics]}, indent=1), encoding="utf-8")
    (out / "index.html").write_text(page(meta, summary, answers, pics), encoding="utf-8")
    print(f"Wrote {out / 'index.html'}")
    return 0


def page(meta: dict, summary: list[dict], answers: dict, pics: list[dict]) -> str:
    e = html.escape
    models = [r["model"] for r in summary]
    rows = "".join(
        f"<tr><th>{e(r['model'])}</th><td>{e(r['version'])}</td><td>{r.get('mean') or ''}</td><td>{r.get('median') or ''}</td><td>{r.get('slowest') or ''}</td>"
        f"<td>{r['ok']}</td><td>{r['retried']}</td><td>{r['failed']}</td><td>{round(r['vram'] / 1024, 1) if r.get('vram') else ''}</td><td>{r.get('load', '')}</td><td>{e(r['error'])}</td></tr>"
        for r in summary)

    def cell(m: str, n: int) -> str:
        a = answers.get(m, {}).get(n)
        if not a:
            return "<td class=none>not run</td>"
        if "error" in a:
            return f"<td class=bad>Failed: {e(a['error'])}<small>{a.get('seconds', '')} s</small></td>"
        objs = "".join(f"<li>{e(o['label'])} <i>{round(o['confidence'] * 100)}%</i></li>" for o in a["objects"])
        text = f"<p class=txt>Text: {e(a['text'])}</p>" if a.get("text") else ""
        return f"<td><p class=cap>{e(a['caption'])}</p><p class=scene>{e(a['scene'])}</p><ul>{objs}</ul>{text}<small>{a.get('seconds', '')} s</small></td>"

    body = "".join(
        f"<tr><td class=pic><img src='{e(p['file'])}' width={p['w']} height={p['h']} loading=lazy alt=''><small>{e(p['name'][:40])}</small></td>{''.join(cell(m, p['n']) for m in models)}</tr>"
        for p in pics)
    idle = f" The GPU held {round(meta['idle_vram'] / 1024, 1)} GB before any model was loaded, so subtract that." if meta.get("idle_vram") else ""
    return f"""<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1"><title>Vision model bench</title>
<style>
body {{ font: 14px/1.45 system-ui, sans-serif; margin: 0; padding: 20px; background: #1a1b1d; color: #eceae6; }}
h1 {{ font-size: 22px; }} p.note {{ max-width: 900px; color: #9da0a6; }}
table {{ border-collapse: collapse; }} th, td {{ border: 1px solid #383b3f; padding: 8px 10px; vertical-align: top; text-align: left; }}
table.sum td, table.sum th {{ white-space: nowrap; }} table.sum {{ margin: 14px 0 26px; }}
table.all {{ width: 100%; table-layout: fixed; }} table.all thead th {{ position: sticky; top: 0; background: #2b2d30; z-index: 1; }}
td.pic {{ width: 300px; }} td.pic img {{ display: block; max-width: 100%; height: auto; }} small {{ display: block; color: #9da0a6; margin-top: 6px; }}
p {{ margin: 0 0 6px; }} .cap {{ font-size: 15px; }} .scene {{ color: #a9c0ff; font-weight: 600; }} ul {{ margin: 0; padding-left: 18px; columns: 2; }} li i {{ color: #9da0a6; font-style: normal; }}
.txt {{ color: #ffc457; margin-top: 6px; overflow-wrap: anywhere; }} td.bad {{ color: #ef7a72; }} td.none {{ color: #9da0a6; }} pre {{ white-space: pre-wrap; background: #212325; padding: 12px; max-width: 900px; }}
</style>
<h1>Vision model bench</h1>
<p class=note>{meta['pictures']} pictures, each shown to every model at {meta['max_edge']} px on its long side, through {e(meta['endpoint'])}. Run on {meta['when']}.
Times are seconds per picture with the model already loaded. "Asked twice" counts pictures where the first answer was not usable and the second was. "Failed" counts pictures where both were not.
GPU memory is the most that was in use while the model worked, in GB.{idle}</p>
<table class=sum><thead><tr><th>Model</th><th>Version</th><th>Mean s</th><th>Median s</th><th>Slowest s</th><th>Read</th><th>Asked twice</th><th>Failed</th><th>GPU GB</th><th>Load s</th><th>Problem</th></tr></thead><tbody>{rows}</tbody></table>
<details><summary>The request each model was given</summary><pre>{e(meta['prompt'])}</pre></details>
<table class=all><thead><tr><th style="width:300px">Picture</th>{''.join(f'<th>{e(m)}</th>' for m in models)}</tr></thead><tbody>{body}</tbody></table>
</html>"""
