"""Talking to the ImageStoria site. The worker always calls the site. The site never calls the worker."""
from __future__ import annotations

import httpx

from . import __version__


class SiteDown(Exception):
    """The site could not be reached, or answered with a server error. Worth trying again later."""


class Refused(Exception):
    """The site understood and said no: a bad or revoked token, most likely."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Site:
    def __init__(self, base: str, token: str, timeout: float = 60.0, client: httpx.Client | None = None):
        self.base = base.rstrip("/")
        self.auth = {"authorization": f"Bearer {token}", "user-agent": f"afterimage-worker/{__version__}"}
        # A separate client with no token, for signed links that point straight at a bucket.
        self.http = client or httpx.Client(timeout=timeout, follow_redirects=True)

    def _call(self, method: str, path: str, body=None):
        try:
            r = self.http.request(method, self.base + path, json=body, headers=self.auth)
        except httpx.HTTPError as e:
            raise SiteDown(f"{type(e).__name__}: {e}") from e
        if r.status_code >= 500:
            raise SiteDown(f"The site answered {r.status_code}.")
        if r.status_code >= 400:
            try:
                msg = r.json().get("error", r.text)
            except ValueError:
                msg = r.text[:200]
            raise Refused(r.status_code, msg)
        return r.json()

    def claim(self, tasks, want: int) -> dict:
        return self._call("POST", "/api/worker/claim", {"tasks": list(tasks), "want": want})

    def results(self, results: list) -> dict:
        return self._call("POST", "/api/worker/results", {"results": results})

    def heartbeat(self, info: dict) -> dict:
        return self._call("POST", "/api/worker/heartbeat", info)

    def release(self, item_ids: list) -> dict:
        return self._call("POST", "/api/worker/release", {"itemIds": list(item_ids)})

    def fetch(self, link: str) -> bytes:
        """A file of a claimed item. A link that starts with / is on the site and needs the token.
        Any other link is a signed link to a bucket, and the token is not sent to it."""
        on_site = link.startswith("/")
        try:
            r = self.http.get(self.base + link if on_site else link, headers=self.auth if on_site else {})
        except httpx.HTTPError as e:
            raise SiteDown(f"{type(e).__name__}: {e}") from e
        if r.status_code >= 500:
            raise SiteDown(f"The file server answered {r.status_code}.")
        if r.status_code >= 400:
            raise Refused(r.status_code, f"The file was refused ({r.status_code}).")
        return r.content
