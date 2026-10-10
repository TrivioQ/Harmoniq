# Copyright The Harmoniq Authors
# SPDX-License-Identifier: Apache-2.0

"""HTTP core of the Harmoniq client: authentication, JSON and errors (standard library only)."""

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional


def quote_segment(value: str) -> str:
    """Escapes one path segment (slashes included)."""
    return urllib.parse.quote(str(value), safe="")


@dataclass
class Response:
    """A successful (2xx) response."""

    status: int
    headers: Mapping[str, str]
    body: bytes = field(repr=False)

    def json(self) -> Any:
        return json.loads(self.body) if self.body else None


class HarmoniqError(Exception):
    """A non-2xx response, e.g. 423 LOCKED for a frozen environment."""

    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(f"HTTP {status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class BaseClient:
    """Calls a Harmoniq registry with an API key (``hq_…`` or ``hq_org_…``)."""

    def __init__(self, base_url: str, api_key: Optional[str] = None, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
    ) -> Response:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query, doseq=True)
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", "harmoniq-python")
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return Response(res.status, dict(res.headers), res.read())
        except urllib.error.HTTPError as err:
            payload = err.read()
            code, message, details = "", err.reason, None
            try:
                envelope = json.loads(payload)["error"]
                code, message = envelope.get("code", ""), envelope.get("message", message)
                details = envelope.get("details")
            except (ValueError, KeyError, TypeError):
                pass
            raise HarmoniqError(err.code, code, message, details) from None
