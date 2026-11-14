"""Reading a picture with a vision model behind a local OpenAI-compatible endpoint
(Ollama, the llama.cpp server, vLLM). Changing models is a line in the config file."""
from __future__ import annotations

import base64
import io
import json
import re

import httpx
from PIL import Image, ImageOps

MAX_OBJECTS = 12


class ModelDown(Exception):
    """The model server could not be reached. Nothing is wrong with the picture."""


class BadAnswer(Exception):
    """The model answered, but not with what was asked for."""


def to_jpeg(data: bytes, max_edge: int) -> tuple[bytes, tuple[int, int]]:
    """Any picture the site hands out, as a JPEG no larger than max_edge on its long side. Never cropped."""
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    im = im.convert("RGB")
    if max(im.size) > max_edge:
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=90)
    return out.getvalue(), im.size


def caption_schema(scenes: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": {"type": "string"},
            "scene": {"type": "string", "enum": list(scenes)},
            "objects": {
                "type": "array",
                "maxItems": MAX_OBJECTS,
                "items": {
                    "type": "object",
                    "properties": {"label": {"type": "string"}, "confidence": {"type": "number"}},
                    "required": ["label", "confidence"],
                },
            },
            "text": {"type": "string"},
        },
        "required": ["caption", "scene", "objects", "text"],
    }


def caption_prompt(scenes: list[str], kind: str = "photo") -> str:
    what = "a frame taken from a video" if kind == "video" else "a photograph"
    return (
        f"This is {what} from a private archive. Describe it by filling in this JSON object.\n"
        '- "caption": one or two plain sentences saying what it shows. Say only what can be seen. '
        "Do not name people and do not guess where it is.\n"
        f'- "scene": the one best match from this list: {", ".join(scenes)}.\n'
        f'- "objects": up to {MAX_OBJECTS} things that are clearly visible, the most prominent first. Each has a "label" '
        '(one or two lower-case words, singular) and a "confidence" from 0 to 1.\n'
        '- "text": the words that can be read in the picture, on one line, at most 300 characters. An empty string if there are none.\n'
        "Answer with the JSON object only."
    )


PLACE_SCHEMA = {
    "type": "object",
    "properties": {
        "place": {"type": "string"},
        "kind": {"type": "string", "enum": ["landmark", "beach", "park", "neighborhood", "town", "region", "unknown"]},
        "confidence": {"type": "number"},
        "why": {"type": "string"},
    },
    "required": ["place", "kind", "confidence", "why"],
}
PLACE_PROMPT = (
    "This photograph has no location recorded. If something in it shows where it was taken (a landmark, a sign, "
    "a skyline, a well-known beach or building), name the place. Fill in this JSON object.\n"
    '- "place": the place as a person would write it, such as "Eiffel Tower, Paris, France". '
    "An empty string if nothing in the picture tells you.\n"
    '- "kind": landmark, beach, park, neighborhood, town, region, or unknown.\n'
    '- "confidence": from 0 to 1. Be strict: an ordinary beach, street, room or forest could be anywhere, '
    "and must get an empty place and a confidence of 0.\n"
    '- "why": a few words on what in the picture told you.\n'
    "Answer with the JSON object only."
)


def _parse(text: str) -> dict:
    """The JSON object in a model's answer. Some models wrap it in a code fence or think out loud first."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.S)
    if m:
        text = m.group(1)
    if not text.startswith("{"):
        a, b = text.find("{"), text.rfind("}")
        if a < 0 or b <= a:
            raise BadAnswer("The model gave no JSON.")
        text = text[a : b + 1]
    try:
        d = json.loads(text)
    except ValueError:
        try:
            d = json.loads(_mend(text))
        except ValueError as e:
            raise BadAnswer(f"The model gave JSON that does not parse: {e}") from e
    if not isinstance(d, dict):
        raise BadAnswer("The model gave JSON that is not an object.")
    return d


def _mend(text: str) -> str:
    """Close a JSON object that was cut off, which happens when a model runs to its length limit inside a long string.
    What was complete before the cut is kept. The result may still not parse, and then the answer counts as bad."""
    stack, in_str, esc = [], False, False
    for ch in text:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]" and stack:
            stack.pop()
    if not stack:
        return text
    out = text
    if in_str:
        if esc:
            out = out[:-1]
        out = re.sub(r"(\\[nrt]|\s)+$", "", out) + '"'
    else:
        out = re.sub(r"[\s,:]+$", "", out)
    return out + "".join(reversed(stack))


def check_caption(d: dict, scenes: list[str]) -> dict:
    """Make sure an answer is in the agreed shape, and tidy it. Raises BadAnswer when it is not."""
    cap = d.get("caption")
    if not isinstance(cap, str) or not cap.strip():
        raise BadAnswer("The answer has no caption.")
    scene = str(d.get("scene") or "").strip().lower()
    if scene not in scenes:
        raise BadAnswer(f'The scene "{scene[:40]}" is not on the list.')
    objs = d.get("objects")
    if not isinstance(objs, list):
        raise BadAnswer("The objects are not a list.")
    out, seen = [], set()
    for o in objs:
        if not isinstance(o, dict):
            raise BadAnswer("An object is not in the agreed shape.")
        label = " ".join(str(o.get("label") or "").lower().split())[:60]
        try:
            conf = float(o.get("confidence"))
        except (TypeError, ValueError) as e:
            raise BadAnswer("An object has no confidence.") from e
        if conf > 1 and conf <= 100:
            conf /= 100  # some models answer in percent
        if not label or label in seen or not 0 <= conf <= 1:
            continue
        seen.add(label)
        out.append({"label": label, "confidence": round(conf, 3)})
    text = d.get("text")
    text = " ".join(text.split())[:4000] if isinstance(text, str) else ""
    if text.lower() in ("none", "n/a", "no text", "null"):
        text = ""
    return {"caption": " ".join(cap.split())[:2000], "scene": scene, "objects": out[:MAX_OBJECTS], "text": text}


def check_place(d: dict) -> dict:
    place = d.get("place")
    place = " ".join(place.split())[:200] if isinstance(place, str) else ""
    try:
        conf = float(d.get("confidence") or 0)
    except (TypeError, ValueError) as e:
        raise BadAnswer("The place has no confidence.") from e
    if conf > 1 and conf <= 100:
        conf /= 100
    if not 0 <= conf <= 1:
        raise BadAnswer("The confidence is not between 0 and 1.")
    if place.lower() in ("unknown", "none", "n/a", "not sure", "unclear"):
        place = ""
    kind = str(d.get("kind") or "unknown").lower()
    why = d.get("why")
    return {"place": place, "kind": kind if kind in PLACE_SCHEMA["properties"]["kind"]["enum"] else "unknown",
            "confidence": round(conf if place else 0.0, 3), "why": " ".join(why.split())[:300] if isinstance(why, str) else ""}


class VisionModel:
    def __init__(self, endpoint: str, model: str, api_key: str = "", timeout: float = 180.0, extra: dict | None = None,
                 max_edge: int = 1024, client: httpx.Client | None = None, max_tokens: int = 700):
        self.max_tokens = max_tokens
        self.endpoint = endpoint.rstrip("/")
        self.model = model
        self.max_edge = max_edge
        self.extra = extra or {}
        self.headers = {"authorization": f"Bearer {api_key}"} if api_key else {}
        self.http = client or httpx.Client(timeout=timeout)
        self._version: str | None = None

    def ready(self) -> None:
        """Raises ModelDown unless the model server answers."""
        try:
            r = self.http.get(self.endpoint + "/models", headers=self.headers, timeout=10)
        except httpx.HTTPError as e:
            raise ModelDown(f"The model server at {self.endpoint} does not answer ({type(e).__name__}).") from e
        if r.status_code >= 400:
            raise ModelDown(f"The model server at {self.endpoint} answered {r.status_code}.")

    def version(self) -> str:
        """Something that changes when the model's weights change. Ollama gives a digest. Others give nothing, and that is fine."""
        if self._version is None:
            self._version = ""
            try:
                root = re.sub(r"/v1$", "", self.endpoint)
                r = self.http.get(root + "/api/tags", timeout=10)
                for m in r.json().get("models", []):
                    if m.get("name") == self.model or m.get("model") == self.model:
                        self._version = str(m.get("digest", ""))[:12]
            except (httpx.HTTPError, ValueError, AttributeError):
                pass
        return self._version

    def ask(self, jpeg: bytes, prompt: str, schema: dict, name: str) -> dict:
        body = {
            "model": self.model,
            "temperature": 0,
            # A model that starts repeating itself is stopped here instead of running to the end of its memory.
            "max_tokens": self.max_tokens,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "response_format": {"type": "json_schema", "json_schema": {"name": name, "schema": schema}},
            **self.extra,
        }
        try:
            r = self.http.post(self.endpoint + "/chat/completions", json=body, headers=self.headers)
        except httpx.TimeoutException as e:
            raise BadAnswer("The model took too long to answer.") from e
        except httpx.HTTPError as e:
            raise ModelDown(f"The model server at {self.endpoint} does not answer ({type(e).__name__}).") from e
        if r.status_code >= 500 or r.status_code == 404:
            raise ModelDown(f"The model server answered {r.status_code}: {r.text[:200]}")
        if r.status_code >= 400:
            raise BadAnswer(f"The model server refused the request ({r.status_code}): {r.text[:200]}")
        try:
            msg = r.json()["choices"][0]["message"]
        except (ValueError, KeyError, IndexError) as e:
            raise BadAnswer("The model server gave an answer in a shape this worker does not know.") from e
        return _parse(msg.get("content") or "")

    def _twice(self, jpeg: bytes, prompt: str, schema: dict, name: str, check):
        """Ask, check the answer, and ask once more when the first answer is not usable."""
        try:
            return check(self.ask(jpeg, prompt, schema, name))
        except BadAnswer as first:
            again = prompt + f"\nYour last answer could not be used: {first} Answer again with the JSON object only."
            return check(self.ask(jpeg, again, schema, name))

    def caption(self, picture: bytes, scenes: list[str], kind: str = "photo") -> dict:
        jpeg, _ = to_jpeg(picture, self.max_edge)
        return self._twice(jpeg, caption_prompt(scenes, kind), caption_schema(scenes), "picture", lambda d: check_caption(d, scenes))

    def place(self, picture: bytes) -> dict:
        jpeg, _ = to_jpeg(picture, self.max_edge)
        return self._twice(jpeg, PLACE_PROMPT, PLACE_SCHEMA, "place", check_place)
