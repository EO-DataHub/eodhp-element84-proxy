"""Requests through the running proxy (docker-compose.yml) and checks the responses."""

import http.client
import json
import sys

MOUNT = "/api/catalogue/stac/catalogs/public/catalogs/element84"
PUBLIC = "https://hub.example" + MOUNT
OBJECTS = "https://hub.example/api/data/objects/usgs-landsat/"
failures = []


def request(method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", 18000, timeout=10)
    conn.request(method, path, body=body, headers=headers or {})
    response = conn.getresponse()
    data = response.read().decode()
    conn.close()
    return response, data


def check(name, condition, detail=""):
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f": {detail}"))
    if not condition:
        failures.append(name)


creds = {"Authorization": "Bearer secret", "Cookie": "session=secret"}

r, body = request("GET", f"{MOUNT}/collections/landsat-c2-l2/items/LC08_L2SP_092079_20240601_02_T1", headers=creds)
check("Landsat item: 200", r.status == 200, f"{r.status} {body[:200]}")
check("Landsat item: GeoJSON content type", r.getheader("Content-Type") == "application/geo+json", r.getheader("Content-Type"))
item = json.loads(body) if r.status == 200 else {}
hrefs = [a["href"] for a in item.get("assets", {}).values()]
check("Landsat item: assets point at data-objects", hrefs and all(h.startswith(OBJECTS) for h in hrefs), hrefs[:2])
check("Landsat item: no Earth Search URLs", "earth-search.aws.element84.com" not in body)
self_link = next((l["href"] for l in item.get("links", []) if l["rel"] == "self"), "")
check("Landsat item: self link is the mount point", self_link.startswith(PUBLIC + "/collections/"), self_link)

r, body = request("GET", f"{MOUNT}/collections/naip/items/naip-item")
naip = json.loads(body)
check("NAIP item: assets unchanged", all(a["href"].startswith("s3://naip-") for a in naip["assets"].values()))

r, body = request("GET", f"{MOUNT}/search?collections=landsat-c2-l2&limit=2")
page = json.loads(body)
check("GET search: query reaches the upstream", page["context"]["query"] == "collections=landsat-c2-l2&limit=2", page["context"])
check("GET search: items rewritten", all(f["assets"]["red"]["href"].startswith(OBJECTS) for f in page["features"]))

search = json.dumps({"collections": ["landsat-c2-l2"], "limit": 2})
r, body = request("POST", f"{MOUNT}/search", search, {"Content-Type": "application/json", **creds})
page = json.loads(body)
check("POST search: method and body reach the upstream", page["context"]["method"] == "POST" and page["context"]["body"] == search, page.get("context"))
check("POST search: items rewritten", all(f["assets"]["red"]["href"].startswith(OBJECTS) for f in page["features"]))

r, body = request("GET", f"{MOUNT}/collections/landsat-c2-l2/items/LC08_L2SP_092079_20240601_02_T1/thumbnail")
check("thumbnail endpoint: Element 84's redirect passes through", r.status == 302 and r.getheader("Location", "").startswith("https://usgs-landsat.s3."), f"{r.status} {r.getheader('Location')}")

r, body = request("GET", f"{MOUNT}/collections")
check("other paths: URLs rewritten by sub_filter", PUBLIC + "/collections" in body and "earth-search" not in body, body[:200])

r, body = request("GET", f"{MOUNT}/collections/landsat-c2-l2/items/missing")
check("upstream 404 passes through", r.status == 404 and PUBLIC in body, f"{r.status} {body[:200]}")

r, body = request("GET", "/healthz")
check("healthz", r.status == 200)

r, body = request("GET", f"/_upstream{MOUNT}/collections")
check("internal location is not reachable", r.status == 404, r.status)

print(f"{len(failures)} failed")
sys.exit(1 if failures else 0)
