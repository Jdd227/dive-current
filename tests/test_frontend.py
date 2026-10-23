"""Static integration contract test; does not claim live map tile availability."""
from pathlib import Path
import re
app=Path(__file__).resolve().parents[1]/'app'
h=(app/'index.html').read_text()
js=(app/'dive-current-v0.9.8.js').read_text()
css=(app/'dive-current-v0.9.8.css').read_text()
refs=re.findall(r"document\.getElementById\('([^']+)'\)",js)
ids=set(re.findall(r'\bid="([^"]+)"',h))
missing=sorted(set(refs)-ids)
assert not missing, f'HTML missing JS-required IDs: {missing}'
for name in ['config.js','dive-current-v0.9.8.js','dive-current-v0.9.8.css','serve.py']:
    assert (app/name).is_file() and name in h or name=='serve.py' and (app/name).is_file(),name
assert "'https://tile.openstreetmap.org/{z}/{x}/{y}.png'" in js
assert "tms:true" in js and 'lake-washington-bathymetry/tiles/{z}/{x}/{y}' in js
assert 'baseLayer.setOpacity(1)' in js
assert 'DIVE_CURRENT_API_BASE' in js and 'config.js' in h
assert '.map-panel' in css and '@media(max-width:800px)' in css
print(f'PASS: all {len(set(refs))} JS-referenced element IDs exist; stylesheet, configuration, route and map code integrated')
