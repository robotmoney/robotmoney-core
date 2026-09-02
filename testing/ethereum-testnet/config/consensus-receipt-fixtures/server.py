"""Serve static consensus-receipt fixtures to both devnet consumers."""

import http.server
import os


class FixtureHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # The indexer and Playwright browser use different origins, while the
        # fixture bytes are intentionally public test data only.
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


server = http.server.ThreadingHTTPServer(
    ("0.0.0.0", int(os.environ["RECEIPT_FIXTURES_PORT"])), FixtureHandler
)
server.serve_forever()
