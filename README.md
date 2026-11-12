# eodhp-element84-proxy

An nginx proxy that serves [Element 84 Earth Search](https://earth-search.aws.element84.com/v1) under the EO DataHub's public catalogue, at `/api/catalogue/stac/catalogs/public/catalogs/element84`.

The proxy makes two changes to Earth Search's responses:

- Earth Search's own URLs become the platform's mount point, so clients follow links, pages and redirects through the Hub.
- Assets stored in requester-pays buckets that the Hub pays for point at the Hub's data-objects endpoint instead of at S3. The endpoint signs each read and charges it to the reading workspace. See [ADR-003: URL contract for requester-pays data access](https://github.com/EO-DataHub/eodhp-guide/blob/main/docs/explanation/design-decisions/requester-pays-url-contract-adr.md) and [eodhp-data-objects](https://github.com/EO-DataHub/eodhp-data-objects).

The first such bucket is `usgs-landsat`, which holds Landsat Collection 2.

## What changes in an item

For each asset whose href is `s3://<bucket>/<key>`, with `<bucket>` in `REWRITE_BUCKETS`:

| Field | Before | After |
|---|---|---|
| `href` | `s3://usgs-landsat/<key>` | `<PLATFORM_URL>/api/data/objects/usgs-landsat/<key>` |
| `storage:platform`, `storage:region`, `storage:requester_pays` | on the asset | removed from the asset |
| `alternate.s3` | not present | the original `href` and `storage:*` fields |

The item also changes:

- `stac_extensions` lists the [alternate-assets](https://github.com/stac-extensions/alternate-assets) extension.
- The `thumbnail` link points at the rewritten `thumbnail` asset. The data-objects endpoint serves preview images without a login (ADR-003, decision 6). Earth Search's own link redirects to a preview that Element 84 signs and pays for, and the Hub does not depend on it.

Assets in other buckets do not change. Earth Search also serves requester-pays buckets that the Hub does not pay for, such as NAIP's, and their items keep their S3 links.

The rewrite applies to item, item collection and search responses (`/collections/{id}/items`, `/collections/{id}/items/{item}` and `/search`, with `GET` or `POST`). [`njs/stac.js`](njs/stac.js) parses each response, so it can change one asset and leave the others. Every other path is proxied unchanged, apart from the Earth Search URLs, which `sub_filter` replaces.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PLATFORM_URL` | yes | | The platform's public URL, for example `https://test.eodatahub.org.uk` |
| `REWRITE_BUCKETS` | no | `["usgs-landsat"]` | JSON list of the buckets whose assets point at the data-objects endpoint |
| `UPSTREAM_URL` | no | `https://earth-search.aws.element84.com` | Where requests are sent. The integration tests set it to a mock. |

Keep `REWRITE_BUCKETS` in step with two other lists:

- `BUCKETS` in data-objects. If a bucket is rewritten here but not allowlisted there, every asset in it returns `404`.
- `requester_pays_buckets` in eodhp-deploy-supporting-infrastructure. If a bucket is missing there, the data-access trail does not record its reads, and nothing is charged for them.

The proxy listens on port 8000. `/healthz` returns `200` while nginx runs.

A rewritten response is read into memory first, up to the 32 MB set by `subrequest_output_buffer_size`. A Landsat item is about 20 KB, so a page of 250 items is about 5.6 MB. On 2026-11-11, Earth Search itself failed a request for 1000 Landsat items with `502`.

## Development

You need Docker.

```bash
make check              # build the image, then run the unit and integration tests
make test-unit          # njs unit tests only
make test-integration   # the proxy against a mock Earth Search
```

The unit tests in `tests/unit` run under the `njs` CLI in the proxy's own image, so they use the same JavaScript engine as nginx. That engine is njs, not Node: some syntax, such as `for...of`, is not supported.

The integration test in `tests/integration` starts the proxy and a mock upstream with Docker Compose. The mock serves recorded Earth Search responses from `tests/fixtures`, and refuses any request that carries an `Authorization` or `Cookie` header, because the proxy must not forward platform credentials.

To refresh the fixtures, save new responses from Earth Search with the same file names. Keep the Sentinel-2 and NAIP items: they prove that assets in other buckets are not changed.

## Deployment

The image is `public.ecr.aws/eodh/eodhp-element84-proxy`. eodhp-argocd-deployment runs it in `apps/resource-catalogue/base/proxies/element84`, with `PLATFORM_URL` set for each environment.
