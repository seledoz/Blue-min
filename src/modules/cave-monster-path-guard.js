window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installCaveMonsterPathGuardModule = function installCaveMonsterPathGuardModule(bot) {
  if (!bot || bot.caveMonsterPathGuard?.destroy) {
    return bot?.caveMonsterPathGuard;
  }

  const configStorageKey = "k9x.caveMonsterPathGuard.config";
  const state = {
    installed: false,
    originalFindPath: null,
    lastBlockedAt: 0,
    blockedCount: 0,
    lastMonsterCount: 0,
  };

  const config = Object.assign(
    {
      enabled: true,
      requireAutoAttackEnabled: true,
    },
    bot.storage.get(configStorageKey, {}) || {}
  );

  config.enabled = config.enabled !== false;
  config.requireAutoAttackEnabled = config.requireAutoAttackEnabled !== false;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizePosition(value) {
    if (!value) {
      return null;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }

    return {
      x: Math.trunc(x),
      y: Math.trunc(y),
      z: Math.trunc(z),
    };
  }

  function isSamePosition(left, right) {
    const a = normalizePosition(left);
    const b = normalizePosition(right);
    return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
  }

  function normalizeCreatureName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function shouldCountMonster(monster) {
    if (!monster) {
      return false;
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

  function getVisibleTargetableMonsters() {
    return (bot.xray?.getVisibleMonsters?.({ sameFloorOnly: true }) || []).filter(shouldCountMonster);
  }

  function autoAttackIsReady() {
    if (!config.requireAutoAttackEnabled) {
      return true;
    }

    const attackStatus = bot.attack?.status?.() || null;
    return !!attackStatus?.running || !!attackStatus?.config?.enabled;
  }

  function shouldBlockCavePath(to) {
    if (!config.enabled || !autoAttackIsReady()) {
      return false;
    }

    const caveStatus = bot.cave?.status?.() || null;
    if (!caveStatus?.running || !caveStatus?.currentWaypoint) {
      return false;
    }

    if (!isSamePosition(to, caveStatus.currentWaypoint)) {
      return false;
    }

    const monsters = getVisibleTargetableMonsters();
    state.lastMonsterCount = monsters.length;
    return monsters.length > 0;
  }

  function blockPath() {
    state.lastBlockedAt = Date.now();
    state.blockedCount += 1;

    if (state.blockedCount === 1 || state.blockedCount % 10 === 0) {
      bot.log("cave waypoint movement blocked until visible monsters are killed", {
        blockedCount: state.blockedCount,
        visibleMonsterCount: state.lastMonsterCount,
      });
    }

    return null;
  }

  function install() {
    const pathfinder = window.gameClient?.world?.pathfinder;
    if (!pathfinder || typeof pathfinder.findPath !== "function") {
      return false;
    }

    if (state.installed) {
      return true;
    }

    state.originalFindPath = pathfinder.findPath.bind(pathfinder);
    pathfinder.findPath = function guardedFindPath(from, to, ...args) {
      if (shouldBlockCavePath(to)) {
        return blockPath();
      }

      return state.originalFindPath(from, to, ...args);
    };

    state.installed = true;
    return true;
  }

  function uninstall() {
    const pathfinder = window.gameClient?.world?.pathfinder;
    if (state.installed && pathfinder && state.originalFindPath) {
      pathfinder.findPath = state.originalFindPath;
    }
    state.installed = false;
    state.originalFindPath = null;
  }

  function updateConfig(nextConfig = {}) {
    if (Object.prototype.hasOwnProperty.call(nextConfig, "enabled")) {
      nextConfig.enabled = nextConfig.enabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(nextConfig, "requireAutoAttackEnabled")) {
      nextConfig.requireAutoAttackEnabled = nextConfig.requireAutoAttackEnabled !== false;
    }

    Object.assign(config, nextConfig);
    persistConfig();
    return { ...config };
  }

  function status() {
    return {
      installed: state.installed,
      config: { ...config },
      lastBlockedAt: state.lastBlockedAt,
      blockedCount: state.blockedCount,
      visibleMonsterCount: getVisibleTargetableMonsters().length,
      lastMonsterCount: state.lastMonsterCount,
    };
  }

  function destroy() {
    uninstall();
  }

  bot.caveMonsterPathGuard = {
    install,
    uninstall,
    status,
    updateConfig,
    destroy,
    config,
  };

  install();
  bot.addCleanup(destroy);
  return bot.caveMonsterPathGuard;
};
