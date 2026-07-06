window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installCaveCombatPauseModule = function installCaveCombatPauseModule(bot) {
  if (!bot || bot.caveCombatPause?.destroy) {
    return bot?.caveCombatPause;
  }

  const configStorageKey = "k9x.caveCombatPause.config";
  const state = {
    running: false,
    timerId: null,
    pausedByGuard: false,
    pausedAt: 0,
    lastMonsterSeenAt: 0,
    lastCombatSeenAt: 0,
    lastAttackKickAt: 0,
    lastResumeAt: 0,
  };

  const storedConfig = bot.storage.get(configStorageKey, {}) || {};
  const config = Object.assign(
    {
      enabled: true,
      tickMs: 250,
      clearDelayMs: 1200,
      kickAttackMs: 600,
      requireAttackEnabled: true,
      respectTargetFilters: true,
    },
    storedConfig
  );

  config.enabled = config.enabled !== false;
  config.tickMs = normalizePositiveInteger(config.tickMs, 250);
  config.clearDelayMs = normalizePositiveInteger(config.clearDelayMs, 1200);
  config.kickAttackMs = normalizePositiveInteger(config.kickAttackMs, 600);
  config.requireAttackEnabled = config.requireAttackEnabled !== false;
  config.respectTargetFilters = config.respectTargetFilters !== false;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizePositiveInteger(value, fallback) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeCreatureName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function shouldCountMonster(monster) {
    if (!monster) {
      return false;
    }

    if (!config.respectTargetFilters) {
      return true;
    }

    const attackConfig = bot.attack?.config || {};
    const mode = attackConfig.targetFilterMode === "include" || attackConfig.targetFilterMode === "exclude"
      ? attackConfig.targetFilterMode
      : "all";
    const monsterName = normalizeCreatureName(monster.name || "Mob");
    const includedNames = new Set((attackConfig.includedCreatureNames || []).map(normalizeCreatureName));
    const excludedNames = new Set((attackConfig.excludedCreatureNames || []).map(normalizeCreatureName));

    if (mode === "include") {
      if (!includedNames.size) {
        return true;
      }
      return includedNames.has(monsterName) && !excludedNames.has(monsterName);
    }

    if (mode === "exclude") {
      return !excludedNames.has(monsterName);
    }

    return !excludedNames.has(monsterName);
  }

  function getVisibleMonsters() {
    return (bot.xray?.getVisibleMonsters?.({ sameFloorOnly: true }) || []).filter(shouldCountMonster);
  }

  function isAttackUsable(attackStatus) {
    if (!config.requireAttackEnabled) {
      return true;
    }

    return !!attackStatus?.running || !!attackStatus?.config?.enabled;
  }

  function kickAttack(now = Date.now()) {
    if (now - state.lastAttackKickAt < config.kickAttackMs) {
      return false;
    }

    state.lastAttackKickAt = now;

    try {
      if (typeof bot.attack?.tryAttack === "function") {
        return !!bot.attack.tryAttack();
      }
      if (typeof bot.attack?.triggerAttack === "function") {
        return !!bot.attack.triggerAttack(now);
      }
    } catch (error) {
      bot.log("cave combat pause attack kick failed", error?.message || error);
    }

    return false;
  }

  function pauseCaveForCombat(reason, monsters, attackStatus, now = Date.now()) {
    if (state.pausedByGuard) {
      return true;
    }

    const caveStatus = bot.cave?.status?.();
    if (!caveStatus?.running) {
      return false;
    }

    state.pausedByGuard = true;
    state.pausedAt = now;
    bot.cave.stop?.({ persistEnabled: false });
    bot.log("cave paused until monsters are clear", {
      reason,
      visibleMonsters: monsters.map((monster) => monster.name || "Mob"),
      combatActive: !!attackStatus?.combatActive,
      targetCount: Number(attackStatus?.targetCount || 0),
    });
    return true;
  }

  function resumeCaveAfterCombat(now = Date.now()) {
    if (!state.pausedByGuard) {
      return false;
    }

    const lastDangerAt = Math.max(state.lastMonsterSeenAt, state.lastCombatSeenAt);
    if (now - lastDangerAt < config.clearDelayMs) {
      return false;
    }

    state.pausedByGuard = false;
    state.pausedAt = 0;
    state.lastResumeAt = now;
    bot.cave.start?.();
    bot.log("cave resumed after monsters cleared");
    return true;
  }

  function check() {
    if (!config.enabled || !state.running) {
      return;
    }

    const now = Date.now();
    const attackStatus = bot.attack?.status?.() || null;
    const monsters = getVisibleMonsters();
    const combatActive = !!attackStatus?.combatActive || Number(attackStatus?.targetCount || 0) > 0;
    const dangerActive = monsters.length > 0 || combatActive;

    if (monsters.length > 0) {
      state.lastMonsterSeenAt = now;
    }
    if (combatActive) {
      state.lastCombatSeenAt = now;
    }

    if (dangerActive && isAttackUsable(attackStatus)) {
      pauseCaveForCombat(monsters.length ? "visible monsters" : "active combat", monsters, attackStatus, now);
      kickAttack(now);
      return;
    }

    resumeCaveAfterCombat(now);
  }

  function scheduleNextTick() {
    if (!state.running) {
      return;
    }

    state.timerId = window.setTimeout(() => {
      try {
        check();
      } catch (error) {
        bot.log("cave combat pause tick failed", error?.message || error);
      } finally {
        scheduleNextTick();
      }
    }, config.tickMs);
  }

  function start(overrides = {}) {
    updateConfig(Object.assign({}, overrides, { enabled: true }), { silent: true });

    if (state.running) {
      bot.log("cave combat pause already running");
      return false;
    }

    state.running = true;
    bot.log("cave combat pause started", { ...config });
    check();
    scheduleNextTick();
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

    if (state.pausedByGuard) {
      state.pausedByGuard = false;
      state.pausedAt = 0;
    }

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }

    bot.log("cave combat pause stopped");
    refreshUiValues();
    return true;
  }

  function status() {
    return {
      running: state.running,
      config: { ...config },
      pausedByGuard: state.pausedByGuard,
      pausedAt: state.pausedAt,
      lastMonsterSeenAt: state.lastMonsterSeenAt,
      lastCombatSeenAt: state.lastCombatSeenAt,
      visibleMonsterCount: getVisibleMonsters().length,
    };
  }

  function updateConfig(nextConfig = {}, options = {}) {
    const normalized = { ...nextConfig };

    if (Object.prototype.hasOwnProperty.call(normalized, "enabled")) {
      normalized.enabled = normalized.enabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "tickMs")) {
      normalized.tickMs = normalizePositiveInteger(normalized.tickMs, config.tickMs || 250);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "clearDelayMs")) {
      normalized.clearDelayMs = normalizePositiveInteger(normalized.clearDelayMs, config.clearDelayMs || 1200);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "kickAttackMs")) {
      normalized.kickAttackMs = normalizePositiveInteger(normalized.kickAttackMs, config.kickAttackMs || 600);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "requireAttackEnabled")) {
      normalized.requireAttackEnabled = normalized.requireAttackEnabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "respectTargetFilters")) {
      normalized.respectTargetFilters = normalized.respectTargetFilters !== false;
    }

    Object.assign(config, normalized);
    persistConfig();

    if (!options.silent) {
      bot.log("cave combat pause config updated", { ...config });
      refreshUiValues();
    }

    return { ...config };
  }

  function ensureUi() {
    const panel = document.getElementById("k9x-panel");
    if (!panel || document.getElementById("k9x-cave-combat-pause-section")) {
      return;
    }

    const sideColumn = panel.querySelector(".mb-cave-column") || panel.querySelector(".mb-main-column") || panel.querySelector(".mb-body") || panel;
    const section = document.createElement("div");
    section.className = "mb-section mb-column-section";
    section.id = "k9x-cave-combat-pause-section";
    section.innerHTML = `
      <div class="mb-label">Cave Combat Pause</div>
      <div class="mb-stack">
        <label class="mb-toggle">
          <input type="checkbox" id="k9x-cave-combat-pause-enabled" />
          <span>Pause cavebot until monsters are dead</span>
        </label>
        <div class="mb-small-note" id="k9x-cave-combat-pause-status">Combat pause: watching</div>
      </div>
    `;
    sideColumn.appendChild(section);

    const enabledInput = section.querySelector("#k9x-cave-combat-pause-enabled");
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
    const enabledInput = document.getElementById("k9x-cave-combat-pause-enabled");
    const statusLabel = document.getElementById("k9x-cave-combat-pause-status");
    const currentStatus = status();

    if (enabledInput) {
      enabledInput.checked = !!state.running;
    }

    if (statusLabel) {
      if (!state.running) {
        statusLabel.textContent = "Combat pause: off";
      } else if (state.pausedByGuard) {
        statusLabel.textContent = `Combat pause: paused (${currentStatus.visibleMonsterCount} monsters)`;
      } else {
        statusLabel.textContent = "Combat pause: watching";
      }
    }
  }

  function destroy() {
    stop({ persistEnabled: false });
    document.getElementById("k9x-cave-combat-pause-section")?.remove();
  }

  bot.caveCombatPause = {
    start,
    stop,
    status,
    updateConfig,
    check,
    destroy,
    config,
  };

  window.setTimeout(() => {
    ensureUi();
    refreshUiValues();
  }, 1000);

  bot.addCleanup(destroy);

  if (config.enabled) {
    start();
  } else {
    ensureUi();
  }

  return bot.caveCombatPause;
};
