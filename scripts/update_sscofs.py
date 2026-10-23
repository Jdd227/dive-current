#!/usr/bin/env python3
"""Publish audited, downsampled near-surface NOAA SSCOFS forecasts from OPeNDAP.

Reads only named official NOAA NetCDF variables through remote hyperslab slicing.
On ANY failure, never publishes invented or partially validated data; the prior
manifest and files remain unchanged. GitHub Pages refuses forecasts >18 h old.

NOAA model: SSCOFS regulargrid.fNNN.nc; Time x Depth x ny x nx.
IMPORTANT: NASA/NOAA remote THREDDS availability varies. First live Action must be
reviewed before the forecast feature is treated as operational.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import math
import re
import sys
import time
from urllib.parse import urlsplit
import urllib.error
import urllib.request
import numpy as np

ROOT = Path(__file__).resolve().parents[1] / 'docs' / 'data' / 'sscofs'
# Only the published NOAA THREDDS production endpoint, not test or dev catalogs.
THREDDS = 'https://opendap.co-ops.nos.noaa.gov/thredds'
# NOAA runs at 03,09,15,21 UTC; files are posted after model execution.
CYCLES = (3, 9, 15, 21)
LEADS = (1,3,6,9,12,15,18,21,24,30,36,48)
# Stride in model rows/columns, not arbitrary interpolation.
STRIDE = 3
REGION = (46.7, 49.2, -124.5, -121.5) # latitude min/max, longitude min/max

def get_dds(url, timeout=16):
    req=urllib.request.Request(url+'.dds',headers={'User-Agent':'RunTime-DiveCurrent/1.0'})
    with urllib.request.urlopen(req,timeout=timeout) as resp:
        body=resp.read(90000).decode('utf8','replace')
    return 'u_eastward' in body and 'v_northward' in body and 'Latitude' in body

def candidate_cycles(now):
    today=now.replace(hour=0,minute=0,second=0,microsecond=0)
    choices=[today+timedelta(days=days,hours=hour) for days in (0,-1,-2) for hour in CYCLES]
    return sorted((x for x in choices if x<=now),reverse=True)

def dataset_url(cycle,lead):
    date=cycle.strftime('%Y%m%d')
    fname=f'sscofs.t{cycle.hour:02d}z.{date}.regulargrid.f{lead:03d}.nc'
    return f'{THREDDS}/dodsC/NOAA/SSCOFS/MODELS/{cycle:%Y/%m/%d}/{fname}'

def find_cycle(now):
    errors=[]
    for cycle in candidate_cycles(now)[:10]:
        url=dataset_url(cycle,3)
        try:
            if get_dds(url):
                return cycle
        except Exception as e:
            errors.append(f'{cycle.isoformat()}: {type(e).__name__}: {str(e)[:90]}')
    raise RuntimeError('No accessible NOAA SSCOFS OPeNDAP cycle: '+'; '.join(errors[-4:]))

def ndarray(v):
    return np.ma.filled(np.ma.asarray(v),np.nan).astype(float)

def frame_from_dataset(ds,requested_cycle,lead):
    needed=('Latitude','Longitude','mask','Depth','u_eastward','v_northward','time')
    if any(x not in ds.variables for x in needed):
        raise ValueError('Missing NOAA variables '+str([x for x in needed if x not in ds.variables]))
    latitude=ds.variables['Latitude']
    longitude=ds.variables['Longitude']
    uvar=ds.variables['u_eastward']
    vvar=ds.variables['v_northward']
    if len(uvar.shape)!=4 or vvar.shape!=uvar.shape or len(latitude.shape)!=2:
        raise ValueError('SSCOFS variable dimensions changed unexpectedly')
    depth=ndarray(ds.variables['Depth'][:])
    if depth.ndim!=1 or not len(depth):raise ValueError('Invalid NOAA depth levels')
    surface=int(np.nanargmin(np.abs(depth)))
    # NOAA defines Depth as positive down. Closest sampled level to surface.
    if not (-1 <= depth[surface] <= 5):
        raise ValueError('No near-surface standard depth in forecast')
    ny,nx=latitude.shape
    sl=(slice(0,ny,STRIDE),slice(0,nx,STRIDE))
    lat=ndarray(latitude[sl]); lon=ndarray(longitude[sl])
    mask=ndarray(ds.variables['mask'][sl])
    u=ndarray(uvar[0,surface,sl[0],sl[1]])
    v=ndarray(vvar[0,surface,sl[0],sl[1]])
    if any(x.shape != lat.shape for x in (lon,mask,u,v)):
        raise ValueError('NOAA grid dimensions not aligned')
    # Read model time itself to ensure file name matches actual simulation time.
    import netCDF4
    var=ds.variables['time']; units=var.units
    date=netCDF4.num2date(var[0],units,calendar=getattr(var,'calendar','gregorian'),only_use_cftime_datetimes=False)
    valid_time=datetime(date.year,date.month,date.day,date.hour,date.minute,date.second,tzinfo=timezone.utc)
    expected=requested_cycle+timedelta(hours=lead)
    if abs((valid_time-expected).total_seconds())>3600:
        raise ValueError(f'Model valid time {valid_time} inconsistent with {expected}')
    south,north,west,east=REGION
    # 1 = model water. Reject invalid/fill data and implausible extreme vectors.
    usable=(np.isfinite(lat)&np.isfinite(lon)&np.isfinite(u)&np.isfinite(v)
            &(mask>0.5)&(lat>=south)&(lat<=north)&(lon>=west)&(lon<=east)
            &(np.abs(u)<6)&(np.abs(v)<6))
    idx=np.flatnonzero(usable)
    if len(idx)<150:
        raise ValueError(f'Insufficient NOAA marine-water vectors: {len(idx)}')
    latv,lonv,uv,vv=(arr.ravel()[idx] for arr in (lat,lon,u,v))
    points=[[round(float(a),6),round(float(b),6),round(float(c),5),round(float(d),5)]
            for a,b,c,d in zip(latv,lonv,uv,vv)]
    payload={'source':'NOAA SSCOFS','valid_time':valid_time.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'sample_depth_m':round(float(depth[surface]),3),
            'grid_stride':STRIDE,'component_units':'m/s','points':points}
    return payload

def main():
    import netCDF4
    now=datetime.now(timezone.utc)
    cycle=find_cycle(now)
    if (now-cycle)>timedelta(hours=18):
        raise RuntimeError(f'Newest NOAA model cycle too old: {cycle}')
    print('Selected NOAA SSCOFS cycle:',cycle.isoformat(),flush=True)
    # Prepare all frames in memory. Only publish after at least 3 validated slices.
    frames=[]
    for lead in LEADS:
        url=dataset_url(cycle,lead)
        try:
            ds=netCDF4.Dataset(url,'r')
            try: data=frame_from_dataset(ds,cycle,lead)
            finally: ds.close()
            iso=data['valid_time']
            file='data/sscofs/frame-'+iso.replace(':','').replace('-','')+'.json'
            frames.append((file,data))
            print('Validated',lead,'h:',len(data['points']),'marine vectors',flush=True)
        except Exception as e:
            print(f'SKIPPED forecast f{lead:03d}: {type(e).__name__}: {e}',file=sys.stderr,flush=True)
    if len(frames)<3:
        raise RuntimeError(f'Only {len(frames)} verified NOAA frames; not publishing manifest')
    ROOT.mkdir(parents=True,exist_ok=True)
    # Write frames, then atomically replace manifest last.
    for file,data in frames:
        (ROOT/Path(file).name).write_text(json.dumps(data,separators=(',',':'))+'\n')
    manifest={'status':'ok','source':'NOAA SSCOFS',
              'cycle_time':cycle.strftime('%Y-%m-%dT%H:%M:%SZ'),
              'generated_at':now.strftime('%Y-%m-%dT%H:%M:%SZ'),
              'grid_stride':STRIDE,'sample_depth_m':frames[0][1]['sample_depth_m'],
              'frames':[{'file':file,'valid_time':data['valid_time'],'points':len(data['points'])}
                        for file,data in frames]}
    temp=ROOT/'manifest.json.tmp';temp.write_text(json.dumps(manifest,indent=2)+'\n')
    temp.replace(ROOT/'manifest.json')
    # Keep only the current cycle in the working tree; never delete the previous
    # data until the new cycle and manifest are fully validated and written.
    keep={Path(file).name for file,_ in frames}
    for old in ROOT.glob('frame-*.json'):
        if old.name not in keep:old.unlink()
    print(f'Published {len(frames)} authentic NOAA forecast frames')

if __name__=='__main__':
    main()
