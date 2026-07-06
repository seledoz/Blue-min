window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installRedTextAlertModule = function installRedTextAlertModule(bot) {
  if (!bot || bot.redTextAlert?.destroy) {
    return bot?.redTextAlert;
  }

  const configStorageKey = "k9x.redTextAlert.config";
  const state = {
    running: false,
    observer: null,
    alertTimerId: null,
    uiTimerId: null,
    alertStartedAt: 0,
    lastBeepAt: 0,
    lastSeenText: "",
    lastSeenAt: 0,
    audioContext: null,
  };

  const storedConfig = bot.storage.get(configStorageKey, {}) || {};
  const config = Object.assign(
    {
      enabled: false,
      beepIntervalMs: 5000,
      alertDurationMs: 30000,
      scanExistingOnStart: false,
    },
    storedConfig
  );

  config.beepIntervalMs = normalizePositiveInteger(config.beepIntervalMs, 5000);
  config.alertDurationMs = normalizePositiveInteger(config.alertDurationMs, 30000);
  config.scanExistingOnStart = !!config.scanExistingOnStart;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizePositiveInteger(value, fallback) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function getAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }

    if (!state.audioContext || state.audioContext.state === "closed") {
      state.audioContext = new AudioContextClass();
    }

    if (state.audioContext.state === "suspended") {
      state.audioContext.resume?.().catch?.(() => {});
    }

    return state.audioContext;
  }

  function beep() {
    const audioContext = getAudioContext();
    if (!audioContext) {
      return false;
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.28);
    return true;
  }

  function normalizeColorValue(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isRedColor(value) {
    const color = normalizeColorValue(value);
    if (!color || color === "transparent" || color === "inherit") {
      return false;
    }

    if (color.includes("red") || color.includes("#f00") || color.includes("#ff0000")) {
      return true;
    }

    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) {
      return false;
    }

    const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
    const [r, g, b, a = 1] = parts;
    if (![r, g, b, a].every(Number.isFinite) || a <= 0.05) {
      return false;
    }

    return r >= 150 && r > g * 1.4 && r > b * 1.4;
  }

  function elementHasRedText(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const candidates = [element, ...Array.from(element.querySelectorAll?.("*") || [])];
    return candidates.some((candidate) => {
      const text = String(candidate.textContent || "").trim();
      if (!text) {
        return false;
      }

      const style = window.getComputedStyle(candidate);
      return isRedColor(style.color) || isRedColor(style.backgroundColor);
    });
  }

  function getNodeText(node) {
    return String(node?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function shouldIgnoreDuplicate(text, now = Date.now()) {
    if (!text) {
      return true;
    }

    if (text === state.lastSeenText && now - state.lastSeenAt < 1500) {
      return true;
    }

    state.lastSeenText = text;
    state.lastSeenAt = now;
    return false;
  }

  function handleRedText(text = "") {
    const now = Date.now();
    if (shouldIgnoreDuplicate(text, now)) {
      return false;
    }

    startAlert(now, text);
    return true;
  }

  function inspectNode(node) {
    if (!config.enabled || !state.running || !node) {
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (parent && elementHasRedText(parent)) {
        return handleRedText(getNodeText(parent));
      }
      return false;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const element = node;
    if (!elementHasRedText(element)) {
      return false;
    }

    return handleRedText(getNodeText(element));
  }

  function startAlert(now = Date.now(), text = "") {
    state.alertStartedAt = now;
    state.lastBeepAt = 0;
    bot.log("red text alert triggered", { text });
    tickAlert();
  }

  function stopAlertTimer() {
    if (state.alertTimerId != null) {
      window.clearTimeout(state.alertTimerId);
      state.alertTimerId = null;
    }
  }

  function tickAlert() {
    stopAlertTimer();

    if (!config.enabled || !state.running || !state.alertStartedAt) {
      return;
    }

    const now = Date.now();
    const durationMs = normalizePositiveInteger(config.alertDurationMs, 30000);
    const intervalMs = normalizePositiveInteger(config.beepIntervalMs, 5000);

    if (now - state.alertStartedAt >= durationMs) {
      state.alertStartedAt = 0;
      refreshUiValues();
      return;
    }

    if (!state.lastBeepAt || now - state.lastBeepAt >= intervalMs) {
      if (beep()) {
        state.lastBeepAt = now;
      }
    }

    const nextDelay = Math.max(250, Math.min(intervalMs, durationMs - (now - state.alertStartedAt)));
    state.alertTimerId = window.setTimeout(tickAlert, nextDelay);
    refreshUiValues();
  }

  function startObserver() {
    stopObserver();

    state.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach(inspectNode);
      });
    });

    state.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  function scanExistingRedText() {
    Array.from(document.body?.querySelectorAll?.("*") || []).some((element) => inspectNode(element));
  }

  function start(overrides = {}) {
    updateConfig(Object.assign({}, overrides, { enabled: true }), { silent: true });

    if (state.running) {
      bot.log("red text alert already running");
      return false;
    }

    state.running = true;
    startObserver();

    if (config.scanExistingOnStart) {
      scanExistingRedText();
    }

    bot.log("red text alert started", { ...config });
    refreshUiValues();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;
    state.alertStartedAt = 0;
    state.lastBeepAt = 0;
    stopObserver();
    stopAlertTimer();

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }

    bot.log("red text alert stopped");
    refreshUiValues();
    return true;
  }

  function status() {
    const now = Date.now();
    const remainingMs = state.alertStartedAt
      ? Math.max(0, normalizePositiveInteger(config.alertDurationMs, 30000) - (now - state.alertStartedAt))
      : 0;

    return {
      running: state.running,
      config: { ...config },
      alertActive: remainingMs > 0,
      remainingMs,
      lastSeenText: state.lastSeenText,
      lastSeenAt: state.lastSeenAt,
      lastBeepAt: state.lastBeepAt,
    };
  }

  function updateConfig(nextConfig = {}, options = {}) {
    const normalized = { ...nextConfig };

    if (Object.prototype.hasOwnProperty.call(normalized, "beepIntervalMs")) {
      normalized.beepIntervalMs = normalizePositiveInteger(normalized.beepIntervalMs, config.beepIntervalMs || 5000);
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "alertDurationMs")) {
      normalized.alertDurationMs = normalizePositiveInteger(normalized.alertDurationMs, config.alertDurationMs || 30000);
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "scanExistingOnStart")) {
      normalized.scanExistingOnStart = !!normalized.scanExistingOnStart;
    }

    Object.assign(config, normalized);
    persistConfig();

    if (!options.silent) {
      bot.log("red text alert config updated", { ...config });
      refreshUiValues();
    }

    return { ...config };
  }

  function ensureUi() {
    const panel = document.getElementById("k9x-panel");
    if (!panel || document.getElementById("k9x-red-text-alert-section")) {
      return;
    }

    const sideColumn = panel.querySelector(".mb-side-column") || panel.querySelector(".mb-main-column") || panel.querySelector(".mb-body") || panel;
    const section = document.createElement("div");
    section.className = "mb-section mb-column-section";
    section.id = "k9x-red-text-alert-section";
    section.innerHTML = `
      <div class="mb-label">Red Text Alert</div>
      <div class="mb-stack">
        <label class="mb-toggle">
          <input type="checkbox" id="k9x-red-text-alert-enabled" />
          <span>Enable Red Text Alert</span>
        </label>
        <div class="mb-small-note" id="k9x-red-text-alert-status">Alert: off</div>
        <div class="mb-small-note">Beeps every 5 seconds for 30 seconds when new red console text appears.</div>
      </div>
    `;
    sideColumn.appendChild(section);

    const enabledInput = section.querySelector("#k9x-red-text-alert-enabled");
    enabledInput?.addEventListener("change", () => {
      if (enabledInput.checked) {
        start();
      } else {
        stop();
      }
      refreshUiValues();
    });

    refreshUiValues();
  }

  function refreshUiValues() {
    const enabledInput = document.getElementById("k9x-red-text-alert-enabled");
    const statusLabel = document.getElementById("k9x-red-text-alert-status");
    const currentStatus = status();

    if (enabledInput) {
      enabledInput.checked = !!state.running;
    }

    if (statusLabel) {
      if (!state.running) {
        statusLabel.textContent = "Alert: off";
      } else if (currentStatus.alertActive) {
        statusLabel.textContent = `Alert: beeping (${Math.ceil(currentStatus.remainingMs / 1000)}s left)`;
      } else {
        statusLabel.textContent = "Alert: watching";
      }
    }
  }

  function destroy() {
    stop({ persistEnabled: false });
    if (state.uiTimerId != null) {
      window.clearInterval(state.uiTimerId);
      state.uiTimerId = null;
    }
    document.getElementById("k9x-red-text-alert-section")?.remove();
  }

  bot.redTextAlert = {
    start,
    stop,
    status,
    updateConfig,
    beep,
    destroy,
    config,
  };

  state.uiTimerId = window.setInterval(() => {
    ensureUi();
    refreshUiValues();
  }, 1000);

  bot.addCleanup(destroy);

  if (config.enabled) {
    start();
  } else {
    ensureUi();
  }

  return bot.redTextAlert;
};

if (window.minibiaBot && !window.minibiaBot.redTextAlert && window.__minibiaBotBundle?.installRedTextAlertModule) {
  window.__minibiaBotBundle.installRedTextAlertModule(window.minibiaBot);
}
