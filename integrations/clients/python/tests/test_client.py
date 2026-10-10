# Copyright The Harmoniq Authors
# SPDX-License-Identifier: Apache-2.0

import json
import socketserver
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from harmoniq import Client, HarmoniqError


class Handler(BaseHTTPRequestHandler):
    seen = {}

    def log_message(self, *args):
        pass

    def _reply(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        Handler.seen = {
            "path": self.path,
            "auth": self.headers.get("Authorization"),
            "body": json.loads(self.rfile.read(length)),
        }
        self._reply(201, {"id": "v1"})

    def do_GET(self):
        self._reply(423, {"error": {"code": "LOCKED", "message": "production is frozen"}})


class Server(HTTPServer):
    def server_bind(self):
        # HTTPServer resolves its FQDN here, which can take seconds; not needed.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.client = Client(f"http://127.0.0.1:{cls.server.server_port}", api_key="hq_k_s")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_generated_operation(self):
        res = self.client.post_workspaces_modules_deploy(
            "acme", "check/out", body={"environment": "staging"}, query={"dryRun": 1}
        )
        self.assertEqual(res.status, 201)
        self.assertEqual(res.json(), {"id": "v1"})
        self.assertEqual(Handler.seen["path"], "/api/workspaces/acme/modules/check%2Fout/deploy?dryRun=1")
        self.assertEqual(Handler.seen["auth"], "Bearer hq_k_s")
        self.assertEqual(Handler.seen["body"], {"environment": "staging"})

    def test_errors(self):
        with self.assertRaises(HarmoniqError) as ctx:
            self.client.get_manifest_by_workspace_slug_and_host_app_slug_and_env("acme", "portal", "production")
        self.assertEqual((ctx.exception.status, ctx.exception.code), (423, "LOCKED"))
        self.assertIn("frozen", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
