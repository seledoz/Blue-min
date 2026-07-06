window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installCaveSmartPathModule = function installCaveSmartPathModule(bot) {
  if (!bot || bot.caveSmartPath?.destroy) {
    return bot?.caveSmartPath;
  }

  const configStorageKey = "k9x.caveSmartPath.config";
  const PATHFINDER_CONFIG = {
    pathCacheTTL: 2000,
    matrixCacheTTL: 2000,
  };
  const pathCache = new Map();
  const matrixCache = new Map();
  const state = {
    installed: false,
    originalFindPath: null,
    lastSmartPathAt: 0,
    lastPathLength: 0,
    lastTargetTile: null,
    lastError: null,
    lastBlockedCavePathAt: 0,
    blockedCavePathCount: 0,
  };

  const config = Object.assign(
    {
      enabled: true,
      minDistance: 8,
      viewportDx: 8,
      viewportDy: 6,
      useOnlyForCave: true,
      pauseCavePathWhileTargeting: true,
    },
    bot.storage.get(configStorageKey, {}) || {}
  );

  config.enabled = config.enabled !== false;
  config.minDistance = normalizePositiveInteger(config.minDistance, 8);
  config.viewportDx = normalizePositiveInteger(config.viewportDx, 8);
  config.viewportDy = normalizePositiveInteger(config.viewportDy, 6);
  config.useOnlyForCave = config.useOnlyForCave !== false;
  config.pauseCavePathWhileTargeting = config.pauseCavePathWhileTargeting !== false;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizePositiveInteger(value, fallback) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
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

  function getDistance(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.abs(Number(from.x) - Number(to.x)) + Math.abs(Number(from.y) - Number(to.y));
  }

  function findBestIndex(openSet) {
    let bestIndex = 0;
    let bestF = openSet[0].f;
    for (let index = 1; index < openSet.length; index += 1) {
      if (openSet[index].f < bestF) {
        bestF = openSet[index].f;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  function aStarPath(start, goal, getWalkable, getNeighbors, tolerance = 0) {
    const startZ = start.z;
    const openSet = [{ x: start.x, y: start.y, z: startZ, f: 0, g: 0, h: 0, parent: null }];
    const closedSet = new Set();
    const key = (position) => `${position.x},${position.y}`;

    while (openSet.length > 0) {
      const bestIndex = findBestIndex(openSet);
      const current = openSet[bestIndex];
      openSet[bestIndex] = openSet[openSet.length - 1];
      openSet.pop();
      const currentKey = key(current);

      if (Math.abs(current.x - goal.x) + Math.abs(current.y - goal.y) <= tolerance) {
        const path = [];
        let node = current;
        while (node) {
          path.unshift({ x: node.x, y: node.y, z: node.z });
          node = node.parent;
        }
        return path;
      }

      closedSet.add(currentKey);

      for (const neighbor of getNeighbors(current)) {
        const neighborKey = key(neighbor);
        if (closedSet.has(neighborKey)) {
          continue;
        }
        if (!getWalkable(neighbor.x, neighbor.y)) {
          continue;
        }

        const g = current.g + 1;
        const h = Math.abs(neighbor.x - goal.x) + Math.abs(neighbor.y - goal.y);
        const f = g + h;
        const existing = openSet.find((node) => node.x === neighbor.x && node.y === neighbor.y);

        if (existing) {
          if (g < existing.g) {
            existing.g = g;
            existing.f = f;
            existing.parent = current;
          }
        } else {
          openSet.push({ x: neighbor.x, y: neighbor.y, z: startZ, f, g, h, parent: current });
        }
      }
    }

    return null;
  }

  function getAStarWalkabilityMatrix(z) {
    const cacheKey = `matrix_${z}`;
    const cached = matrixCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PATHFINDER_CONFIG.matrixCacheTTL) {
      return cached.matrix;
    }

    const chunks = window.gameClient?.world?.chunks || [];
    const matrix = new Map();
    try {
      for (const chunk of chunks) {
        if (!chunk?.tiles) {
          continue;
        }
        for (const tile of chunk.tiles) {
          if (!tile?.__position || tile.__position.z !== z) {
            continue;
          }
          matrix.set(`${tile.__position.x},${tile.__position.y}`, tile.isWalkable ? tile.isWalkable() : false);
        }
      }
    } catch (error) {
      state.lastError = error?.message || String(error);
      return matrix;
    }

    matrixCache.set(cacheKey, { matrix, at: Date.now() });
    return matrix;
  }

  function getAStarNeighbors(current, matrix) {
    const directions = [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
    ];

    return directions
      .map((direction) => ({ x: current.x + direction.x, y: current.y + direction.y }))
      .filter((neighbor) => matrix.get(`${neighbor.x},${neighbor.y}`) === true);
  }

  function getCachedPath(from, to) {
    const key = `${from.x},${from.y},${from.z}-${to.x},${to.y},${to.z}`;
    const entry = pathCache.get(key);
    if (entry && Date.now() - entry.at < PATHFINDER_CONFIG.pathCacheTTL) {
      return entry.path;
    }
    return null;
  }

  function setCachedPath(from, to, path) {
    const key = `${from.x},${from.y},${from.z}-${to.x},${to.y},${to.z}`;
    pathCache.set(key, { path, at: Date.now() });
  }

  function findPathAStar(from, to) {
    const fromPosition = normalizePosition(from);
    const toPosition = normalizePosition(to);
    if (!fromPosition || !toPosition) {
      return null;
    }
    if (fromPosition.x === toPosition.x && fromPosition.y === toPosition.y && fromPosition.z === toPosition.z) {
      return [];
    }
    if (fromPosition.z !== toPosition.z) {
      return null;
    }

    const cached = getCachedPath(fromPosition, toPosition);
    if (cached) {
      return cached;
    }

    const matrix = getAStarWalkabilityMatrix(fromPosition.z);
    const tolerance = Math.max(0, Number(bot.cave?.config?.waypointTolerance) || 0);
    const path = aStarPath(
      fromPosition,
      toPosition,
      (x, y) => matrix.get(`${x},${y}`) === true,
      (node) => getAStarNeighbors(node, matrix),
      tolerance
    );

    if (path) {
      setCachedPath(fromPosition, toPosition, path);
    }
    return path;
  }

  function isOnScreen(position, playerPosition) {
    if (!position || !playerPosition) {
      return false;
    }

    return Math.abs(position.x - playerPosition.x) <= config.viewportDx &&
      Math.abs(position.y - playerPosition.y) <= config.viewportDy &&
      position.z === playerPosition.z;
  }

  function filterPathToViewport(path, playerPosition) {
    if (!path || !path.length) {
      return path;
    }

    const onScreen = path.filter((position) => isOnScreen(position, playerPosition));
    if (onScreen.length > 0) {
      return onScreen;
    }

    const extended = path.filter((position) =>
      Math.abs(position.x - playerPosition.x) <= config.viewportDx * 2 &&
      Math.abs(position.y - playerPosition.y) <= config.viewportDy * 2 &&
      position.z === playerPosition.z
    );

    if (extended.length > 0) {
      return [extended[0]];
    }

    return path.slice(0, 1);
  }

  function shouldUseSmartPath(from, to) {
    if (!config.enabled) {
      return false;
    }

    const fromPosition = normalizePosition(from);
    const toPosition = normalizePosition(to);
    if (!fromPosition || !toPosition || fromPosition.z !== toPosition.z) {
      return false;
    }

    if (getDistance(fromPosition, toPosition) < config.minDistance) {
      return false;
    }

    if (config.useOnlyForCave) {
      const caveStatus = bot.cave?.status?.() || null;
      return !!caveStatus?.running;
    }

    return true;
  }

  function getSmartTarget(from, to) {
    const fromPosition = normalizePosition(from);
    const toPosition = normalizePosition(to);
    const path = findPathAStar(fromPosition, toPosition);

    if (!path || !path.length) {
      return null;
    }

    const targetOnScreen = isOnScreen(toPosition, fromPosition);
    let targetTile = null;

    if (targetOnScreen) {
      targetTile = toPosition;
    } else {
      const visiblePath = filterPathToViewport(path, fromPosition);
      if (visiblePath && visiblePath.length > 1) {
        targetTile = visiblePath[visiblePath.length - 1];
      } else if (visiblePath && visiblePath.length === 1) {
        targetTile = visiblePath[0];
      } else {
        targetTile = path[Math.min(config.viewportDx, path.length - 1)];
      }
    }

    if (!targetTile || (targetTile.x === fromPosition.x && targetTile.y === fromPosition.y)) {
      return null;
    }

    return { targetTile, path, targetOnScreen };
  }

  function attackHasActiveTarget() {
    const attackStatus = bot.attack?.status?.() || null;
    return !!attackStatus?.currentTarget || !!attackStatus?.combatActive || Number(attackStatus?.targetCount || 0) > 0;
  }

  function shouldBlockCaveWaypointPath(to) {
    if (!config.pauseCavePathWhileTargeting || !attackHasActiveTarget()) {
      return false;
    }

    const caveStatus = bot.cave?.status?.() || null;
    if (!caveStatus?.running || !caveStatus?.currentWaypoint) {
      return false;
    }

    return isSamePosition(to, caveStatus.currentWaypoint);
  }

  function blockCaveWaypointPath() {
    state.lastBlockedCavePathAt = Date.now();
    state.blockedCavePathCount += 1;
    if (state.blockedCavePathCount === 1 || state.blockedCavePathCount % 10 === 0) {
      bot.log("cave waypoint movement paused while auto attack has a target", {
        blockedCavePathCount: state.blockedCavePathCount,
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

    pathfinder.findPath = function smartFindPath(from, to, ...args) {
      if (shouldBlockCaveWaypointPath(to)) {
        return blockCaveWaypointPath();
      }

      if (shouldUseSmartPath(from, to)) {
        try {
          const smart = getSmartTarget(from, to);
          if (smart?.targetTile) {
            const smartTarget = new Position(smart.targetTile.x, smart.targetTile.y, smart.targetTile.z);
            state.lastSmartPathAt = Date.now();
            state.lastPathLength = smart.path.length;
            state.lastTargetTile = { ...smart.targetTile };
            bot.log("cave smart A* pathing", {
              targetTile: smart.targetTile,
              pathLength: smart.path.length,
              waypointOnScreen: smart.targetOnScreen,
            });
            return state.originalFindPath(from, smartTarget, ...args);
          }
        } catch (error) {
          state.lastError = error?.message || String(error);
          bot.log("cave smart A* failed, falling back", state.lastError);
        }
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

  function cleanupCaches() {
    const now = Date.now();
    for (const [key, entry] of pathCache) {
      if (now - entry.at >= PATHFINDER_CONFIG.pathCacheTTL) {
        pathCache.delete(key);
      }
    }
    for (const [key, entry] of matrixCache) {
      if (now - entry.at >= PATHFINDER_CONFIG.matrixCacheTTL) {
        matrixCache.delete(key);
      }
    }
  }

  function updateConfig(nextConfig = {}) {
    const normalized = { ...nextConfig };

    if (Object.prototype.hasOwnProperty.call(normalized, "enabled")) {
      normalized.enabled = normalized.enabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "minDistance")) {
      normalized.minDistance = normalizePositiveInteger(normalized.minDistance, config.minDistance || 8);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "viewportDx")) {
      normalized.viewportDx = normalizePositiveInteger(normalized.viewportDx, config.viewportDx || 8);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "viewportDy")) {
      normalized.viewportDy = normalizePositiveInteger(normalized.viewportDy, config.viewportDy || 6);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "useOnlyForCave")) {
      normalized.useOnlyForCave = normalized.useOnlyForCave !== false;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "pauseCavePathWhileTargeting")) {
      normalized.pauseCavePathWhileTargeting = normalized.pauseCavePathWhileTargeting !== false;
    }

    Object.assign(config, normalized);
    persistConfig();
    refreshUiValues();
    return { ...config };
  }

  function status() {
    cleanupCaches();
    return {
      installed: state.installed,
      config: { ...config },
      cacheSizes: {
        paths: pathCache.size,
        matrices: matrixCache.size,
      },
      lastSmartPathAt: state.lastSmartPathAt,
      lastPathLength: state.lastPathLength,
      lastTargetTile: state.lastTargetTile ? { ...state.lastTargetTile } : null,
      lastBlockedCavePathAt: state.lastBlockedCavePathAt,
      blockedCavePathCount: state.blockedCavePathCount,
      lastError: state.lastError,
    };
  }

  function ensureUi() {
    const panel = document.getElementById("k9x-panel");
    if (!panel || document.getElementById("k9x-cave-smart-path-section")) {
      return;
    }

    const caveColumn = panel.querySelector(".mb-cave-column") || panel.querySelector(".mb-main-column") || panel.querySelector(".mb-body") || panel;
    const section = document.createElement("div");
    section.className = "mb-section mb-column-section";
    section.id = "k9x-cave-smart-path-section";
    section.innerHTML = `
      <div class="mb-label">Cave Smart Path</div>
      <div class="mb-stack">
        <label class="mb-toggle">
          <input type="checkbox" id="k9x-cave-smart-path-enabled" />
          <span>Use A* smart pathing</span>
        </label>
        <div class="mb-small-note" id="k9x-cave-smart-path-status">Smart path: loading</div>
      </div>
    `;
    caveColumn.appendChild(section);

    const enabledInput = section.querySelector("#k9x-cave-smart-path-enabled");
    enabledInput?.addEventListener("change", () => {
      updateConfig({ enabled: !!enabledInput.checked });
      refreshUiValues();
    });

    refreshUiValues();
  }

  function refreshUiValues() {
    const enabledInput = document.getElementById("k9x-cave-smart-path-enabled");
    const statusLabel = document.getElementById("k9x-cave-smart-path-status");

    if (enabledInput) {
      enabledInput.checked = !!config.enabled;
    }

    if (statusLabel) {
      statusLabel.textContent = config.enabled
        ? `Smart path: on${state.blockedCavePathCount ? ` • combat pause ${state.blockedCavePathCount}` : state.lastPathLength ? ` • last path ${state.lastPathLength} tiles` : ""}`
        : "Smart path: off";
    }
  }

  function destroy() {
    uninstall();
    document.getElementById("k9x-cave-smart-path-section")?.remove();
  }

  bot.caveSmartPath = {
    install,
    uninstall,
    status,
    updateConfig,
    findPathAStar,
    getSmartTarget,
    destroy,
    config,
  };

  install();
  window.setTimeout(() => {
    ensureUi();
    refreshUiValues();
  }, 1000);
  bot.addCleanup(destroy);

  return bot.caveSmartPath;
};
