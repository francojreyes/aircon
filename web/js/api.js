const DEFAULT_TIMEOUT_MS = 15000;
const TOKEN_KEY = "aircon_token";
const API_BASE_KEY = "aircon_api_base";

/** Default ngrok proxy (override with ?api= for this tab session). */
export const DEFAULT_API_BASE = "https://hefty-feminism-prissy.ngrok-free.dev";

/** Set when ?api= is used; survives query stripping for the rest of this page load. */
let apiBaseOverride = null;

/** Strip trailing slash from API base. */
export function normalizeApiBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function getApiBase() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("api");
  if (fromQuery) {
    const base = normalizeApiBase(fromQuery);
    apiBaseOverride = base;
    localStorage.setItem(API_BASE_KEY, base);
    params.delete("api");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
    return base;
  }
  if (apiBaseOverride) return apiBaseOverride;
  // Ignore stale localStorage — always fall back to hardcoded default unless ?api= this visit
  return DEFAULT_API_BASE;
}

export function setApiBase(url) {
  const base = normalizeApiBase(url);
  apiBaseOverride = base || null;
  if (base) localStorage.setItem(API_BASE_KEY, base);
  else localStorage.removeItem(API_BASE_KEY);
}

export function getToken() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("token");
  if (fromQuery) {
    setToken(fromQuery);
    params.delete("token");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
    return fromQuery;
  }
  // Prefer localStorage so iOS PWAs keep the token across launches.
  // Migrate any leftover sessionStorage value from older builds.
  const stored = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
  if (stored && !localStorage.getItem(TOKEN_KEY)) {
    localStorage.setItem(TOKEN_KEY, stored);
    sessionStorage.removeItem(TOKEN_KEY);
  }
  return stored;
}

export function setToken(token) {
  sessionStorage.removeItem(TOKEN_KEY);
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
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
    return "Cannot reach the aircon proxy — is ngrok/proxy running?";
  }
  if (err.name === "AbortError") {
    return "Request timed out — board may be offline (or proxy slow)";
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
        "That URL is not the aircon proxy — check DEFAULT_API_BASE / ?api="
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
    let res;
    try {
      res = await fetch(withTokenQuery(apiUrl("/api/_auth_check")), {
        headers: authHeaders(),
        credentials: "omit",
      });
    } catch (err) {
      throw new Error(friendlyNetworkError(err));
    }
    if (res.status === 401) {
      setToken("");
      token = "";
    } else if (!res.ok && res.status !== 204) {
      throw new Error(`Auth check failed (${res.status})`);
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

  // Proxy reachable and auth disabled.
  if (probe.status !== 401) return "";

  token = window.prompt("Enter aircon access token:");
  if (!token) {
    throw new Error("Access token required — open with ?token=… or enter it when prompted");
  }
  token = token.trim();
  setToken(token);

  let confirm;
  try {
    confirm = await fetch(withTokenQuery(apiUrl("/api/_auth_check")), {
      headers: authHeaders(),
      credentials: "omit",
    });
  } catch (err) {
    throw new Error(friendlyNetworkError(err));
  }
  if (confirm.status === 401) {
    setToken("");
    throw new Error("Invalid access token");
  }
  if (!confirm.ok && confirm.status !== 204) {
    throw new Error(`Auth check failed (${confirm.status})`);
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
          throw new Error(
            "Access token missing or wrong — reopen with ?token=… or clear site data and try again"
          );
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
