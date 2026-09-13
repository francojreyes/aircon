# Aircon

IR control for Daikin aircons via ESP8266 boards, with a static web UI and a small LAN proxy.

## Layout

| Path | Role |
|------|------|
| [`arduino/`](arduino/) | Firmware + `upload.sh` |
| [`web/`](web/) | Static UI → **GitHub Pages** |
| [`proxy/`](proxy/) | API proxy → **ngrok** |

The phone/browser loads the UI from GitHub Pages and calls the proxy over ngrok (CORS). The proxy talks to the ESPs on your LAN.

## Proxy

```bash
cd proxy
AIRCON_TOKEN=your-secret ./serve.sh
# other terminal:
ngrok http 8080
```

Edit [`proxy/rooms.json`](proxy/rooms.json) for ESP hosts (`http://livingroom.local`, etc.).

Optional env:

| Variable | Meaning |
|----------|---------|
| `AIRCON_TOKEN` | Required for public ngrok |
| `AIRCON_CORS_ORIGINS` | Extra allowed Origins (comma-separated) |
| `PORT` | Default `8080` |

`GET /health` returns JSON `{ "ok": true, "service": "aircon-proxy", ... }` so the UI can verify the URL.

## Firmware

Flash [`arduino/aircon/aircon.ino`](arduino/aircon/aircon.ino) per board. Room is set at compile time (`-DAIRCON_ROOM=…`); for interactive flash:

```bash
./arduino/upload.sh
```
