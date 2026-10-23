#!/usr/bin/env python3
"""Save verified NOAA CO-OPS predictions as static JSON. No synthetic data.

GitHub Pages never requests Python or a proxy at runtime. The scheduled Action
refreshes the selected set of Washington tide prediction stations.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / 'docs' / 'data'
BASE = 'https://api.tidesandcurrents.noaa.gov'
STATIONS_URL = BASE + '/mdapi/prod/webapi/stations.json?type=tidepredictions&units=english'
API_URL = BASE + '/api/prod/datagetter'
MATCH = ('tacoma', 'seattle', 'edmonds', 'everett', 'port townsend', 'port angeles',
         'bremerton', 'anacortes', 'friday harbor', 'olympia', 'gig harbor',
         'des moines', 'coupeville', 'kingston', 'blaine', 'la conner',
         'port gamble', 'port ludlow', 'tahlequah', 'point defiance')
MAX_STATIONS = 22

def get_json(url, timeout=25):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'RunTimeDiveCurrent/1.0 (public dive-planning cache)',
        'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(5_000_000)
    return json.loads(raw)

def get_predictions(station, begin, end, interval):
    params = dict(product='predictions', application='RunTimeDiveCurrent',
                  begin_date=begin, end_date=end, station=station, datum='MLLW',
                  units='english', time_zone='gmt', format='json', interval=interval)
    data = get_json(API_URL + '?' + urllib.parse.urlencode(params), timeout=30)
    if data.get('error'):
        raise ValueError(f"NOAA station {station}: {data['error']}")
    records = data.get('predictions')
    if not isinstance(records, list) or not records:
        raise ValueError(f'No official NOAA predictions for {station}/{interval}')
    valid = [v for v in records if re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}', str(v.get('t','')))
             and 0 <= abs(float(v.get('v', 'nan'))) < 50]
    if len(valid) != len(records):
        raise ValueError(f'Invalid timestamp or water height in {station}/{interval}')
    return valid

def main():
    now = datetime.now(timezone.utc)
    # NOAA tide predictions change much more slowly than the four daily SSCOFS cycles.
    station_cache = ROOT/'stations.json'
    if station_cache.exists():
        try:
            prior = json.loads(station_cache.read_text())
            updated = datetime.fromisoformat(prior['generated_at'].replace('Z','+00:00'))
            if now-updated < timedelta(hours=20) and prior.get('stations'):
                print('Tide cache still fresh (<20 h); skipping redundant NOAA requests')
                return
        except (ValueError,KeyError,TypeError):pass
    start = (now - timedelta(days=1)).strftime('%Y%m%d')
    end = (now + timedelta(days=3)).strftime('%Y%m%d')
    output = ROOT / 'tides'
    output.mkdir(parents=True, exist_ok=True)
    rows = get_json(STATIONS_URL).get('stations', [])
    candidates = []
    for row in rows:
        lat, lng = float(row.get('lat',0)), float(row.get('lng',0))
        name, sid = str(row.get('name','')), str(row.get('id',''))
        if (46.0 <= lat <= 49.1 and -124.9 <= lng <= -121.8
                and re.fullmatch(r'\d{7}',sid)
                and any(term in name.lower() for term in MATCH)):
            candidates.append({'name':name, 'id':sid, 'lat':lat, 'lng':lng})
    candidates.sort(key=lambda st:(0 if st['id']=='9446484' else 1, st['name']))
    candidates = candidates[:MAX_STATIONS]
    successful = []
    for st in candidates:
        sid=st['id']
        try:
            predictions = get_predictions(sid, start, end, '6')
            events = get_predictions(sid, start, end, 'hilo')
            payload = {'source':'NOAA CO-OPS','station_id':sid,'name':st['name'],
                       'generated_at':now.strftime('%Y-%m-%dT%H:%M:%SZ'),
                       'timezone':'UTC','datum':'MLLW','units':'feet',
                       'predictions':predictions,'events':events}
            (output/f'{sid}.json').write_text(json.dumps(payload, separators=(',',':'))+'\n')
            successful.append(st)
            print(f'Tide predictions: {sid} {st["name"]}: {len(predictions)} values')
        except Exception as e:
            print(f'SKIPPED NOAA tide station {sid}: {e}',file=sys.stderr)
    if not successful:
        raise RuntimeError('No fresh NOAA tide predictions; existing files left untouched')
    (ROOT/'stations.json').write_text(json.dumps({'source':'NOAA CO-OPS',
        'generated_at':now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'stations':successful},indent=2)+'\n')
    print(f'Updated {len(successful)} stations successfully')

if __name__=='__main__':
    main()
