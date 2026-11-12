"""A stand-in for Earth Search that serves the recorded fixtures.

It refuses any request that carries platform credentials, because the proxy must strip them.
"""

import http.server
import json
from pathlib import Path

FIXTURES = Path("/fixtures")
ES = "https://earth-search.aws.element84.com/v1"
ITEMS = {
    "/v1/collections/landsat-c2-l2/items/LC08_L2SP_092079_20240601_02_T1": "landsat-item.json",
    "/v1/collections/naip/items/naip-item": "naip-item.json",
    "/v1/collections/sentinel-2-c1-l2a/items/s2-item": "sentinel-2-item.json",
}
THUMBNAIL = "https://usgs-landsat.s3.us-west-2.amazonaws.com/x_thumb_small.jpeg?X-Amz-Signature=fake"


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str = "application/geo+json", headers=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _route(self) -> None:
        if self.headers.get("Authorization") or self.headers.get("Cookie"):
            self._send(400, b'{"error": "credentials reached the upstream"}', "application/json")
            return
        path, _, query = self.path.partition("?")
        if path in ITEMS:
            self._send(200, (FIXTURES / ITEMS[path]).read_bytes())
        elif path == "/v1/search":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            page = json.loads((FIXTURES / "landsat-search.json").read_text())
            # Lets the test check that the method, query and body reached the upstream.
            page["context"] = {"method": self.command, "query": query, "body": body.decode()}
            self._send(200, json.dumps(page).encode())
        elif path.endswith("/thumbnail"):
            self._send(302, b"", "text/plain", {"Location": THUMBNAIL})
        elif path == "/v1/collections":
            body = {"collections": [], "links": [{"rel": "self", "href": f"{ES}/collections"}]}
            self._send(200, json.dumps(body).encode(), "application/json")
        else:
            self._send(404, json.dumps({"code": "NotFound", "description": f"{ES}{path[3:]}"}).encode(), "application/json")

    do_GET = do_POST = do_HEAD = _route

    def log_message(self, *args) -> None:
        pass


http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
