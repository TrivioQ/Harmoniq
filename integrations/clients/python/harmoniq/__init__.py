# Copyright The Harmoniq Authors
# SPDX-License-Identifier: Apache-2.0

"""Thin client for the Harmoniq registry REST API (OAS-03).

    from harmoniq import Client

    client = Client("https://registry.acme.dev", api_key=os.environ["HARMONIQ_API_KEY"])
    client.post_workspaces_modules_deploy("acme", "checkout", body={
        "environment": "staging",
        "version": "1.4.0",
        "url": "https://cdn.acme.dev/checkout/1.4.0/remoteEntry.js",
        "integrity": "sha384-…",
    })
"""

from ._core import HarmoniqError, Response
from ._operations import Client

__all__ = ["Client", "HarmoniqError", "Response"]
__version__ = "0.1.0"
