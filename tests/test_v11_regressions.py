from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
class RegressionChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js=(ROOT/'docs/dive-current.js').read_text()
        cls.html=(ROOT/'docs/index.html').read_text()
    def test_projected_webmercator_bathymetry(self):
        self.assertIn("bboxSR:'3857',imageSR:'3857'",self.js)
        self.assertIn("const commonScale=Math.min(1,3000/v.width,3000/v.height)",self.js)
    def test_double_map_timeline_controls(self):
        for x in ('currentTimeline','tideTimeline','flowMode','arrowMode','selectedTimeValue'):
            self.assertIn('id="'+x+'"',self.html)
    def test_mode_draws_real_noaa_grid_vectors(self):
        self.assertIn('function drawArrowMap()',self.js)
        self.assertIn('visibleWaterSeeds=prepareVisibleWaterSeeds()',self.js)
        self.assertIn('flowDisplay',self.js)
    def test_missing_tide_fallback_not_synthetic(self):
        self.assertIn('api.tidesandcurrents.noaa.gov/api/prod/datagetter',self.js)
        self.assertNotIn('syntheticTide',self.js)
    def test_sscofs_stride(self):
        self.assertIn('STRIDE = 3',(ROOT/'scripts/update_sscofs.py').read_text())
    def test_tacoma_tide_fallback(self):
        src=(ROOT/'scripts/update_tides.py').read_text()
        self.assertIn("'id':'9446484'",src)
        self.assertIn('if not successful:',src)
if __name__=='__main__':unittest.main()
