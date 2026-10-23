#!/usr/bin/env python3
"""Reject implausible/placeholder current fields before GitHub Pages deploy."""
from pathlib import Path
from datetime import datetime, timezone
import json
import re
root=Path(__file__).resolve().parents[1]
docs=root/'docs'
for file in ('index.html','dive-current.js','dive-current.css','data/stations.json','data/sscofs/manifest.json'):
    if not (docs/file).is_file():raise RuntimeError(f'Missing static app file: {file}')
html=(docs/'index.html').read_text()
assert 'dive-current.js' in html and 'dive-current.css' in html
js=(docs/'dive-current.js').read_text()
assert "checkLocalDataServer" not in js and "const SSCOFS_MANIFEST='data/sscofs/manifest.json'" in js
manifest=json.loads((docs/'data/sscofs/manifest.json').read_text())
if manifest.get('status')=='ok':
    assert manifest.get('source')=='NOAA SSCOFS'
    assert len(manifest.get('frames',[]))>=3
    generated=manifest.get('generated_at')
    datetime.fromisoformat(generated.replace('Z','+00:00'))
    for f in manifest['frames']:
        path=docs/f['file']
        assert path.resolve().is_relative_to(docs.resolve()) and path.exists()
        payload=json.loads(path.read_text())
        assert payload['source']=='NOAA SSCOFS' and payload['valid_time']==f['valid_time']
        assert len(payload['points'])>=150 and f['points']==len(payload['points'])
        for p in payload['points'][:15]:
            assert len(p)==4 and 46.6<float(p[0])<49.3 and -124.6<float(p[1])<-121.4
else:
    assert manifest.get('status')=='unavailable', 'Unknown manifest status'
print('Static app, data integrity, and forecast-manifest checks passed.')
