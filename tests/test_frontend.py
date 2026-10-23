import unittest
from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
class FrontendTests(unittest.TestCase):
    def test_dom_contains_all_required_control_ids(self):
        js=(root/'docs/dive-current.js').read_text()
        html=(root/'docs/index.html').read_text()
        missing=sorted(set(re.findall(r'document\.getElementById\([\'\"]([^\'\"]+)[\'\"]\)',js))-{x for x in re.findall(r'id="([^"]+)"',html)})
        self.assertFalse(missing,missing)
    def test_no_legacy_api_dependencies(self):
        js=(root/'docs/dive-current.js').read_text()
        for f in ('/api/health','/api/sscofs','/api/dnr','/api/noaa','checkLocalDataServer'):
            self.assertNotIn(f,js)
    def test_static_assets_present(self):
        html=(root/'docs/index.html').read_text()
        self.assertIn('dive-current.js',html)
        self.assertIn('dive-current.css',html)
        self.assertTrue((root/'.github/workflows/deploy-pages.yml').exists())
if __name__=='__main__':unittest.main()
