const DEFAULT_TIMEOUT_MS = 12000;
const TOKEN_KEY = "aircon_token";
const API_BASE_KEY = "aircon_api_base";

/** Default ngrok proxy (override with ?api= or localStorage). */
export const DEFAULT_API_BASE = "https://hefty-feminism-prissy.ngrok-free.dev";

/** Strip trailing slash from API base. */
export function normalizeApiBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function getApiBase() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("api");
  if (fromQuery) {
    const base = normalizeApiBase(fromQuery);
    localStorage.setItem(API_BASE_KEY, base);
    params.delete("api");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
    return base;
  }
  // Hardcoded default; ignore stale localStorage unless set via ?api=
  return DEFAULT_API_BASE;
}

export function setApiBase(url) {
  const base = normalizeApiBase(url);
  if (base) localStorage.setItem(API_BASE_KEY, base);
  else localStorage.removeItem(API_BASE_KEY);
}

export function getToken() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("token");
  if (fromQuery) {
    sessionStorage.setItem(TOKEN_KEY, fromQuery);
    params.delete("token");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
    return fromQuery;
  }
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

function ngrokHeaders() {
  return { "ngrok-skip-browser-warning": "true" };
}

function authHeaders() {
  const token = getToken();
  const headers = { ...ngrokHeaders() };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function withTokenQuery(url) {
  const token = getToken();
  if (!token) return url;
  const join = url.includes("?") ? "&" : "?";
  return `${url}${join}token=${encodeURIComponent(token)}`;
}

function apiUrl(path) {
  const base = getApiBase();
  if (!base) {
    throw new Error(
      "Proxy URL not set — open this page with ?api=https://YOUR-NGROK-URL"
    );
  }
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function friendlyNetworkError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (
    err.name === "TypeError" ||
    /Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)
  ) {
    return "Cannot reach the aircon proxy — is ngrok/proxy running on your Mac?";
  }
  if (err.name === "AbortError") {
    return "Proxy timed out — is ngrok/proxy running?";
  }
  return msg;
}

export async function ensureApiReady() {
  try {
    const res = await fetch(apiUrl("/health"), {
      headers: ngrokHeaders(),
      credentials: "omit",
    });
    const contentType = res.headers.get("Content-Type") || "";
    if (!res.ok) {
      throw new Error(
        `Proxy returned ${res.status} — is ngrok running at ${getApiBase()}?`
      );
    }
    if (!contentType.includes("application/json")) {
      throw new Error(
        "Proxy URL looks wrong (expected JSON /health). Check DEFAULT_API_BASE / ?api=."
      );
    }
    const body = await res.json();
    if (!body.ok || body.service !== "aircon-proxy") {
      throw new Error(
        "That URL is not the aircon proxy — start ./proxy/serve.sh behind ngrok"
      );
    }
  } catch (err) {
    throw new Error(friendlyNetworkError(err));
  }
}

export async function ensureToken() {
  await ensureApiReady();

  let token = getToken();

  if (token) {
    const res = await fetch(withTokenQuery(apiUrl("/api/_auth_check")), {
      headers: authHeaders(),
      credentials: "omit",
    });
    if (res.status === 401) {
      setToken("");
      token = "";
    } else if (!res.ok && res.status !== 204) {
      throw new Error(friendlyNetworkError(new Error(`Auth check failed (${res.status})`)));
    } else {
      return token;
    }
  }

  let probe;
  try {
    probe = await fetch(apiUrl("/api/_auth_check"), {
      headers: ngrokHeaders(),
      credentials: "omit",
    });
  } catch (err) {
    throw new Error(friendlyNetworkError(err));
  }

  if (probe.status !== 401) return "";

  token = window.prompt("Enter aircon access token:");
  if (!token) throw new Error("Token required");
  token = token.trim();
  setToken(token);

  const confirm = await fetch(withTokenQuery(apiUrl("/api/_auth_check")), {
    headers: authHeaders(),
    credentials: "omit",
  });
  if (confirm.status === 401) {
    setToken("");
    throw new Error("Invalid token");
  }
  return token;
}

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(Object.assign(new Error("Timed out"), { name: "AbortError" })), ms);
  });
}

async function fetchJson(path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const finalUrl = withTokenQuery(apiUrl(path));

  try {
    const data = await Promise.race([
      (async () => {
        let response;
        try {
          response = await fetch(finalUrl, {
            signal: controller.signal,
            headers: authHeaders(),
            credentials: "omit",
          });
        } catch (err) {
          throw new Error(friendlyNetworkError(err));
        }

        if (response.status === 401) {
          setToken("");
          throw new Error("Unauthorized — add ?token=YOUR_SECRET to the page URL");
        }

        const contentType = response.headers.get("Content-Type") || "";
        if (!response.ok) {
          let detail = `Request failed (${response.status})`;
          if (contentType.includes("application/json")) {
            try {
              const body = await response.json();
              if (body.error) detail = body.error;
            } catch {
              /* ignore */
            }
          } else if (response.status === 404) {
            detail =
              "Proxy returned 404 — is ?api= pointing at the ngrok proxy (not GitHub Pages)?";
          }
          throw new Error(detail);
        }

        if (!contentType.includes("application/json")) {
          throw new Error(
            "Unexpected response from proxy — check ?api= is your ngrok URL"
          );
        }
        return response.json();
      })(),
      timeout(timeoutMs),
    ]);
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(friendlyNetworkError(err));
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGet(roomId) {
  return fetchJson(`/api/${encodeURIComponent(roomId)}/get`);
}

export async function fetchSet(roomId, params) {
  const query = new URLSearchParams(params).toString();
  return fetchJson(`/api/${encodeURIComponent(roomId)}/set?${query}`);
}
