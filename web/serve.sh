#!/usr/bin/env bash
# Deprecated: UI is static (GitHub Pages). Use the API proxy instead:
echo "web/serve.sh was removed — run the proxy:" >&2
echo "  AIRCON_TOKEN=… ./proxy/serve.sh" >&2
echo "  ngrok http 8080" >&2
exit 1
