"""Serve the local PC console without exposing configuration or build files."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
PC = ROOT / "pc"
SHARED = ROOT / "miniprogram" / "utils"
SHARED_FILES = {"protocol.js", "business.js", "logs.js", "catalog.js"}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8"}

    def log_request(self, code="-", size="-"):
        # Other localhost clients can include credentials in query strings.
        self.log_message('"%s %s" %s', self.command, urlsplit(self.path).path, code)

    def allowed_host(self):
        try:
            return urlsplit("//" + self.headers.get("Host", "")).hostname in {"localhost", "127.0.0.1", "::1"}
        except ValueError:
            return False

    def do_GET(self):
        if not self.allowed_host():
            self.send_error(403)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.allowed_host():
            self.send_error(403)
            return
        super().do_HEAD()

    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        if path.startswith("/shared/"):
            name = path[len("/shared/"):]
            if name in SHARED_FILES:
                return str(SHARED / name)
            return str(PC / ".not-served")
        candidate = (PC / path.lstrip("/")).resolve()
        if not candidate.is_relative_to(PC.resolve()):
            return str(PC / ".not-served")
        # Dot-directories, tests and unrelated workspace files are not web assets.
        relative = candidate.relative_to(PC.resolve())
        if any(part.startswith(".") or part in {"tests", "node_modules"} for part in relative.parts):
            return str(PC / ".not-served")
        return str(candidate)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    if not (PC / "index.html").is_file():
        parser.error("pc/index.html is missing")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(PC)))
    except OSError as error:
        parser.error("Cannot start local server: " + str(error))
    url = "http://127.0.0.1:{}/".format(args.port)
    print("Campus PC console: " + url, flush=True)
    print("USB: Chrome/Edge + a USB data cable. Battery-only: choose Bluetooth.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
