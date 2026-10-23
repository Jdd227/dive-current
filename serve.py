#!/usr/bin/env python3
"""RunTime Dive Current v0.9.8 API and static file server.

No external dependencies. This file deliberately does not invent SSCOFS forecasts:
configure DIVE_CURRENT_SSCOFS_API_URL to an independently functioning vector
service, or those endpoints return HTTP 503 with a clear JSON explanation.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from pathlib import Path
import json
import math
import os
import sys

ROOT = Path(__file__).resolve().parent
HOST = os.environ.get('HOST') or ('0.0.0.0' if os.environ.get('PORT') else '127.0.0.1')
PORT = int(os.environ.get('PORT', '8080'))

DNR_MAP = 'https://gis.dnr.wa.gov/site3/rest/services/Aquatics/AQ_Bathymetry/MapServer'
DNR_DEPTH = 'https://gis.dnr.wa.gov/image/rest/services/Aquatics/WA_bathymetry_CoNED_MLLW/ImageServer'
DNR_HILLSHADE = 'https://gis.dnr.wa.gov/image/rest/services/Aquatics/WA_bathymetry_CoNED_hillshade/ImageServer'
NOAA_DATA = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
NOAA_META = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json'
NOWCOAST = 'https://nowcoast.noaa.gov/geoserver/ows'

# A dedicated service must provide the same JSON schema expected by v0.9.8.
# This is not the NOAA THREDDS service itself: NetCDF must be parsed/subsetted.
SSCOFS_API_URL = os.environ.get('DIVE_CURRENT_SSCOFS_API_URL', '').rstrip('/')
ALLOWED_ORIGINS = {s.strip().rstrip('/') for s in
                   os.environ.get('DIVE_CURRENT_ALLOWED_ORIGINS', '').split(',') if s.strip()}
UA = 'RunTime-DiveCurrent/0.9.8 (+local mapping app)'


def as_json(obj):
    return json.dumps(obj, separators=(',', ':')).encode('utf-8')


def first(q, key, default=None):
    value = q.get(key)
    return value[0] if value else default


def finite_param(q, key):
    try:
        n = float(first(q, key))
        if not math.isfinite(n):
            raise ValueError
        return n
    except (TypeError, ValueError):
        raise ValueError(f'Invalid {key}')


def viewport(q):
    west, south, east, north = (finite_param(q, k) for k in ('west', 'south', 'east', 'north'))
    if not (-125 < west < east < -120 and 45 < south < north < 50):
        raise ValueError('Bounding box must be ordered and within western Washington')
    return west, south, east, north


def upstream(url, timeout=30):
    req = Request(url, headers={
        'User-Agent': UA, 'Accept': '*/*', 'Connection': 'close'
    })
    return urlopen(req, timeout=timeout)


class Handler(SimpleHTTPRequestHandler):
    # Do not chdir to ROOT in a threaded server (process working directory is global).
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stdout.write('[Dive Current] ' + fmt % args + '\n')

    def cors_headers(self):
        origin = self.headers.get('Origin', '').rstrip('/')
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('X-Content-Type-Options', 'nosniff')

    def send_bytes(self, data, content_type='application/json; charset=utf-8', status=200):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.cors_headers()
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_json(self, obj, status=200):
        self.send_bytes(as_json(obj), 'application/json; charset=utf-8', status)

    def fail(self, message, status=502, **extra):
        self.send_json({'error': message, **extra}, status)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Allow', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.cors_headers()
        self.end_headers()

    def proxy(self, url, timeout=30, require_image=False):
        try:
            with upstream(url, timeout) as response:
                ctype = response.headers.get_content_type() or 'application/octet-stream'
                data = response.read(12 * 1024 * 1024 + 1)
                if len(data) > 12 * 1024 * 1024:
                    return self.fail('Upstream response too large', 502)
                if require_image and not ctype.startswith('image/'):
                    return self.fail('DNR returned a non-image response', 502)
                if ctype.startswith('text/') or ctype in ('application/json', 'application/xml'):
                    ctype = f'{ctype}; charset={response.headers.get_content_charset() or "utf-8"}'
                return self.send_bytes(data, ctype, response.status)
        except HTTPError as exc:
            return self.fail(f'Upstream service HTTP {exc.code}', 502)
        except (URLError, TimeoutError, OSError) as exc:
            return self.fail(f'Upstream request failed: {exc}', 502)

    def do_GET(self):
        parsed = urlparse(self.path)
        q = parse_qs(parsed.query, keep_blank_values=True)
        path = parsed.path

        if path == '/api/health':
            return self.send_json({
                'ok': True, 'version': '0.9.8',
                'dnr_bathymetry': True,
                'noaa_tides': True,
                'sscofs': 'configured' if SSCOFS_API_URL else 'unconfigured',
            })

        if path == '/api/dnr/bathy':
            try:
                west, south, east, north = viewport(q)
                width = int(first(q, 'width', '1000'))
                height = int(first(q, 'height', '800'))
                if not (128 <= width <= 3000 and 128 <= height <= 3000):
                    raise ValueError('Image dimensions must be between 128 and 3000 pixels')
                params = {
                    'f': 'image', 'bbox': f'{west},{south},{east},{north}',
                    'bboxSR': '4326', 'imageSR': '4326',
                    'size': f'{width},{height}', 'format': 'png32',
                    'transparent': 'true',
                    'interpolation': 'RSP_BilinearInterpolation',
                }
                return self.proxy(f'{DNR_HILLSHADE}/exportImage?{urlencode(params)}', 45, require_image=True)
            except (ValueError, TypeError) as exc:
                return self.fail(str(exc), 400)

        if path == '/api/dnr/contours':
            try:
                layer = int(first(q, 'layer', '4'))
                if layer not in (3, 4):
                    raise ValueError('Contour layer must be 3 or 4')
                west, south, east, north = viewport(q)
                offset = int(first(q, 'offset', '0'))
                if not 0 <= offset <= 20000:
                    raise ValueError('Invalid result offset')
                params = {
                    'where': '1=1',
                    'geometry': f'{west},{south},{east},{north}',
                    'geometryType': 'esriGeometryEnvelope', 'inSR': '4326',
                    'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'CONTOUR',
                    'returnGeometry': 'true', 'outSR': '4326',
                    'resultOffset': str(offset), 'resultRecordCount': '2000',
                    'f': 'geojson',
                }
                return self.proxy(f'{DNR_MAP}/{layer}/query?{urlencode(params)}')
            except (ValueError, TypeError) as exc:
                return self.fail(str(exc), 400)

        if path == '/api/dnr/depth':
            try:
                lat, lng = finite_param(q, 'lat'), finite_param(q, 'lng')
                if not (-125 < lng < -120 and 45 < lat < 50):
                    raise ValueError('Point is outside western Washington')
                params = {
                    'geometry': json.dumps({'x': lng, 'y': lat,
                                            'spatialReference': {'wkid': 4326}}, separators=(',', ':')),
                    'geometryType': 'esriGeometryPoint',
                    'returnFirstValueOnly': 'true',
                    'interpolation': 'RSP_BilinearInterpolation', 'f': 'json',
                }
                with upstream(f'{DNR_DEPTH}/getSamples?{urlencode(params)}') as response:
                    samples = json.loads(response.read().decode('utf-8')).get('samples') or []
                if not samples:
                    return self.fail('No DNR raster sample at that point', 404)
                raw = str(samples[0].get('value', '')).split(',')[0].strip()
                elevation = float(raw)
                if not math.isfinite(elevation) or elevation <= -9990:
                    return self.fail('DNR returned NoData', 404)
                if elevation >= 0:
                    return self.send_json({'elevation_m': elevation, 'depth_ft': None, 'below_mllw': False})
                return self.send_json({
                    'elevation_m': elevation, 'depth_ft': -elevation * 3.280839895,
                    'below_mllw': True, 'datum': 'MLLW', 'source': 'WA DNR CoNED',
                })
            except (ValueError, TypeError) as exc:
                return self.fail(f'Invalid DNR sample: {exc}', 400)
            except (HTTPError, URLError, TimeoutError, OSError, KeyError) as exc:
                return self.fail(f'DNR depth request failed: {exc}', 502)

        if path == '/api/noaa/data':
            allowed = {'application', 'begin_date', 'end_date', 'datum', 'station',
                       'time_zone', 'units', 'format', 'product', 'interval'}
            params = {k: first(q, k) for k in q if k in allowed}
            params['application'] = params.get('application', 'DiveCurrent')
            params['format'] = 'json'
            return self.proxy(f'{NOAA_DATA}?{urlencode(params)}')

        if path == '/api/noaa/stations':
            return self.proxy(f'{NOAA_META}?{urlencode({"type": "tidepredictions", "units": "english"})}')

        if path in ('/api/sscofs/info', '/api/sscofs/grid', '/api/sscofs/point'):
            if not SSCOFS_API_URL:
                return self.fail(
                    'SSCOFS vector service is not included in the uploaded v0.9.2 server. '
                    'Supply the original SSCOFS processor or configure DIVE_CURRENT_SSCOFS_API_URL.',
                    503, available=False,
                )
            return self.proxy(f'{SSCOFS_API_URL}{path}?{urlencode({k: first(q, k) for k in q})}', 60)

        if path == '/api/nowcoast':
            allowed = {'service', 'request', 'version', 'layers', 'styles', 'bbox',
                       'crs', 'srs', 'width', 'height', 'format', 'transparent', 'time'}
            safe = {k: first(q, k) for k in q if k.lower() in allowed}
            return self.proxy(f'{NOWCOAST}?{urlencode(safe)}', 45)

        return super().do_GET()


if __name__ == '__main__':
    print(f'Dive Current 0.9.8  http://localhost:{PORT}')
    print(f'NOAA SSCOFS vectors: {"configured" if SSCOFS_API_URL else "unconfigured (HTTP 503)"}')
    print('Ctrl+C to stop.')
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('\nDive Current stopped.')
