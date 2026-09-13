#!/usr/bin/env python3
"""API-only proxy from ngrok/LAN to ESP8266 aircon boards. No static UI."""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8080"))
UPSTREAM_TIMEOUT = float(os.environ.get("AIRCON_UPSTREAM_TIMEOUT", "10"))
# Transient ESP/WiFi blips: try again before 502 (total attempts).
UPSTREAM_ATTEMPTS = max(1, int(os.environ.get("AIRCON_UPSTREAM_ATTEMPTS", "2")))
UPSTREAM_RETRY_DELAY = float(os.environ.get("AIRCON_UPSTREAM_RETRY_DELAY", "0.4"))
TOKEN = os.environ.get("AIRCON_TOKEN", "").strip()
DNS_TTL_SEC = float(os.environ.get("AIRCON_DNS_TTL", str(7 * 24 * 3600)))

# Comma-separated origins, or * (default allows GitHub Pages + local dev)
_CORS_RAW = os.environ.get(
    "AIRCON_CORS_ORIGINS",
    "https://francojreyes.github.io,http://localhost:5500,http://127.0.0.1:5500,http://localhost:8080,http://127.0.0.1:8080",
)
CORS_ORIGINS = {o.strip() for o in _CORS_RAW.split(",") if o.strip()}

API_RE = re.compile(r"^/api/([a-zA-Z0-9_-]+)/(get|set)$")
_dns_cache: dict[str, tuple[str, float]] = {}


def load_rooms() -> dict[str, dict]:
    with (ROOT / "rooms.json").open(encoding="utf-8") as f:
        rooms = json.load(f)
    return {room["id"]: room for room in rooms}


ROOMS = load_rooms()


def resolve_host(hostname: str) -> str:
    now = time.time()
    cached = _dns_cache.get(hostname)
    if cached and cached[1] > now:
        return cached[0]

    infos = socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_STREAM)
    ip = infos[0][4][0]
    _dns_cache[hostname] = (ip, now + DNS_TTL_SEC)
    print(f"DNS cached {hostname} -> {ip} (ttl {DNS_TTL_SEC:.0f}s)")
    return ip


def upstream_url(host_base: str, path: str, query: str = "") -> str:
    parsed = urlparse(host_base if "://" in host_base else f"http://{host_base}")
    hostname = parsed.hostname or ""
    if not hostname:
        raise ValueError(f"Bad host: {host_base}")

    try:
        socket.inet_aton(hostname)
        ip = hostname
    except OSError:
        ip = resolve_host(hostname)

    netloc = f"{ip}:{parsed.port}" if parsed.port else ip
    return urlunparse((parsed.scheme or "http", netloc, path, "", query, ""))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors_origin(self) -> str | None:
        origin = self.headers.get("Origin", "")
        if not origin:
            return None
        if "*" in CORS_ORIGINS or origin in CORS_ORIGINS:
            return origin
        # Allow any github.io pages user for this project pattern
        if origin.endswith(".github.io") or origin == "https://francojreyes.github.io":
            return origin
        return None

    def _send_cors(self) -> None:
        allowed = self._cors_origin()
        if allowed:
            self.send_header("Access-Control-Allow-Origin", allowed)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, ngrok-skip-browser-warning",
        )

    def _authorized(self) -> bool:
        if not TOKEN:
            return True

        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer ") and auth[7:].strip() == TOKEN:
            return True

        query = parse_qs(urlparse(self.path).query)
        if query.get("token", [None])[0] == TOKEN:
            return True

        return False

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _proxy(self, room_id: str, action: str) -> None:
        room = ROOMS.get(room_id)
        if room is None:
            self._send_json(404, {"error": f"Unknown room: {room_id}"})
            return

        parsed = urlparse(self.path)
        query = ""
        if action == "set" and parsed.query:
            qs = parse_qs(parsed.query, keep_blank_values=True)
            qs.pop("token", None)
            flat = [(key, value) for key, values in qs.items() for value in values]
            if flat:
                query = urlencode(flat)

        last_err: Exception | None = None
        for attempt in range(1, UPSTREAM_ATTEMPTS + 1):
            try:
                upstream = upstream_url(room["host"].rstrip("/"), f"/{action}", query)
            except OSError as err:
                self._send_json(502, {"error": f"DNS failed for {room['host']}: {err}"})
                return
            except ValueError as err:
                self._send_json(500, {"error": str(err)})
                return

            try:
                req = Request(upstream, method="GET")
                with urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                    data = resp.read()
                    content_type = resp.headers.get("Content-Type", "application/json")
                    self.send_response(resp.status)
                    self._send_cors()
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(data)
                if attempt > 1:
                    print(f"upstream {room_id}/{action} ok on retry {attempt}")
                return
            except HTTPError as err:
                body = err.read() if err.fp else b""
                self.send_response(err.code)
                self._send_cors()
                self.send_header(
                    "Content-Type", err.headers.get("Content-Type", "text/plain")
                )
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            except URLError as err:
                last_err = err
                print(
                    f"upstream {room_id}/{action} attempt {attempt}/{UPSTREAM_ATTEMPTS} "
                    f"unreachable: {err.reason}"
                )
            except TimeoutError as err:
                last_err = err
                print(
                    f"upstream {room_id}/{action} attempt {attempt}/{UPSTREAM_ATTEMPTS} "
                    f"timed out"
                )
            except Exception as err:  # noqa: BLE001
                self._send_json(502, {"error": str(err)})
                return

            if attempt < UPSTREAM_ATTEMPTS:
                time.sleep(UPSTREAM_RETRY_DELAY)

        self._invalidate_dns(room["host"])
        if isinstance(last_err, TimeoutError):
            self._send_json(502, {"error": "Upstream timed out"})
        elif isinstance(last_err, URLError):
            self._send_json(502, {"error": f"Upstream unreachable: {last_err.reason}"})
        else:
            self._send_json(502, {"error": "Upstream failed"})

    @staticmethod
    def _invalidate_dns(host_base: str) -> None:
        host = urlparse(host_base if "://" in host_base else f"http://{host_base}").hostname
        if host and host in _dns_cache:
            _dns_cache.pop(host, None)
            print(f"DNS cache cleared for {host}")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send_empty(204)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path in ("/", "/health"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "aircon-proxy",
                    "rooms": list(ROOMS),
                    "auth": bool(TOKEN),
                },
            )
            return

        if path == "/api/_auth_check":
            if not TOKEN:
                self._send_empty(204)
                return
            if self._authorized():
                self._send_empty(204)
                return
            self.send_response(401)
            self._send_cors()
            self.send_header("WWW-Authenticate", 'Bearer realm="aircon"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        match = API_RE.match(parsed.path)
        if match:
            if not self._authorized():
                self._send_json(401, {"error": "Unauthorized"})
                return
            self._proxy(match.group(1), match.group(2))
            return

        self._send_json(
            404,
            {
                "error": "Not found — this host is the aircon API proxy only (no UI).",
                "hint": "Open the GitHub Pages UI and set ?api= to this ngrok URL.",
            },
        )


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Aircon API proxy at http://localhost:{PORT}")
    print("Static UI is NOT served here — use GitHub Pages or a local static server for web/")
    if TOKEN:
        print("Auth: AIRCON_TOKEN is set (Bearer or ?token=)")
    else:
        print("Auth: AIRCON_TOKEN not set — API is OPEN (set a token before ngrok)")
    print(f"CORS origins: {', '.join(sorted(CORS_ORIGINS))}")
    print(f"Rooms: {', '.join(ROOMS)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down")
        server.server_close()


if __name__ == "__main__":
    main()
