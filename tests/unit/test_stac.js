// Unit tests for njs/stac.js. Run with `make test-unit`, which runs them under the njs CLI
// in the same image the proxy runs in.

import fs from 'fs';
import stac from 'stac.js';

const FIXTURES = '/src/tests/fixtures/';
const CFG = stac.configFromEnv({ PLATFORM_URL: 'https://hub.example/' });
const OBJECTS = 'https://hub.example/api/data/objects/usgs-landsat/';
const MOUNT = 'https://hub.example/api/catalogue/stac/catalogs/public/catalogs/element84';
const ALTERNATE = 'https://stac-extensions.github.io/alternate-assets/v1.2.0/schema.json';

let failures = 0;
let count = 0;

function load(name) {
    return fs.readFileSync(FIXTURES + name, 'utf8');
}

function test(name, fn) {
    count += 1;
    try {
        fn();
    } catch (e) {
        failures += 1;
        console.log('FAIL ' + name + ': ' + e.message);
    }
}

function assertEqual(actual, expected, what) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(what + ': expected ' + e + ', got ' + a);
    }
}

function assert(condition, what) {
    if (!condition) {
        throw new Error(what);
    }
}

function rewrite(name) {
    return JSON.parse(stac.rewriteBody(load(name), CFG));
}

// Config

test('PLATFORM_URL is required', () => {
    let error = null;
    try {
        stac.configFromEnv({});
    } catch (e) {
        error = e;
    }
    assert(error && /PLATFORM_URL/.test(error.message), 'no error for a missing PLATFORM_URL');
});

test('the default bucket list is usgs-landsat', () => {
    assertEqual(CFG.buckets, ['usgs-landsat'], 'buckets');
});

test('REWRITE_BUCKETS must be a list of names', () => {
    ['"usgs-landsat"', '[1]', '[""]', 'not json'].forEach((value) => {
        let error = null;
        try {
            stac.configFromEnv({ PLATFORM_URL: 'https://hub.example', REWRITE_BUCKETS: value });
        } catch (e) {
            error = e;
        }
        assert(error !== null, 'accepted REWRITE_BUCKETS=' + value);
    });
});

// Landsat

test('every Landsat asset points at the data-objects endpoint', () => {
    const item = rewrite('landsat-item.json');
    Object.keys(item.assets).forEach((name) => {
        assert(item.assets[name].href.startsWith(OBJECTS), name + ' href is ' + item.assets[name].href);
    });
});

test('the key is kept exactly', () => {
    const before = JSON.parse(load('landsat-item.json')).assets.red.href;
    const after = rewrite('landsat-item.json').assets.red.href;
    assertEqual(after, OBJECTS + before.slice('s3://usgs-landsat/'.length), 'red href');
});

test('the S3 location and storage fields move to alternate.s3', () => {
    const before = JSON.parse(load('landsat-item.json')).assets.red;
    const red = rewrite('landsat-item.json').assets.red;
    assertEqual(
        red.alternate.s3,
        {
            href: before.href,
            'storage:platform': 'AWS',
            'storage:region': 'us-west-2',
            'storage:requester_pays': true,
        },
        'alternate.s3',
    );
    assertEqual(
        Object.keys(red).filter((k) => k.startsWith('storage:')),
        [],
        'storage fields left on the asset',
    );
});

test('other asset fields are kept', () => {
    const before = JSON.parse(load('landsat-item.json')).assets.red;
    const red = rewrite('landsat-item.json').assets.red;
    ['type', 'title', 'roles', 'raster:bands', 'eo:bands'].forEach((field) => {
        assertEqual(red[field], before[field], field);
    });
});

test('the alternate-assets extension is declared once', () => {
    const exts = rewrite('landsat-item.json').stac_extensions;
    assertEqual(exts.filter((e) => e === ALTERNATE).length, 1, 'alternate-assets entries');
    const twice = stac.rewriteDocument(rewrite('landsat-item.json'), CFG);
    assertEqual(twice.stac_extensions.filter((e) => e === ALTERNATE).length, 1, 'after a second rewrite');
});

test('the thumbnail link points at the small preview', () => {
    const item = rewrite('landsat-item.json');
    const link = item.links.filter((l) => l.rel === 'thumbnail')[0];
    assertEqual(link.href, item.assets.thumbnail.href, 'thumbnail link');
    assert(link.href.endsWith('_thumb_small.jpeg'), 'thumbnail link is ' + link.href);
    assertEqual(link.type, 'image/jpeg', 'thumbnail link type');
});

test('the large preview keeps its overview role', () => {
    const browse = rewrite('landsat-item.json').assets.reduced_resolution_browse;
    assert(browse.href.endsWith('_thumb_large.jpeg'), 'browse href is ' + browse.href);
    assertEqual(browse.roles, ['overview'], 'roles');
});

test('Earth Search URLs become the mount point', () => {
    const item = rewrite('landsat-item.json');
    const self = item.links.filter((l) => l.rel === 'self')[0];
    assert(self.href.startsWith(MOUNT + '/collections/landsat-c2-l2/items/'), 'self is ' + self.href);
    assert(JSON.stringify(item).indexOf('earth-search.aws.element84.com') === -1, 'an Earth Search URL is left');
});

test('a search page rewrites every item', () => {
    const page = rewrite('landsat-search.json');
    assert(page.features.length === 2, 'expected 2 features');
    page.features.forEach((item) => {
        Object.keys(item.assets).forEach((name) => {
            const href = item.assets[name].href;
            assert(href.startsWith(OBJECTS), item.id + ' ' + name + ' is ' + href);
        });
    });
});

// Other collections

test('a NAIP item keeps its requester-pays S3 links', () => {
    const before = JSON.parse(load('naip-item.json'));
    const after = rewrite('naip-item.json');
    assertEqual(after.assets, before.assets, 'assets');
    assertEqual(after.stac_extensions, before.stac_extensions, 'stac_extensions');
});

test('a Sentinel-2 item changes only in its Earth Search URLs', () => {
    const raw = load('sentinel-2-item.json');
    const expected = JSON.parse(raw.split('https://earth-search.aws.element84.com/v1').join(MOUNT));
    assertEqual(rewrite('sentinel-2-item.json'), expected, 'item');
});

test('a mixed page changes only the Landsat items', () => {
    const items = ['landsat-item.json', 'naip-item.json', 'sentinel-2-item.json'].map((f) => JSON.parse(load(f)));
    const page = JSON.stringify({ type: 'FeatureCollection', features: items, links: [] });
    const out = JSON.parse(stac.rewriteBody(page, CFG));
    assert(out.features[0].assets.red.href.startsWith(OBJECTS), 'Landsat not rewritten');
    assertEqual(out.features[1].assets, items[1].assets, 'NAIP assets');
    assert(out.features[2].assets.red.href.indexOf('e84-earth-search-sentinel-data') !== -1, 'Sentinel-2 red changed');
});

test('a body that is not JSON is returned with only its URLs replaced', () => {
    const body = 'error at https://earth-search.aws.element84.com/v1/search';
    assertEqual(stac.rewriteBody(body, CFG), 'error at ' + MOUNT + '/search', 'body');
});

test('a key with characters that need escaping is escaped per segment', () => {
    const item = {
        type: 'Feature',
        assets: { a: { href: 's3://usgs-landsat/dir with space/a+b?.tif' } },
        links: [],
    };
    assertEqual(
        stac.rewriteItem(item, CFG).assets.a.href,
        OBJECTS + 'dir%20with%20space/a%2Bb%3F.tif',
        'href',
    );
});

test('an asset whose bucket name only starts with an allowlisted name is not rewritten', () => {
    const item = { type: 'Feature', assets: { a: { href: 's3://usgs-landsat-other/x.tif' } }, links: [] };
    assertEqual(stac.rewriteItem(item, CFG).assets.a.href, 's3://usgs-landsat-other/x.tif', 'href');
});

console.log(count - failures + ' passed, ' + failures + ' failed');
if (failures > 0) {
    throw new Error(failures + ' test(s) failed');
}
