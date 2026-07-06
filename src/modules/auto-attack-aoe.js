window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installAutoAttackAoeModule = function installAutoAttackAoeModule(bot) {
  if (!bot || bot.attackAoe?.destroy) {
    return bot?.attackAoe;
  }

  const configStorageKey = "k9x.attackAoe.config";
  const state = {
    running: false,
    timerId: null,
    uiTimerId: null,
    lastSpellHotkeyAt: 0,
    lastCastMonsterCount: 0,
  };

  const storedConfig = bot.storage.get(configStorageKey, {}) || {};
  const config = Object.assign(
    {
      enabled: false,
      spellHotbarSlot: null,
      minMonsters: 3,
      squareRange: 3,
      cooldownMs: 2000,
      tickMs: 250,
      requireAutoAttackRunning: true,
      respectTargetFilters: true,
    },
    storedConfig
  );

  config.spellHotbarSlot = normalizeHotbarSlot(config.spellHotbarSlot);
  config.minMonsters = normalizePositiveInteger(config.minMonsters, 3);
  config.squareRange = normalizePositiveInteger(config.squareRange, 3);
  config.cooldownMs = normalizeNonNegativeInteger(config.cooldownMs, 2000);
  config.tickMs = normalizePositiveInteger(config.tickMs, 250);
  config.requireAutoAttackRunning = config.requireAutoAttackRunning !== false;
  config.respectTargetFilters = config.respectTargetFilters !== false;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizeHotbarSlot(slot) {
    const value = Number(slot);
    if (!Number.isFinite(value)) {
      return null;
    }

    const normalized = Math.trunc(value);
    return normalized >= 1 && normalized <= 12 ? normalized : null;
  }

  function normalizePositiveInteger(value, fallback) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeNonNegativeInteger(value, fallback) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function normalizeCreatureName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function getCreaturePosition(creature) {
    const rawPosition = creature?.getPosition?.() || creature?.__position || creature?.position;
    if (!rawPosition) {
      return null;
    }

    const x = Number(rawPosition.x);
    const y = Number(rawPosition.y);
    const z = Number(rawPosition.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }

    return {
      x: Math.trunc(x),
      y: Math.trunc(y),
      z: Math.trunc(z),
    };
  }

  function getTileDistance(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.max(
      Math.abs(Number(from.x) - Number(to.x)),
      Math.abs(Number(from.y) - Number(to.y))
    );
  }

  function shouldRespectTargetFilters(creature) {
    if (!config.respectTargetFilters) {
      return true;
    }

    const attackConfig = bot.attack?.config || {};
    const mode = attackConfig.targetFilterMode === "include" || attackConfig.targetFilterMode === "exclude"
      ? attackConfig.targetFilterMode
      : "all";
    const creatureName = normalizeCreatureName(creature?.name || "Mob");
    const includedNames = new Set((attackConfig.includedCreatureNames || []).map(normalizeCreatureName));
    const excludedNames = new Set((attackConfig.excludedCreatureNames || []).map(normalizeCreatureName));

    if (mode === "include") {
      if (!includedNames.size) {
        return true;
      }

      return includedNames.has(creatureName) && !excludedNames.has(creatureName);
    }

    if (mode === "exclude") {
      return !excludedNames.has(creatureName);
    }

    return !excludedNames.has(creatureName);
  }

  function getCandidateMonsters() {
    const playerPosition = bot.getPlayerPosition?.();
    const squareRange = normalizePositiveInteger(config.squareRange, 3);
    if (!playerPosition) {
      return [];
    }

    return (bot.xray?.getVisibleMonsters?.({ sameFloorOnly: true }) || [])
      .filter((monster) => shouldRespectTargetFilters(monster))
      .map((monster) => ({ monster, position: getCreaturePosition(monster) }))
      .filter(({ position }) => position && Number(position.z) === Number(playerPosition.z))
      .filter(({ position }) => getTileDistance(playerPosition, position) <= squareRange)
      .map(({ monster }) => monster);
  }

  function isAutoAttackRunning() {
    if (!config.requireAutoAttackRunning) {
      return true;
    }

    return !!bot.attack?.status?.().running;
  }

  function canCast(now = Date.now()) {
    const slot = normalizeHotbarSlot(config.spellHotbarSlot);
    if (!config.enabled || !state.running || !slot) {
      return false;
    }

    if (!isAutoAttackRunning()) {
      return false;
    }

    if (now - state.lastSpellHotkeyAt < normalizeNonNegativeInteger(config.cooldownMs, 2000)) {
      return false;
    }

    return getCandidateMonsters().length >= normalizePositiveInteger(config.minMonsters, 3);
  }

  function triggerSpell(now = Date.now()) {
    if (!canCast(now)) {
      return false;
    }

    const slot = normalizeHotbarSlot(config.spellHotbarSlot);
    const monsters = getCandidateMonsters();
    const clicked = bot.clickHotbar(slot - 1);
    if (clicked) {
      state.lastSpellHotkeyAt = now;
      state.lastCastMonsterCount = monsters.length;
      bot.log("used auto attack AoE spell hotkey", {
        slot,
        monsterCount: monsters.length,
        minMonsters: normalizePositiveInteger(config.minMonsters, 3),
        squareRange: normalizePositiveInteger(config.squareRange, 3),
        monsters: monsters.map((creature) => creature.name || "Mob"),
      });
    }

    return clicked;
  }

  function scheduleNextTick() {
    if (!state.running) {
      return;
    }

    state.timerId = window.setTimeout(tick, normalizePositiveInteger(config.tickMs, 250));
  }

  function tick() {
    if (!state.running) {
      return;
    }

    try {
      triggerSpell();
    } catch (error) {
      bot.log("auto attack AoE tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  function start(overrides = {}) {
    updateConfig(Object.assign({}, overrides, { enabled: true }), { silent: true });

    if (state.running) {
      bot.log("auto attack AoE already running");
      return false;
    }

    state.running = true;
    bot.log("auto attack AoE started", { ...config });
    tick();
    refreshUiValues();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }

    bot.log("auto attack AoE stopped");
    refreshUiValues();
    return true;
  }

  function status() {
    const nearbyMonsters = getCandidateMonsters();
    return {
      running: state.running,
      config: { ...config },
      lastSpellHotkeyAt: state.lastSpellHotkeyAt,
      lastCastMonsterCount: state.lastCastMonsterCount,
      nearbyMonsterCount: nearbyMonsters.length,
      ready: canCast(Date.now()),
      nearbyMonsters: nearbyMonsters.map((creature) => ({
        id: creature.id,
        name: creature.name,
        type: creature.type,
        position: creature.__position || creature.position || null,
      })),
    };
  }

  function updateConfig(nextConfig = {}, options = {}) {
    const normalized = { ...nextConfig };

    if (Object.prototype.hasOwnProperty.call(normalized, "spellHotbarSlot")) {
      normalized.spellHotbarSlot = normalizeHotbarSlot(normalized.spellHotbarSlot);
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "minMonsters")) {
      normalized.minMonsters = normalizePositiveInteger(normalized.minMonsters, config.minMonsters || 3);
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "squareRange")) {
      normalized.squareRange = normalizePositiveInteger(normalized.squareRange, config.squareRange || 3);
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "cooldownMs")) {
      normalized.cooldownMs = normalizeNonNegativeInteger(normalized.cooldownMs, config.cooldownMs || 2000);
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "tickMs")) {
      normalized.tickMs = normalizePositiveInteger(normalized.tickMs, config.tickMs || 250);
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "requireAutoAttackRunning")) {
      normalized.requireAutoAttackRunning = normalized.requireAutoAttackRunning !== false;
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "respectTargetFilters")) {
      normalized.respectTargetFilters = normalized.respectTargetFilters !== false;
    }

    Object.assign(config, normalized);
    persistConfig();

    if (!options.silent) {
      bot.log("auto attack AoE config updated", { ...config });
      refreshUiValues();
    }

    return { ...config };
  }

  function ensureUi() {
    const panel = document.getElementById("k9x-panel");
    if (!panel || document.getElementById("k9x-auto-attack-aoe-section")) {
      return;
    }

    const attackColumn = panel.querySelector(".mb-talk-column") || panel.querySelector(".mb-body") || panel;
    const section = document.createElement("div");
    section.className = "mb-section mb-column-section";
    section.id = "k9x-auto-attack-aoe-section";
    section.innerHTML = `
      <div class="mb-label">AoE Spell</div>
      <div class="mb-stack">
        <label class="mb-toggle">
          <input type="checkbox" id="k9x-auto-attack-aoe-enabled" />
          <span>Enable AoE Spell</span>
        </label>
        <div class="mb-field-grid">
          <label class="mb-field" for="k9x-auto-attack-aoe-hotkey">
            <span class="mb-field-label">Spell Hotkey (1-12)</span>
            <input type="number" id="k9x-auto-attack-aoe-hotkey" min="1" max="12" placeholder="5" />
          </label>
          <label class="mb-field" for="k9x-auto-attack-aoe-monsters">
            <span class="mb-field-label">Min Monsters</span>
            <input type="number" id="k9x-auto-attack-aoe-monsters" min="1" placeholder="3" />
          </label>
          <label class="mb-field" for="k9x-auto-attack-aoe-range">
            <span class="mb-field-label">Square Range</span>
            <input type="number" id="k9x-auto-attack-aoe-range" min="1" placeholder="3" />
          </label>
          <label class="mb-field" for="k9x-auto-attack-aoe-cooldown">
            <span class="mb-field-label">Cooldown MS</span>
            <input type="number" id="k9x-auto-attack-aoe-cooldown" min="0" placeholder="2000" />
          </label>
        </div>
        <label class="mb-toggle">
          <input type="checkbox" id="k9x-auto-attack-aoe-require-attack" />
          <span>Only while Auto Attack runs</span>
        </label>
        <label class="mb-toggle">
          <input type="checkbox" id="k9x-auto-attack-aoe-respect-filters" />
          <span>Use target filters</span>
        </label>
        <div class="mb-small-note" id="k9x-auto-attack-aoe-status">AoE: idle</div>
      </div>
    `;
    attackColumn.appendChild(section);

    const enabledInput = section.querySelector("#k9x-auto-attack-aoe-enabled");
    const hotkeyInput = section.querySelector("#k9x-auto-attack-aoe-hotkey");
    const monstersInput = section.querySelector("#k9x-auto-attack-aoe-monsters");
    const rangeInput = section.querySelector("#k9x-auto-attack-aoe-range");
    const cooldownInput = section.querySelector("#k9x-auto-attack-aoe-cooldown");
    const requireAttackInput = section.querySelector("#k9x-auto-attack-aoe-require-attack");
    const respectFiltersInput = section.querySelector("#k9x-auto-attack-aoe-respect-filters");

    const readUiConfig = () => ({
      spellHotbarSlot: normalizeHotbarSlot(hotkeyInput?.value),
      minMonsters: normalizePositiveInteger(monstersInput?.value, config.minMonsters || 3),
      squareRange: normalizePositiveInteger(rangeInput?.value, config.squareRange || 3),
      cooldownMs: normalizeNonNegativeInteger(cooldownInput?.value, config.cooldownMs || 2000),
      requireAutoAttackRunning: !!requireAttackInput?.checked,
      respectTargetFilters: !!respectFiltersInput?.checked,
    });

    const saveUiConfig = () => {
      updateConfig(readUiConfig());
      refreshUiValues();
    };

    [hotkeyInput, monstersInput, rangeInput, cooldownInput, requireAttackInput, respectFiltersInput]
      .filter(Boolean)
      .forEach((input) => input.addEventListener("change", saveUiConfig));

    enabledInput?.addEventListener("change", () => {
      const nextConfig = readUiConfig();
      if (enabledInput.checked) {
        start(nextConfig);
      } else {
        stop();
      }
      refreshUiValues();
    });

    refreshUiValues();
  }

  function refreshUiValues() {
    const enabledInput = document.getElementById("k9x-auto-attack-aoe-enabled");
    const hotkeyInput = document.getElementById("k9x-auto-attack-aoe-hotkey");
    const monstersInput = document.getElementById("k9x-auto-attack-aoe-monsters");
    const rangeInput = document.getElementById("k9x-auto-attack-aoe-range");
    const cooldownInput = document.getElementById("k9x-auto-attack-aoe-cooldown");
    const requireAttackInput = document.getElementById("k9x-auto-attack-aoe-require-attack");
    const respectFiltersInput = document.getElementById("k9x-auto-attack-aoe-respect-filters");
    const statusLabel = document.getElementById("k9x-auto-attack-aoe-status");
    const currentStatus = status();

    if (enabledInput) enabledInput.checked = !!state.running;
    if (hotkeyInput) hotkeyInput.value = config.spellHotbarSlot ? String(config.spellHotbarSlot) : "";
    if (monstersInput) monstersInput.value = String(config.minMonsters || 3);
    if (rangeInput) rangeInput.value = String(config.squareRange || 3);
    if (cooldownInput) cooldownInput.value = String(config.cooldownMs ?? 2000);
    if (requireAttackInput) requireAttackInput.checked = config.requireAutoAttackRunning !== false;
    if (respectFiltersInput) respectFiltersInput.checked = config.respectTargetFilters !== false;
    if (statusLabel) {
      statusLabel.textContent = `${state.running ? "AoE: on" : "AoE: off"} • ${currentStatus.nearbyMonsterCount}/${config.minMonsters} monsters within ${config.squareRange} squares`;
    }
  }

  function destroy() {
    stop({ persistEnabled: false });
    if (state.uiTimerId != null) {
      window.clearInterval(state.uiTimerId);
      state.uiTimerId = null;
    }
    document.getElementById("k9x-auto-attack-aoe-section")?.remove();
  }

  bot.attackAoe = {
    start,
    stop,
    status,
    updateConfig,
    triggerSpell,
    canCast,
    getCandidateMonsters,
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

  return bot.attackAoe;
};

if (window.minibiaBot && !window.minibiaBot.attackAoe && window.__minibiaBotBundle?.installAutoAttackAoeModule) {
  window.__minibiaBotBundle.installAutoAttackAoeModule(window.minibiaBot);
}
