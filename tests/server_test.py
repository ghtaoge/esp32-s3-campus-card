"""Verify the PC server serves only browser assets and shared public modules."""
from contextlib import contextmanager
from functools import partial
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
from pathlib import Path
import tempfile
from threading import Thread
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("campus_pc_server", ROOT / "tools/serve_pc.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        local = ROOT / ".local"
        local.mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix="server-test-", dir=local)
        cls.fixture = Path(cls.temp.name).resolve()
        assert cls.fixture.is_relative_to(local.resolve())
        module.PC = cls.fixture / "pc"
        module.SHARED = cls.fixture / "utils"
        module.PC.mkdir()
        module.SHARED.mkdir()
        (module.PC / "index.html").write_text("<p>校园实验台</p>", encoding="utf-8")
        (module.SHARED / "protocol.js").write_text("window.fixture=true;", encoding="utf-8")
        (module.PC / "tests").mkdir()
        (module.PC / "tests" / "private.js").write_text("test-only", encoding="utf-8")
        (cls.fixture / "secret.txt").write_text("not-a-web-asset", encoding="utf-8")
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(module.Handler, directory=str(module.PC)))
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        assert cls.fixture.is_relative_to((ROOT / ".local").resolve())
        cls.temp.cleanup()

    def request(self, path, host=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        connection.request("GET", path, headers={"Host": host or "127.0.0.1"})
        response = connection.getresponse()
        result = response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
        connection.close()
        return result

    def test_index_and_shared_script(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn("校园".encode(), body)
        self.assertEqual(headers["cache-control"], "no-store")
        status, headers, body = self.request("/shared/protocol.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers["content-type"])

    def test_private_and_traversal_paths_are_not_served(self):
        for path in ["/.local/config.json", "/../secret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt", "/shared/../secret.txt", "/shared/ble.js", "/tests/private.js", "/shared/"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)

    def test_foreign_host_is_rejected(self):
        self.assertEqual(self.request("/", "example.invalid")[0], 403)


if __name__ == "__main__":
    unittest.main()
