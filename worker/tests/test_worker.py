"""The worker against a stand-in site and a stand-in model server. No GPU and no network are needed.
Run with: .venv/bin/python -m unittest discover -s tests"""
from __future__ import annotations

import base64
import datetime as dt
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

from afterimage_worker import config as cfgmod
from afterimage_worker.loop import Backoff, Worker
from afterimage_worker.site import Refused, Site, SiteDown
from afterimage_worker.vision import BadAnswer, ModelDown, VisionModel, _parse, check_caption, check_place, to_jpeg

SCENES = ["beach", "city street", "other"]


def picture(w=800, h=400, color=(30, 90, 160)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (w, h), color).save(out, "WEBP")
    return out.getvalue()


class Fake(ThreadingHTTPServer):
    """A tiny server whose answers come from a function, and which remembers what it was asked."""

    def __init__(self, answer):
        self.answer, self.seen, self.down = answer, [], False

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _do(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                self.server.seen.append((self.command, self.path, body, dict(self.headers)))
                status, out = (503, {"error": "down"}) if self.server.down else self.server.answer(self.command, self.path, body, self.headers)
                data = out if isinstance(out, bytes) else json.dumps(out).encode()
                self.send_response(status)
                self.send_header("content-type", "application/octet-stream" if isinstance(out, bytes) else "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _do

        super().__init__(("127.0.0.1", 0), H)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"

    def calls(self, path):
        return [s for s in self.seen if s[1].startswith(path)]


class FakeSite(Fake):
    def __init__(self, items):
        self.items, self.posted, self.released, self.paused = list(items), [], [], False
        super().__init__(self.route)

    def route(self, method, path, body, headers):
        if headers.get("authorization") != "Bearer aiw_good":
            return 401, {"error": "This worker token is not valid. It may have been revoked."}
        if path == "/api/worker/heartbeat":
            return 200, {"ok": True, "name": "Tower", "paused": self.paused, "tasks": ["caption"], "scenes": SCENES, "waiting": {"caption": len(self.items)}}
        if path == "/api/worker/claim":
            if self.paused:
                return 200, {"paused": True, "items": []}
            got, self.items = self.items[: body["want"]], self.items[body["want"] :]
            return 200, {"paused": False, "leaseSeconds": 600, "items": got}
        if path == "/api/worker/results":
            self.posted += body["results"]
            return 200, {"accepted": len(body["results"]), "refused": []}
        if path == "/api/worker/release":
            self.released += body["itemIds"]
            return 200, {"released": len(body["itemIds"])}
        if path.startswith("/api/worker/files/"):
            return 200, picture()
        return 404, {"error": "No such endpoint."}


def item(n, tasks=("caption",), kind="photo"):
    return {"id": f"0000000{n}-0000-4000-8000-000000000000", "kind": kind, "w": 800, "h": 400, "mime": "image/jpeg", "tasks": list(tasks),
            "files": {"display": f"/api/worker/files/{n}/display", "orig": f"/api/worker/files/{n}/orig"}}


GOOD = {"caption": "A blue  wall.", "scene": "Other", "objects": [{"label": "Wall", "confidence": 0.9}, {"label": "wall", "confidence": 0.5}, {"label": "paint", "confidence": 80}], "text": "none"}


def chat(content):
    return 200, {"choices": [{"message": {"role": "assistant", "content": content if isinstance(content, str) else json.dumps(content)}}]}


class FakeModel(Fake):
    def __init__(self, replies):
        self.replies = list(replies)
        super().__init__(self.route)

    def route(self, method, path, body, headers):
        if path == "/v1/models":
            return 200, {"data": [{"id": "test-vision"}]}
        if path == "/api/tags":
            return 200, {"models": [{"name": "test-vision", "digest": "abcdef0123456789"}]}
        if path == "/v1/chat/completions":
            r = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
            return r if isinstance(r, tuple) else chat(r)
        return 404, {}


def make(site, model, **over):
    d = Path(tempfile.mkdtemp())
    text = f'site = "{site.url}"\ntoken = "{over.pop("token", "aiw_good")}"\nbatch = {over.pop("batch", 4)}\nlog = ""\nhours = "{over.pop("hours", "")}"\n[vision]\nendpoint = "{model.url}/v1"\nmodel = "test-vision"\n'
    (d / "worker.toml").write_text(text, encoding="utf-8")
    return cfgmod.load(d / "worker.toml")


class ConfigTest(unittest.TestCase):
    def cfg(self, text):
        d = Path(tempfile.mkdtemp())
        (d / "w.toml").write_text(text, encoding="utf-8")
        return cfgmod.load(d / "w.toml")

    def test_says_what_is_wrong_in_a_sentence(self):
        for text, want in [
            ('site = "photos"\ntoken = "x"', "site must be the address"),
            ('site = "https://a.example"\ntoken = "PASTE-THE-TOKEN-HERE"', "token is empty"),
            ('site = "https://a.example"\ntoken = "t"', "Set model under [vision]"),
            ('site = "https://a.example"\ntoken = "t"\ntasks = ["captions"]', "tasks must be chosen from"),
            ('site = "https://a.example"\ntoken = "t"\ncolour = 1', "Unknown setting: colour"),
            ('site = "https://a.example"\ntoken = "t"\nhours = "night"\n[vision]\nmodel = "m"', 'hours must look like'),
            ('site = "https://a.example"\ntoken = "t"\n[vision]\nmodel = "m"\nspeed = 2', "Unknown setting in [vision]: speed"),
        ]:
            with self.assertRaises(cfgmod.ConfigError) as e:
                self.cfg(text)
            self.assertIn(want, str(e.exception))
        with self.assertRaises(cfgmod.ConfigError) as e:
            cfgmod.load("/nowhere/worker.toml")
        self.assertIn("Copy worker.example.toml", str(e.exception))

    def test_the_example_file_is_valid_once_filled_in(self):
        text = (Path(__file__).parent.parent / "worker.example.toml").read_text(encoding="utf-8").replace("PASTE-THE-TOKEN-HERE", "aiw_x")
        c = self.cfg(text)
        self.assertEqual((c.site, c.tasks, c.batch, c.vision.max_edge, c.faces.models), ("https://photos.example.com", ("caption", "embed", "faces", "place"), 4, 1024, "open"))
        self.assertEqual((c.vision.model, c.vision.extra, c.vision.max_tokens), ("qwen3.5:9b-q4_K_M", {"reasoning_effort": "none"}, 700))

    def test_a_file_saved_by_notepad_with_a_byte_order_mark_is_read(self):
        d = Path(tempfile.mkdtemp())
        text = 'site = "https://a.example"\r\ntoken = "t"\r\n[vision]\r\nmodel = "m"\r\n'
        (d / "w.toml").write_bytes(bytes([0xEF, 0xBB, 0xBF]) + text.encode())
        self.assertEqual(cfgmod.load(d / "w.toml").site, "https://a.example")

    def test_working_hours_may_cross_midnight(self):
        c = self.cfg('site = "https://a.example"\ntoken = "t"\nhours = "22:00-07:00"\n[vision]\nmodel = "m"')
        at = lambda h, m=0: c.may_work(dt.datetime(2026, 1, 1, h, m))
        self.assertEqual([at(21, 59), at(22), at(3), at(6, 59), at(7), at(12)], [False, True, True, True, False, False])
        c.hours = "09:00-17:00"
        self.assertEqual([at(8), at(9), at(16, 59), at(17)], [False, True, True, False])
        c.hours = ""
        self.assertTrue(at(4))


class AnswerTest(unittest.TestCase):
    def test_finds_the_json_in_a_talkative_answer(self):
        self.assertEqual(_parse('<think>hmm {"a": 2}</think>\n```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(_parse('Sure! Here it is: {"a": 1} Hope that helps.'), {"a": 1})
        # an answer cut off by the length limit keeps what was complete
        cut = '{"caption": "A menu.", "scene": "other", "objects": [{"label": "menu", "confidence": 0.9}], "text": "TACOS 40\\n\\n\\n\\n\\'
        self.assertEqual(_parse(cut), {"caption": "A menu.", "scene": "other", "objects": [{"label": "menu", "confidence": 0.9}], "text": "TACOS 40"})
        self.assertEqual(_parse('{"caption": "A cat.", "objects": [{"label": "cat", "confidence": 0.9}, {"label": "so'), {"caption": "A cat.", "objects": [{"label": "cat", "confidence": 0.9}, {"label": "so"}]})
        for bad in ["", "no json here", "[1, 2]", '{"a": ']:
            with self.assertRaises(BadAnswer):
                _parse(bad)

    def test_tidies_a_good_answer_and_refuses_a_bad_one(self):
        self.assertEqual(check_caption(dict(GOOD), SCENES), {"caption": "A blue wall.", "scene": "other", "objects": [{"label": "wall", "confidence": 0.9}, {"label": "paint", "confidence": 0.8}], "text": ""})
        many = {**GOOD, "objects": [{"label": f"thing {i}", "confidence": 0.5} for i in range(30)]}
        self.assertEqual(len(check_caption(many, SCENES)["objects"]), 12)
        for bad, why in [({**GOOD, "caption": " "}, "no caption"), ({**GOOD, "scene": "moon"}, "not on the list"), ({**GOOD, "objects": "wall"}, "not a list"), ({**GOOD, "objects": [{"label": "x"}]}, "no confidence")]:
            with self.assertRaises(BadAnswer) as e:
                check_caption(bad, SCENES)
            self.assertIn(why, str(e.exception))

    def test_a_place_with_no_name_has_no_confidence(self):
        self.assertEqual(check_place({"place": "Unknown", "kind": "beach", "confidence": 0.7, "why": "sand"}), {"place": "", "kind": "beach", "confidence": 0.0, "why": "sand"})
        self.assertEqual(check_place({"place": " Eiffel Tower,  Paris ", "kind": "castle", "confidence": 95, "why": 3}), {"place": "Eiffel Tower, Paris", "kind": "unknown", "confidence": 0.95, "why": ""})

    def test_a_picture_is_made_smaller_whole(self):
        jpeg, size = to_jpeg(picture(2000, 500), 1024)
        self.assertEqual(size, (1024, 256))
        self.assertEqual(Image.open(io.BytesIO(jpeg)).format, "JPEG")
        self.assertEqual(to_jpeg(picture(300, 200), 1024)[1], (300, 200))


class LoopTest(unittest.TestCase):
    def test_reads_a_batch_and_hands_each_item_in(self):
        site = FakeSite([item(1), item(2, kind="video"), item(3)])
        model = FakeModel([GOOD, "I cannot do that.", {**GOOD, "scene": "moon"}, "```json\n" + json.dumps({**GOOD, "caption": "Third."}) + "\n```"])
        w = Worker(make(site, model))
        w.beat()
        self.assertEqual(w.once(), 3)
        self.assertEqual(w.once(), 0)
        posted = site.posted
        self.assertEqual([p["itemId"][:8] for p in posted], ["00000001", "00000002", "00000003"])
        self.assertEqual(posted[0]["data"]["caption"], "A blue wall.")
        self.assertEqual(posted[0]["model"], {"name": "test-vision", "version": "abcdef012345"})
        # the second item got two unusable answers: it is reported as failed with a reason, and the batch went on
        self.assertNotIn("data", posted[1])
        self.assertIn("not on the list", posted[1]["error"])
        self.assertEqual(posted[2]["data"]["caption"], "Third.")
        asked = [c[2] for c in model.calls("/v1/chat/completions")]
        self.assertEqual(len(asked), 4, "one retry, for the one bad answer")
        # what the model was sent: the picture first as a JPEG, the list of scenes, and a schema for the answer
        first = asked[0]
        self.assertEqual([p["type"] for p in first["messages"][0]["content"]], ["image_url", "text"])
        jpeg = base64.b64decode(first["messages"][0]["content"][0]["image_url"]["url"].split(",", 1)[1])
        self.assertEqual(Image.open(io.BytesIO(jpeg)).size, (800, 400))
        self.assertEqual(first["response_format"]["json_schema"]["schema"]["properties"]["scene"]["enum"], SCENES)
        self.assertEqual((first["temperature"], first["max_tokens"]), (0, 700))
        self.assertIn("a photograph", first["messages"][0]["content"][1]["text"])
        self.assertIn("a frame taken from a video", asked[1]["messages"][0]["content"][1]["text"])
        self.assertIn("could not be used", asked[2]["messages"][0]["content"][1]["text"])
        # only the 1600 px copy was fetched, once per item
        self.assertEqual([c[1] for c in site.calls("/api/worker/files")], ["/api/worker/files/1/display", "/api/worker/files/2/display", "/api/worker/files/3/display"])

    def run_for(self, w, rounds):
        waits = []

        def sleep(s):
            waits.append(s)
            if len(waits) >= rounds:
                w.stop.set()

        w.sleep = sleep
        w.run()
        return waits

    def test_waits_longer_and_longer_when_the_site_is_away_and_never_spins(self):
        site, model = FakeSite([item(1)]), FakeModel([GOOD])
        site.down = True
        w = Worker(make(site, model))
        waits = self.run_for(w, 5)
        self.assertEqual(site.posted, [])
        self.assertTrue(all(b > a * 1.2 for a, b in zip(waits, waits[1:])), waits)
        self.assertGreaterEqual(waits[0], 4)
        # back again: it carries on by itself
        site.down = False
        w.stop.clear()
        self.run_for(w, 1)
        self.assertEqual(len(site.posted), 1)

    def test_does_not_take_work_while_the_model_server_is_away(self):
        site, model = FakeSite([item(1)]), FakeModel([GOOD])
        model.down = True
        w = Worker(make(site, model))
        waits = self.run_for(w, 3)
        self.assertEqual(site.calls("/api/worker/claim"), [], "nothing was claimed, so nothing counts as a failed try")
        self.assertEqual(len(waits), 3)
        self.assertGreater(waits[1], waits[0])

    def test_gives_back_what_it_holds_when_the_model_server_dies_mid_batch(self):
        site, model = FakeSite([item(1), item(2), item(3)]), FakeModel([GOOD, (500, {"error": "out of memory"})])
        w = Worker(make(site, model))
        self.run_for(w, 1)
        self.assertEqual(len(site.posted), 1)
        self.assertEqual(sorted(site.released), [item(2)["id"], item(3)["id"]])

    def test_a_refused_token_waits_five_minutes_between_tries(self):
        site, model = FakeSite([item(1)]), FakeModel([GOOD])
        w = Worker(make(site, model, token="aiw_revoked"))
        self.assertEqual(self.run_for(w, 2), [300, 300])

    def test_works_only_inside_its_hours_and_respects_a_pause(self):
        site, model = FakeSite([item(1)]), FakeModel([GOOD])
        now = dt.datetime.now()
        later = f"{(now + dt.timedelta(hours=2)).strftime('%H:%M')}-{(now + dt.timedelta(hours=3)).strftime('%H:%M')}"
        w = Worker(make(site, model, hours=later))
        self.assertEqual(self.run_for(w, 2), [60, 60])
        self.assertEqual(site.calls("/api/worker/claim"), [])
        site.paused = True
        w2 = Worker(make(site, model))
        self.run_for(w2, 1)
        self.assertEqual(site.posted, [])
        self.assertIn("Paused", w2.doing)

    def test_backoff_doubles_to_five_minutes(self):
        b = Backoff()
        seq = [b.next() for _ in range(9)]
        self.assertTrue(4 <= seq[0] <= 6 and 240 <= seq[-1] <= 360, seq)
        b.reset()
        self.assertLessEqual(b.next(), 6)


class SiteTest(unittest.TestCase):
    def test_a_signed_link_is_fetched_without_the_token(self):
        site, bucket = FakeSite([]), Fake(lambda *a: (200, b"picture bytes"))
        s = Site(site.url, "aiw_good")
        self.assertEqual(s.fetch(bucket.url + "/bucket/display/1.webp?X-Amz-Signature=abc"), b"picture bytes")
        self.assertNotIn("authorization", {k.lower() for k in bucket.seen[0][3]})
        s.fetch("/api/worker/files/1/display")
        self.assertEqual(site.seen[0][3].get("authorization") or site.seen[0][3].get("Authorization"), "Bearer aiw_good")

    def test_tells_a_refusal_from_an_outage(self):
        site = FakeSite([])
        with self.assertRaises(Refused) as e:
            Site(site.url, "aiw_bad").heartbeat({})
        self.assertEqual(e.exception.status, 401)
        self.assertIn("revoked", str(e.exception))
        site.down = True
        with self.assertRaises(SiteDown):
            Site(site.url, "aiw_good").heartbeat({})
        with self.assertRaises(SiteDown):
            Site("http://127.0.0.1:9", "aiw_good", timeout=2).heartbeat({})

    def test_a_model_server_that_is_away_is_not_a_bad_picture(self):
        with self.assertRaises(ModelDown):
            VisionModel("http://127.0.0.1:9/v1", "m", timeout=2).ready()


try:
    import numpy as np
except ImportError:  # the worker runs captions without numpy. These parts need the gpu or cpu extra.
    np = None


@unittest.skipIf(np is None, "numpy is not installed")
class FaceMathTest(unittest.TestCase):
    def test_a_face_found_twice_is_kept_once_the_surer_one(self):
        from afterimage_worker.faces import iou, keep_best
        a, b, c = {"box": [10, 10, 100, 100], "score": 0.7}, {"box": [14, 12, 100, 100], "score": 0.9}, {"box": [400, 10, 80, 80], "score": 0.6}
        self.assertGreater(iou(a["box"], b["box"]), 0.8)
        self.assertEqual(iou(a["box"], c["box"]), 0)
        self.assertEqual(keep_best([a, b, c]), [b, c])

    def test_a_face_found_whole_and_again_in_part_is_kept_once(self):
        from afterimage_worker.faces import inside, iou, keep_best
        whole, part, other = {"box": [100, 100, 200, 260], "score": 0.9}, {"box": [110, 120, 80, 200], "score": 0.8}, {"box": [500, 100, 200, 260], "score": 0.7}
        self.assertLess(iou(whole["box"], part["box"]), 0.4)   # too little shared for the old rule
        self.assertGreater(inside(whole["box"], part["box"]), 0.9)
        self.assertEqual(keep_best([part, whole, other]), [whole, other])

    def test_the_five_points_of_a_face_are_laid_on_the_template(self):
        from afterimage_worker.faces import TEMPLATE, similarity
        # a face twice the size, turned a little and moved: the transform brings its points back to the template
        t = np.asarray(TEMPLATE)
        ang = 0.3
        rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
        src = (t @ rot.T) * 2.0 + np.array([300.0, 120.0])
        m = similarity(np, src, TEMPLATE)
        back = (np.c_[src, np.ones(5)] @ m.T)[:, :2]
        self.assertLess(float(np.abs(back - t).max()), 1e-6)

    def test_a_blurred_face_scores_far_below_a_sharp_one(self):
        from afterimage_worker.faces import sharpness
        rng = np.random.default_rng(1)
        sharp = rng.integers(0, 255, (112, 112)).astype(np.float32)
        flat = np.full((112, 112), 120, dtype=np.float32) + np.linspace(0, 20, 112, dtype=np.float32)
        self.assertGreater(sharpness(np, sharp), 1000)
        self.assertLess(sharpness(np, flat), 1)

    def test_an_embedding_is_sent_as_base64_of_32_bit_numbers_with_length_one(self):
        from afterimage_worker.embed import Embedder

        class Sess:
            def run(self, outs, feed):
                x = next(iter(feed.values()))
                assert x.shape == (1, 3, 224, 224) and x.dtype == np.float32 and -1.001 <= x.min() and x.max() <= 1.001
                return [np.array([[3.0, 4.0] + [0.0] * 14], dtype=np.float32)]

        e = Embedder.__new__(Embedder)
        e.np, e.size, e.resample, e.scale = np, (224, 224), Image.BILINEAR, 1 / 255
        e.mean, e.std = np.array([0.5] * 3, dtype=np.float32), np.array([0.5] * 3, dtype=np.float32)
        e.sess, e.input, e.output = Sess(), "pixel_values", "pooler_output"
        out = e.read(picture(1000, 400))
        v = np.frombuffer(base64.b64decode(out["vector"]), dtype="<f4")
        self.assertEqual(out["dim"], 16)
        self.assertTrue(np.allclose(v[:2], [0.6, 0.8]))


if __name__ == "__main__":
    unittest.main()
