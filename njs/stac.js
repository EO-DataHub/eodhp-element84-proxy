// Rewrites Earth Search STAC responses for the EO DataHub.
//
// Two changes are made to each item, item collection and search response:
//
// 1. Earth Search's own URLs become the platform's mount point for this proxy, as the
//    sub_filter in default.conf does for every other response.
// 2. Each asset stored in an allowlisted requester-pays bucket is pointed at the platform's
//    data-objects endpoint (ADR-003 in eodhp-guide), which signs the read and charges the
//    reading workspace. The original S3 location moves to `alternate.s3`, with the asset's
//    `storage:*` fields, so the asset itself describes what a client fetches.
//
// Assets in other buckets are not changed. Earth Search also serves requester-pays buckets
// that the Hub does not pay for, such as NAIP's.

const EARTH_SEARCH_URL = 'https://earth-search.aws.element84.com/v1';
const ALTERNATE_ASSETS = 'https://stac-extensions.github.io/alternate-assets/v1.2.0/schema.json';
const S3_HREF = /^s3:\/\/([^/]+)\/(.+)$/;

// Built once per worker from the environment. See the README for the variables.
let config = null;

function configFromEnv(env) {
    const platformUrl = (env.PLATFORM_URL || '').replace(/\/+$/, '');
    if (!platformUrl) {
        throw new Error('PLATFORM_URL must be set');
    }
    const buckets = JSON.parse(env.REWRITE_BUCKETS || '["usgs-landsat"]');
    if (!Array.isArray(buckets) || !buckets.every((b) => typeof b === 'string' && b)) {
        throw new Error('REWRITE_BUCKETS must be a JSON list of bucket names');
    }
    return {
        publicUrl: platformUrl + '/api/catalogue/stac/catalogs/public/catalogs/element84',
        objectsUrl: platformUrl + '/api/data/objects',
        buckets: buckets,
    };
}

function objectsHref(cfg, bucket, key) {
    return cfg.objectsUrl + '/' + bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
}

function rewriteAsset(asset, cfg) {
    const match = typeof asset.href === 'string' ? asset.href.match(S3_HREF) : null;
    if (!match || cfg.buckets.indexOf(match[1]) === -1) {
        return false;
    }
    const original = { href: asset.href };
    Object.keys(asset).forEach((field) => {
        if (field.startsWith('storage:')) {
            original[field] = asset[field];
            delete asset[field];
        }
    });
    asset.href = objectsHref(cfg, match[1], match[2]);
    asset.alternate = Object.assign({}, asset.alternate, { s3: original });
    return true;
}

function rewriteItem(item, cfg) {
    if (!item || item.type !== 'Feature' || !item.assets) {
        return item;
    }
    let rewritten = false;
    let thumbnail = null;
    Object.keys(item.assets).forEach((name) => {
        const asset = item.assets[name];
        if (rewriteAsset(asset, cfg)) {
            rewritten = true;
            const isThumbnail = name === 'thumbnail' || (asset.roles || []).indexOf('thumbnail') !== -1;
            if (isThumbnail && (thumbnail === null || name === 'thumbnail')) {
                thumbnail = asset;
            }
        }
    });
    if (!rewritten) {
        return item;
    }
    item.stac_extensions = item.stac_extensions || [];
    if (item.stac_extensions.indexOf(ALTERNATE_ASSETS) === -1) {
        item.stac_extensions.push(ALTERNATE_ASSETS);
    }
    // Earth Search's thumbnail link redirects to a preview that Element 84 signs and pays
    // for. Point it at the same preview through the Hub instead (ADR-003, decision 6).
    if (thumbnail !== null) {
        (item.links || []).forEach((link) => {
            if (link.rel === 'thumbnail') {
                link.href = thumbnail.href;
                if (thumbnail.type) {
                    link.type = thumbnail.type;
                }
            }
        });
    }
    return item;
}

function rewriteDocument(doc, cfg) {
    if (doc && doc.type === 'FeatureCollection' && Array.isArray(doc.features)) {
        doc.features.forEach((item) => rewriteItem(item, cfg));
    } else {
        rewriteItem(doc, cfg);
    }
    return doc;
}

// Rewrites a response body. A body that is not JSON only has Earth Search's URLs replaced.
function rewriteBody(body, cfg) {
    const text = body.split(EARTH_SEARCH_URL).join(cfg.publicUrl);
    let doc;
    try {
        doc = JSON.parse(text);
    } catch (e) {
        return text;
    }
    return JSON.stringify(rewriteDocument(doc, cfg));
}

// js_content handler for item, item collection and search requests. It fetches the
// response through the internal /_upstream location, so the request reaches Earth Search
// with the same headers, method and body as the other locations send.
async function handle(r) {
    if (config === null) {
        config = configFromEnv(process.env);
    }
    const reply = await r.subrequest('/_upstream' + r.uri, {
        method: r.method,
        args: r.variables.args || '',
        body: r.requestText,
    });
    const contentType = reply.headersOut['Content-Type'];
    if (contentType) {
        r.headersOut['Content-Type'] = contentType;
    }
    const isJson = /json/.test(contentType || '');
    const body = reply.responseText || '';
    r.return(reply.status, isJson ? rewriteBody(body, config) : body);
}

export default { configFromEnv, rewriteItem, rewriteDocument, rewriteBody, handle };
