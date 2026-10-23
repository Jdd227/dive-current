"""Local HTTP contract tests. Network calls are mocked; no NOAA/DNR availability claims."""
import sys, json, threading, urllib.request, urllib.parse
from pathlib import Path
from http.server import ThreadingHTTPServer
from email.message import Message
from unittest.mock import patch
import importlib.util

app = Path(__file__).resolve().parents[1] / 'app' / 'serve.py'
spec = importlib.util.spec_from_file_location('dc_server', app)
srv = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = srv
spec.loader.exec_module(srv)
srv.ALLOWED_ORIGINS.add('https://current.runtimedivesystems.com')

class Upstream:
    status=200
    def __init__(self, data=b'{}', content_type='application/json'):
        self._data=data; self.headers=Message(); self.headers['Content-Type']=content_type
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, amt=-1): return self._data if amt==-1 else self._data[:amt]

captured=[]
def fake_upstream(url, timeout=30):
    captured.append(url)
    if '/exportImage?' in url:return Upstream(b'\x89PNG\r\n\x1a\n', 'image/png')
    if '/getSamples?' in url:return Upstream(b'{"samples":[{"value":"-27.2"}]}')
    if 'stations.json?' in url:return Upstream(b'{"stations":[]}')
    if 'datagetter?' in url:return Upstream(b'{"predictions":[]}')
    if '/query?' in url:return Upstream(b'{"type":"FeatureCollection","features":[]}')
    return Upstream()

httpd = ThreadingHTTPServer(('127.0.0.1',0), srv.Handler)
thread = threading.Thread(target=httpd.serve_forever,daemon=True)
thread.start()
base=f'http://127.0.0.1:{httpd.server_port}'
def req(url):
    return urllib.request.urlopen(urllib.request.Request(base+url,headers={'Origin':'https://current.runtimedivesystems.com'}),timeout=5)

def ok(name, condition):
    if not condition:raise AssertionError(name)
    print('PASS',name)
try:
  with patch.object(srv,'upstream',side_effect=fake_upstream):
    with req('/api/health') as r:
      d=json.load(r)
      ok('health version',d['ok'] and d['version']=='0.9.8' and d['sscofs']=='unconfigured')
      ok('CORS exact origin',r.headers['Access-Control-Allow-Origin']=='https://current.runtimedivesystems.com')
    with req('/api/dnr/bathy?west=-122.7&south=47.1&east=-122.1&north=47.8&width=1024&height=800') as r:
      ok('DNR bathy returns image bytes',r.read().startswith(b'\x89PNG') and r.headers.get_content_type()=='image/png')
    u=captured[-1]; p=urllib.parse.parse_qs(urllib.parse.urlsplit(u).query)
    ok('hillshade endpoint', 'CoNED_hillshade/ImageServer/exportImage' in u and p['bboxSR']==['4326'] and p['imageSR']==['4326'])
    with req('/api/dnr/contours?west=-122.7&south=47.1&east=-122.1&north=47.8&layer=4') as r:
      ok('contours response',json.load(r)['type']=='FeatureCollection')
    with req('/api/dnr/depth?lat=47.3&lng=-122.5') as r:
      d=json.load(r);ok('depth ft from MLLW',round(d['depth_ft'])==89 and d['datum']=='MLLW')
    with req('/api/noaa/stations') as r:ok('station route',json.load(r)['stations']==[])
    try:req('/api/sscofs/grid?rows=12')
    except urllib.error.HTTPError as e:
      d=json.load(e);ok('missing SSCOFS explicitly 503',e.code==503 and d['available'] is False)
    else:raise AssertionError('Expected SSCOFS 503')
    try:req('/api/dnr/bathy?west=-122.7&south=47.1&east=-122.1&north=47.8&width=99999&height=800')
    except urllib.error.HTTPError as e:
      ok('block excessive image dimension',e.code==400)
    else:raise AssertionError('expected 400')
    try:req('/api/dnr/bathy?west=-122.1&south=47.1&east=-122.7&north=47.8&width=1024&height=800')
    except urllib.error.HTTPError as e:ok('block reversed bounding box',e.code==400)
    else:raise AssertionError('expected 400')
    with req('/dive-current-v0.9.8.js') as r:ok('static JS served',b'Dive Current v0.9.8' in r.read()[:90])
finally:
  httpd.shutdown();httpd.server_close();thread.join(timeout=2)
