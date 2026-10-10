# harmoniq-client

Thin Python client for the [Harmoniq](https://github.com/TrivioQ/Harmoniq) micro frontend registry API: one method per REST operation, standard library only.

```python
from harmoniq import Client

client = Client("https://registry.acme.dev", api_key="hq_…")
manifest = client.get_manifest_by_workspace_slug_and_host_app_slug_and_env("acme", "portal", "production").json()
```

See [the clients overview](https://github.com/TrivioQ/Harmoniq/tree/main/integrations/clients) for naming and examples.
