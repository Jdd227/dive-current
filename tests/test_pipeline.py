"""Offline NOAA conversion contract tests, no live network and no invented public forecast."""
import sys
import types
import unittest
from pathlib import Path
import importlib.util
from datetime import datetime,timezone,timedelta
import numpy as np

HERE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('update_sscofs',HERE/'scripts/update_sscofs.py')
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Variable:
    def __init__(self,array,units=None):
        self.data=np.asarray(array);self.shape=self.data.shape;self.units=units
    def __getitem__(self,item):return self.data[item]

class FakeDataset:
    def __init__(self,cycle,lead,break_mask=False):
        n=207
        lat=np.linspace(47.05,48.25,n)[:,None]+np.zeros((n,n))
        lon=np.linspace(-123.7,-122.1,n)[None,:]+np.zeros((n,n))
        zeros=np.ones_like(lat)
        if break_mask:zeros*=0
        t=np.array([0.])
        u=np.full((1,2,n,n),.4);v=np.full((1,2,n,n),-.2)
        self.variables={'Latitude':Variable(lat),'Longitude':Variable(lon),'mask':Variable(zeros),
                        'Depth':Variable([0.,2.]),'u_eastward':Variable(u),'v_northward':Variable(v),
                        'time':Variable(t,units='seconds since 2018-01-01 00:00:00')}

class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.cycle=datetime(2026,10,22,3,tzinfo=timezone.utc)
        self.lead=3
        self.original=sys.modules.get('netCDF4')
        fake=types.ModuleType('netCDF4')
        fake.num2date=lambda *_args,**_kwargs:self.cycle+timedelta(hours=self.lead)
        sys.modules['netCDF4']=fake
    def tearDown(self):
        if self.original is None:sys.modules.pop('netCDF4',None)
        else:sys.modules['netCDF4']=self.original
    def test_verified_frame(self):
        result=mod.frame_from_dataset(FakeDataset(self.cycle,self.lead),self.cycle,self.lead)
        self.assertEqual(result['source'],'NOAA SSCOFS')
        self.assertEqual(result['valid_time'],'2026-10-22T06:00:00Z')
        self.assertGreaterEqual(len(result['points']),150)
        self.assertAlmostEqual(result['points'][0][2],.4)
        self.assertAlmostEqual(result['points'][0][3],-.2)
    def test_reject_missing_water(self):
        with self.assertRaisesRegex(ValueError,'Insufficient'):
            mod.frame_from_dataset(FakeDataset(self.cycle,self.lead,True),self.cycle,self.lead)
    def test_reject_time_mismatch(self):
        sys.modules['netCDF4'].num2date=lambda *_a,**_k:self.cycle+timedelta(days=3)
        with self.assertRaisesRegex(ValueError,'inconsistent'):
            mod.frame_from_dataset(FakeDataset(self.cycle,self.lead),self.cycle,self.lead)
    def test_url_points_to_official_noaa_production(self):
        url=mod.dataset_url(self.cycle,3)
        self.assertIn('/thredds/dodsC/NOAA/SSCOFS/MODELS/2026/10/22/',url)
        self.assertIn('sscofs.t03z.20261022.regulargrid.f003.nc',url)

if __name__=='__main__':unittest.main()
