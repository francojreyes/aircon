import { getAircons, featuresForProtocol } from "./config.js";
import { ensureToken, fetchGet, fetchSet } from "./api.js?v=14";

const TEMP_MIN = 18;
const TEMP_MAX = 30;
const FAN_LEVELS = ["1", "2", "3", "4", "5"];

const icon = (name) =>
  `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;

/** Prefer attached features; otherwise derive from protocol (default: limited). */
function featuresOf(room) {
  return room.features ?? featuresForProtocol(room.protocol);
}

let AIRCONS = [];
let roomState = {};
let activeId = null;
let panel;
let form;
let booting = true;
/** Skeleton ships DAIKIN152 controls (default Living Room tab). */
let extrasKey = "true|true|true";

const ROOM_STORAGE_KEY = "aircon_active_room";

function activeRoom() {
  return AIRCONS.find((room) => room.id === activeId);
}

function persistActiveRoom(id) {
  localStorage.setItem(ROOM_STORAGE_KEY, id);
  const params = new URLSearchParams(window.location.search);
  if (params.get("room") !== id) {
    params.set("room", id);
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }
}

function resolveInitialRoomId() {
  const fromUrl = new URLSearchParams(window.location.search).get("room");
  if (fromUrl && AIRCONS.some((r) => r.id === fromUrl)) return fromUrl;
  const fromStore = localStorage.getItem(ROOM_STORAGE_KEY);
  if (fromStore && AIRCONS.some((r) => r.id === fromStore)) return fromStore;
  return AIRCONS[0].id;
}

function initRoomState(rooms) {
  roomState = Object.fromEntries(
    rooms.map((room) => [
      room.id,
      {
        online: null,
        loadingGet: false,
        sending: false,
        fanBeforeAutoLock: null,
        values: {
          power: false,
          temp: 25,
          mode: "cool",
          fan_speed: "auto",
          quiet: false,
          comfort: false,
          economy: false,
        },
      },
    ])
  );
}

function showToast(message, type) {
  if (!panel) return;
  const toast = panel.querySelector(".toast");
  toast.textContent = message;
  toast.className = `toast toast--${type}`;
  toast.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

function renderStatusBadge() {
  const state = roomState[activeId];
  const badge = panel.querySelector(".status-badge");
  if (state.online === null) {
    badge.textContent = "Connecting";
    badge.className = "status-badge status-badge--connecting";
  } else if (state.online) {
    badge.textContent = "Online";
    badge.className = "status-badge status-badge--online";
  } else {
    badge.textContent = "Offline";
    badge.className = "status-badge status-badge--offline";
  }
}

/** Update online flag for a specific room; only refresh the badge if that room is visible. */
function setRoomOnline(roomId, online) {
  if (!roomState[roomId]) return;
  roomState[roomId].online = online;
  updateTabIndicators();
  if (roomId === activeId) syncBusyUi();
}

function syncBusyUi() {
  if (!form) return;
  const state = roomState[activeId];
  renderStatusBadge();

  const refreshBtn = form.querySelector(".refresh-btn");
  refreshBtn.disabled = state.loadingGet || booting;
  refreshBtn.textContent = state.loadingGet || booting ? "Refreshing..." : "Refresh";

  const sendBtn = form.querySelector(".send-btn");
  if (state.sending) {
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending...";
  } else {
    sendBtn.textContent = "Send";
    sendBtn.disabled = state.online !== true || state.loadingGet || booting;
  }
}

function updateTabIndicators() {
  panel.querySelectorAll(".room-tab").forEach((tab) => {
    const online = roomState[tab.dataset.roomId].online;
    tab.classList.toggle("is-online", online === true);
    tab.classList.toggle("is-offline", online === false);
    tab.classList.toggle("is-unknown", online === null);
  });
}

function stateToValues(state) {
  const mode = ["cool", "fan", "dry"].includes(state.mode) ? state.mode : "cool";
  const cooling = mode === "cool" || mode === "dry";
  return {
    power: Boolean(state.power),
    temp: Number(state.temp ?? 25),
    mode,
    fan_speed: state.fan_speed ?? "auto",
    quiet: mode === "cool" ? Boolean(state.quiet) : false,
    comfort: cooling ? Boolean(state.comfort) : false,
    economy: cooling ? Boolean(state.economy) : false,
  };
}

function currentMode() {
  return form.querySelector('[name="mode"]:checked')?.value ?? "cool";
}

function toggleParam(name) {
  const el = form.querySelector(`[name="${name}"]`);
  return el && el.checked ? "on" : "off";
}

function readForm() {
  const mode = currentMode();
  const room = activeRoom();
  const params = {
    power: form.querySelector('[name="power"]').checked ? "on" : "off",
    mode,
  };

  if (mode === "cool") {
    params.temp = form.querySelector('[name="temp"]').value;
    params.fan_speed = form.querySelector('[name="fan_speed"]').value;
    if (featuresOf(room).quiet) params.quiet = toggleParam("quiet");
  } else if (mode === "fan") {
    params.fan_speed = form.querySelector('[name="fan_speed"]').value;
    params.quiet = "off";
    params.comfort = "off";
    params.economy = "off";
  } else if (mode === "dry") {
    params.quiet = "off";
    params.fan_speed = "auto";
  }

  if (mode === "cool" || mode === "dry") {
    if (featuresOf(room).comfortEconomy) {
      params.comfort = toggleParam("comfort");
      params.economy = toggleParam("economy");
    }
  }

  return params;
}

function captureFormValues() {
  const quiet = form.querySelector('[name="quiet"]');
  const comfort = form.querySelector('[name="comfort"]');
  const economy = form.querySelector('[name="economy"]');
  return {
    power: form.querySelector('[name="power"]').checked,
    temp: Number(form.querySelector('[name="temp"]').value),
    mode: currentMode(),
    fan_speed: form.querySelector('[name="fan_speed"]').value,
    quiet: quiet ? quiet.checked : false,
    comfort: comfort ? comfort.checked : false,
    economy: economy ? economy.checked : false,
  };
}

function clearToggle(name, labelSelector) {
  const input = form.querySelector(`[name="${name}"]`);
  const label = form.querySelector(labelSelector);
  if (input?.checked) {
    input.checked = false;
    if (label) label.textContent = "Off";
  }
}

function syncFormLocks() {
  const powerOn = form.querySelector('[name="power"]').checked;
  const mode = currentMode();
  const comfortOn = Boolean(form.querySelector('[name="comfort"]')?.checked);
  const tempOk = powerOn && mode === "cool";
  const fanOk = powerOn && mode !== "dry" && !comfortOn;
  const quietOk = powerOn && mode === "cool";
  const extrasOk = powerOn && (mode === "cool" || mode === "dry");

  form.classList.toggle("is-off", !powerOn);
  form.classList.toggle("is-temp-locked", !tempOk);
  form.classList.toggle("is-fan-locked", !fanOk);
  form.classList.toggle("is-quiet-locked", !quietOk);
  form.classList.toggle("is-extras-locked", !extrasOk);

  form.querySelectorAll(".depends-on-power").forEach((el) => {
    if ("disabled" in el) el.disabled = !powerOn;
  });

  form.querySelectorAll(".depends-on-cool").forEach((el) => {
    if ("disabled" in el) el.disabled = !tempOk;
  });

  form.querySelectorAll(".depends-on-fan").forEach((el) => {
    if ("disabled" in el) el.disabled = !fanOk;
  });

  form.querySelectorAll(".depends-on-quiet").forEach((el) => {
    if ("disabled" in el) el.disabled = !quietOk;
  });

  form.querySelectorAll(".depends-on-extras").forEach((el) => {
    if ("disabled" in el) el.disabled = !extrasOk;
  });

  // Info buttons are never disabled
  form.querySelectorAll(".info-btn").forEach((el) => {
    el.disabled = false;
  });

  if (!quietOk) clearToggle("quiet", ".quiet-label");
  if (!extrasOk) {
    clearToggle("comfort", ".comfort-label");
    clearToggle("economy", ".economy-label");
    restoreFanAfterAutoLock();
  }
}

function setTemp(value) {
  const temp = Math.min(TEMP_MAX, Math.max(TEMP_MIN, Number(value)));
  form.querySelector('[name="temp"]').value = String(temp);
  form.querySelector(".temp-display").textContent = `${temp}`;
  form.querySelector(".temp-thumb").style.left = `${((temp - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * 100}%`;
}

function setFan(value) {
  form.querySelector('[name="fan_speed"]').value = value;
  form.querySelectorAll(".fan-option").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.value === value);
  });
}

function fanForcedAuto() {
  return (
    currentMode() === "dry" ||
    Boolean(form.querySelector('[name="comfort"]')?.checked)
  );
}

function rememberFanBeforeAutoLock() {
  const current = form.querySelector('[name="fan_speed"]').value;
  if (roomState[activeId].fanBeforeAutoLock == null) {
    roomState[activeId].fanBeforeAutoLock = current;
  }
  setFan("auto");
}

function restoreFanAfterAutoLock() {
  if (fanForcedAuto()) return;
  const prev = roomState[activeId].fanBeforeAutoLock;
  roomState[activeId].fanBeforeAutoLock = null;
  if (prev) setFan(prev);
}

function setMode(mode) {
  const radio = form.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  syncFormLocks();
}

function applyToggle(name, on, labelSelector) {
  const input = form.querySelector(`[name="${name}"]`);
  if (!input) return;
  input.checked = on;
  const label = form.querySelector(labelSelector);
  if (label) label.textContent = on ? "On" : "Off";
}

function applyValues(values) {
  const room = activeRoom();
  let fanSpeed = values.fan_speed;
  if (fanSpeed === "night" && !featuresOf(room).night) fanSpeed = "1";
  if (values.comfort || values.mode === "dry") fanSpeed = "auto";

  form.querySelector('[name="power"]').checked = values.power;
  form.querySelector(".power-label").textContent = values.power ? "On" : "Off";
  setTemp(values.temp);
  setMode(values.mode);
  setFan(fanSpeed);

  applyToggle("quiet", values.quiet, ".quiet-label");
  applyToggle("comfort", values.comfort, ".comfort-label");
  applyToggle("economy", values.economy, ".economy-label");

  if (!(values.comfort || values.mode === "dry")) {
    roomState[activeId].fanBeforeAutoLock = null;
  }

  syncFormLocks();
  syncBusyUi();
}

function populateFromApi(state, roomId = activeId) {
  const values = stateToValues(state);
  roomState[roomId].values = values;
  if (roomId === activeId) applyValues(values);
}

function buildFanBars(supportsNight) {
  const auto = `
    <button type="button" class="fan-option fan-option--icon depends-on-power depends-on-fan" data-value="auto" aria-label="Auto fan" title="Auto">
      ${icon("hdr_auto")}
    </button>`;

  const bars = FAN_LEVELS.map(
    (level, i) => `
      <button type="button" class="fan-option fan-option--bar depends-on-power depends-on-fan" data-value="${level}" aria-label="Fan speed ${level}">
        <span class="fan-bar" style="--bar-h: ${20 + i * 16}%"></span>
      </button>`
  ).join("");

  const night = supportsNight
    ? `<button type="button" class="fan-option fan-option--icon depends-on-power depends-on-fan" data-value="night" aria-label="Night fan" title="Night">
        ${icon("bedtime")}
      </button>`
    : "";

  return `${auto}<div class="fan-bars">${bars}</div>${night}`;
}

function buildToggleRow({ name, label, tip, lockClass }) {
  const info = tip
    ? `<span class="field-label">
        <span class="field-label-main">
          <span class="field-label-text">${label}</span>
          <button type="button" class="info-btn" aria-label="About ${label}" aria-expanded="false">
            ${icon("info")}
          </button>
        </span>
        <span class="info-tip" role="tooltip">${tip}</span>
      </span>`
    : `<span>${label}</span>`;

  return `<div class="field field--row depends-on-power-group ${lockClass}">
      ${info}
      <label class="toggle-switch">
        <input type="checkbox" name="${name}" value="on" class="depends-on-power ${lockClass.replace("-group", "")}" />
        <span class="toggle-track"><span class="toggle-knob"></span></span>
        <span class="${name}-label">Off</span>
      </label>
    </div>`;
}

function bindToggleLabel(name) {
  const input = form.querySelector(`[name="${name}"]`);
  const label = form.querySelector(`.${name}-label`);
  if (!input || !label || input.dataset.labelBound) return;
  input.dataset.labelBound = "1";
  input.addEventListener("change", () => {
    label.textContent = input.checked ? "On" : "Off";
  });
}

function bindInfoTips(root) {
  if (!root) return;
  root.querySelectorAll(".field-label").forEach((wrap) => {
    const btn = wrap.querySelector(".info-btn");
    if (!btn || btn.dataset.tipBound) return;
    btn.dataset.tipBound = "1";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = wrap.classList.contains("is-tip-open");
      form.querySelectorAll(".field-label.is-tip-open").forEach((el) => {
        el.classList.remove("is-tip-open");
        el.querySelector(".info-btn")?.setAttribute("aria-expanded", "false");
      });
      if (!open) {
        wrap.classList.add("is-tip-open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });
}

function wireExtrasControls() {
  const extrasSlot = form.querySelector(".extras-slot");
  bindToggleLabel("quiet");
  bindToggleLabel("comfort");
  bindToggleLabel("economy");
  bindInfoTips(extrasSlot);

  const comfortInput = form.querySelector('[name="comfort"]');
  if (comfortInput && !comfortInput.dataset.comfortBound) {
    comfortInput.dataset.comfortBound = "1";
    comfortInput.addEventListener("change", () => {
      if (comfortInput.checked) rememberFanBeforeAutoLock();
      else restoreFanAfterAutoLock();
      syncFormLocks();
    });
  }
}

function featuresKey(features) {
  return `${features.quiet}|${features.night}|${features.comfortEconomy}`;
}

function renderRoomExtras(room) {
  const features = featuresOf(room);
  const key = featuresKey(features);

  // Avoid rewriting DOM when controls already match (prevents load flash).
  if (key !== extrasKey) {
    extrasKey = key;
    form.querySelector(".fan-picker").innerHTML = buildFanBars(features.night);

    const parts = [];
    if (features.quiet) {
      parts.push(
        buildToggleRow({
          name: "quiet",
          label: "Quiet",
          tip: null,
          lockClass: "depends-on-quiet-group",
        })
      );
    }
    if (features.comfortEconomy) {
      parts.push(
        buildToggleRow({
          name: "comfort",
          label: "Comfort",
          tip: "Aims airflow up, away from people. Locks fan to Auto.",
          lockClass: "depends-on-extras-group",
        })
      );
      parts.push(
        buildToggleRow({
          name: "economy",
          label: "Economy",
          tip: "Limits power use. Should be used for long runs.",
          lockClass: "depends-on-extras-group",
        })
      );
    }

    const extrasSlot = form.querySelector(".extras-slot");
    if (extrasSlot) extrasSlot.innerHTML = parts.join("");
  }

  wireExtrasControls();
}

function switchRoom(id) {
  if (id === activeId) return;

  roomState[activeId].values = captureFormValues();
  activeId = id;
  persistActiveRoom(id);
  const room = activeRoom();

  panel.style.setProperty("--accent", room.accent);
  panel.querySelectorAll(".room-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.roomId === id);
    tab.setAttribute("aria-selected", String(tab.dataset.roomId === id));
  });
  setRoomOnline(id, roomState[id].online);
  renderRoomExtras(room);
  applyValues(roomState[id].values);
  loadState({ silent: roomState[id].online === true, roomId: id });
}

async function loadState({ silent = false, roomId = activeId } = {}) {
  const requestedId = roomId;
  const state = roomState[requestedId];
  if (!state || state.loadingGet) return;

  state.loadingGet = true;
  if (requestedId === activeId) syncBusyUi();

  try {
    const remote = await fetchGet(requestedId);
    populateFromApi(remote, requestedId);
    setRoomOnline(requestedId, true);
    if (!silent && requestedId === activeId) showToast("State loaded", "success");
  } catch (err) {
    setRoomOnline(requestedId, false);
    if (requestedId === activeId) {
      applyValues(roomState[requestedId].values);
      if (!silent) showToast(err.message, "error");
    }
  } finally {
    state.loadingGet = false;
    if (requestedId === activeId) syncBusyUi();
  }
}

async function sendState() {
  if (roomState[activeId].online !== true || roomState[activeId].loadingGet) return;
  if (roomState[activeId].sending) return;

  const requestedId = activeId;
  roomState[requestedId].sending = true;
  syncBusyUi();
  try {
    const params = readForm();
    const state = await fetchSet(requestedId, params);
    populateFromApi(state, requestedId);
    setRoomOnline(requestedId, true);
    if (requestedId === activeId) showToast("Command sent", "success");
  } catch (err) {
    setRoomOnline(requestedId, false);
    if (requestedId === activeId) showToast(err.message, "error");
  } finally {
    roomState[requestedId].sending = false;
    if (requestedId === activeId) syncBusyUi();
  }
}

function bindPanel() {
  panel = document.querySelector("#app .panel");
  form = panel.querySelector(".card-form");
  const room = activeRoom();

  panel.style.setProperty("--accent", room.accent);
  panel.querySelectorAll(".room-tab").forEach((tab) => {
    const selected = tab.dataset.roomId === activeId;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
  });

  panel.querySelectorAll(".room-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchRoom(tab.dataset.roomId));
  });

  form.querySelector('[name="power"]').addEventListener("change", (event) => {
    form.querySelector(".power-label").textContent = event.target.checked ? "On" : "Off";
    syncFormLocks();
  });

  form.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (fanForcedAuto()) rememberFanBeforeAutoLock();
      else restoreFanAfterAutoLock();
      syncFormLocks();
    });
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest(".field-label")) return;
    form.querySelectorAll(".field-label.is-tip-open").forEach((el) => {
      el.classList.remove("is-tip-open");
      el.querySelector(".info-btn")?.setAttribute("aria-expanded", "false");
    });
  });

  form.querySelector(".temp-down").addEventListener("click", () => {
    if (form.classList.contains("is-temp-locked") || form.classList.contains("is-off")) return;
    setTemp(Number(form.querySelector('[name="temp"]').value) - 1);
  });
  form.querySelector(".temp-up").addEventListener("click", () => {
    if (form.classList.contains("is-temp-locked") || form.classList.contains("is-off")) return;
    setTemp(Number(form.querySelector('[name="temp"]').value) + 1);
  });

  const scale = form.querySelector(".temp-scale");
  const setTempFromClientX = (clientX) => {
    const rect = scale.querySelector(".temp-track").getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setTemp(Math.round(TEMP_MIN + ratio * (TEMP_MAX - TEMP_MIN)));
  };

  scale.addEventListener("pointerdown", (event) => {
    if (form.classList.contains("is-off") || form.classList.contains("is-temp-locked")) return;
    scale.setPointerCapture(event.pointerId);
    setTempFromClientX(event.clientX);
  });
  scale.addEventListener("pointermove", (event) => {
    if (!scale.hasPointerCapture(event.pointerId)) return;
    setTempFromClientX(event.clientX);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendState();
  });

  form.querySelector(".refresh-btn").addEventListener("click", () => loadState());

  // Fan buttons: delegate so rebuilds don't need re-binding each click target.
  form.querySelector(".fan-picker").addEventListener("click", (event) => {
    const btn = event.target.closest(".fan-option");
    if (!btn || btn.disabled) return;
    setFan(btn.dataset.value);
  });

  renderRoomExtras(room);
  applyValues(roomState[activeId].values);
  syncBusyUi();
}

async function init() {
  AIRCONS = getAircons();
  initRoomState(AIRCONS);
  activeId = resolveInitialRoomId();
  persistActiveRoom(activeId);

  try {
    bindPanel();
    updateTabIndicators();
  } catch (err) {
    console.error(err);
    document.getElementById("app").innerHTML =
      `<p class="toast toast--error">${err.message || err}</p>`;
    return;
  }

  try {
    await ensureToken();
  } catch (err) {
    booting = false;
    showToast(err.message, "error");
    AIRCONS.forEach((room) => setRoomOnline(room.id, false));
    syncBusyUi();
    return;
  }

  booting = false;
  AIRCONS.forEach((room) => {
    loadState({ silent: true, roomId: room.id });
  });
}

init();
