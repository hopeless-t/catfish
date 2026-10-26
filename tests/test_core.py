import unittest
from catfish.server import AnchorParser, _decode_bing_redirect, _external_results, profile_path, verify_text

class CoreTests(unittest.TestCase):
    def test_block_marker(self):
        self.assertFalse(verify_text('Please verify you are human')["verified"])

    def test_profile_name_rejects_paths(self):
        with self.assertRaises(ValueError):
            profile_path("../escape")

    def test_clean_text(self):
        self.assertTrue(verify_text('normal page content')["verified"])

    def test_bing_redirect_decode(self):
        u = "https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8"
        self.assertEqual(_decode_bing_redirect(u), "https://example.com/")

    def test_brave_result_parse(self):
        src = '<a href="https://example.com/x" class="foo l1">Example Result</a>'
        got = _external_results(src, 'brave', 5)
        self.assertEqual(got, [{"title":"Example Result","url":"https://example.com/x"}])

if __name__ == '__main__':
    unittest.main()
