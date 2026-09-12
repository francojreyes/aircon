# Aircon

IR control for Daikin aircons via ESP8266 boards, with a static web UI and a small LAN proxy.

## Layout

| Path | Role |
|------|------|
| [`aircon/`](aircon/) | Arduino firmware (`aircon.ino`) |
| [`web/`](web/) | Static UI → **GitHub Pages** |
| [`proxy/`](proxy/) | API proxy → **Mac + ngrok** |

The phone/browser loads the UI from GitHub Pages and calls the proxy over ngrok (CORS). The proxy talks to the ESPs on your LAN.

## GitHub Pages (separate repo)

Typical setup for `https://francojreyes.github.io/aircon/`:

1. Create a GitHub repo named **`aircon`** (under your user).
2. Copy the contents of **`web/`** to the **root** of that repo (or push this monorepo and set Pages to serve `/web` if you prefer).
3. **Settings → Pages →** Deploy from branch `main` (root), or use GitHub Actions.
4. After a minute, open `https://<user>.github.io/aircon/`.

Project sites are always at `username.github.io/<repo>/`. Relative asset paths in `web/` are set up for that.

With the proxy + ngrok running, open the Pages site (token still required if `AIRCON_TOKEN` is set):

```text
https://francojreyes.github.io/aircon/?token=YOUR_SECRET
```

The proxy base defaults to `https://hefty-feminism-prissy.ngrok-free.dev` in [`web/js/api.js`](web/js/api.js). Override with `?api=https://…` if the ngrok URL changes (saved in localStorage). `token` is stored in sessionStorage.

## Proxy (Mac)

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

Flash [`aircon/aircon.ino`](aircon/aircon.ino) per board; set `kRoom` to `Livingroom` / `Bedroom` / `Study`.
