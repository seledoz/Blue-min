window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installCaveModule = function installCaveModule(bot) {
  const configStorageKey = "minibiaBot.cave.config";
  const routeStorageKey = "minibiaBot.cave.route";
  const transitionStorageKey = "minibiaBot.cave.transitions";
  const state = {
    running: false,
    timerId: null,
    observerTimerId: null,
    currentIndex: 0,
    direction: 1,
    lastPathAt: 0,
    lastPositionKey: null,
    lastProgressAt: 0,
    lastStairsUseAt: 0,
    lastObservedPosition: null,
    pendingTransitionSource: null,
  };

  const config = Object.assign(
    {
      tickMs: 500,
      repathMs: 1500,
      waypointTolerance: 0,
      enabled: false,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 500;

  let route = normalizeRoute(bot.storage.get(routeStorageKey, []));
  let transitions = normalizeTransitions(bot.storage.get(transitionStorageKey, []));

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function persistRoute() {
    bot.storage.set(routeStorageKey, route.map((waypoint) => ({ ...waypoint })));
  }

  function persistTransitions() {
    bot.storage.set(transitionStorageKey, transitions.map((transition) => cloneValue(transition)));
  }

  function cloneValue(value) {
    return value ? JSON.parse(JSON.stringify(value)) : null;
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

  function normalizeWaypoint(waypoint) {
    return normalizePosition(waypoint);
  }

  function normalizeRoute(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map(normalizeWaypoint).filter(Boolean);
  }

  function normalizeTransition(transition) {
    if (!transition) {
      return null;
    }

    const from = normalizePosition(transition.from || transition);
    const to = normalizePosition(transition.to || {
      x: transition.targetX,
      y: transition.targetY,
      z: transition.targetZ,
    });

    if (!from || !to || from.z === to.z) {
      return null;
    }

    const count = Math.max(1, Math.trunc(Number(transition.count) || 1));
    const lastSeenAt = Math.max(0, Math.trunc(Number(transition.lastSeenAt) || Date.now()));

    return { from, to, count, lastSeenAt };
  }

  function normalizeTransitions(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const deduped = new Map();
    value.map(normalizeTransition).filter(Boolean).forEach((transition) => {
      deduped.set(getPositionKey(transition.from), transition);
    });
    return Array.from(deduped.values());
  }

  function getRoute() {
    return route.map((waypoint) => cloneValue(waypoint));
  }

  function getTransitions() {
    return transitions.map((transition) => cloneValue(transition));
  }

  function getCurrentWaypoint() {
    if (!route.length) {
      return null;
    }

    if (state.currentIndex < 0 || state.currentIndex >= route.length) {
      state.currentIndex = 0;
    }

    return route[state.currentIndex] || null;
  }

  function getPositionKey(position) {
    return position ? `${position.x},${position.y},${position.z}` : null;
  }

  function getDistance(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.abs(Number(from.x) - Number(to.x)) + Math.abs(Number(from.y) - Number(to.y));
  }

  function getDistanceToWaypoint(position, waypoint) {
    if (!position || !waypoint) {
      return null;
    }

    return getDistance(position, waypoint);
  }

  function isSameTile(a, b) {
    if (!a || !b) {
      return false;
    }

    return Number(a.x) === Number(b.x) &&
      Number(a.y) === Number(b.y) &&
      Number(a.z) === Number(b.z);
  }

  function findClosestWaypointIndex(position) {
    if (!position || !route.length) {
      return 0;
    }

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    route.forEach((waypoint, index) => {
      const distance = getDistanceToWaypoint(position, waypoint);
      if (!Number.isFinite(distance)) {
        return;
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  function getTileAt(position) {
    if (!position) {
      return null;
    }

    return window.gameClient?.world?.getTileFromWorldPosition?.(
      new Position(position.x, position.y, position.z)
    ) || null;
  }

  function getTilePosition(tile) {
    return normalizePosition(tile?.__position);
  }

  function getFloorChangeDefinition(itemId) {
    if (!itemId) {
      return null;
    }

    return (
      window.gameClient?.itemDefinitionsByCid?.[itemId] ||
      window.gameClient?.itemDefinitions?.[itemId] ||
      null
    );
  }

  function isFloorChangeThing(thing) {
    const definition = getFloorChangeDefinition(thing?.id);
    return !!definition?.properties?.floorchange;
  }

  function isFloorChangeTile(tile) {
    const tilePosition = getTilePosition(tile);
    if (!tilePosition) {
      return false;
    }

    if (isFloorChangeThing(tile)) {
      return true;
    }

    return Array.isArray(tile.items) && tile.items.some((item) => isFloorChangeThing(item));
  }

  function getLoadedTiles() {
    const chunks = window.gameClient?.world?.chunks || [];
    const tiles = [];

    for (const chunk of chunks) {
      if (!chunk?.tiles) continue;

      for (const tile of chunk.tiles) {
        if (tile?.__position) {
          tiles.push(tile);
        }
      }
    }

    return tiles;
  }

  function getNearbyFloorChangeTiles(position, radius = 8) {
    if (!position) {
      return [];
    }

    return getLoadedTiles()
      .map((tile) => ({ tile, position: getTilePosition(tile) }))
      .filter((entry) =>
        entry.position &&
        entry.position.z === position.z &&
        Math.abs(entry.position.x - position.x) <= radius &&
        Math.abs(entry.position.y - position.y) <= radius &&
        isFloorChangeTile(entry.tile)
      );
  }

  function findFloorChangeTileNearPosition(position, radius = 1) {
    if (!position) {
      return null;
    }

    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    getNearbyFloorChangeTiles(position, radius).forEach((entry) => {
      const distance = getDistance(position, entry.position);
      if (!Number.isFinite(distance)) {
        return;
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    });

    return best;
  }

  function findBestKnownTransition(position, waypoint) {
    if (!position || !waypoint) {
      return null;
    }

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    transitions.forEach((transition) => {
      if (transition.from.z !== position.z || transition.to.z !== waypoint.z) {
        return;
      }

      const playerDistance = getDistance(position, transition.from);
      const landingDistance = getDistance(transition.to, waypoint);
      if (!Number.isFinite(playerDistance) || !Number.isFinite(landingDistance)) {
        return;
      }

      const score = playerDistance * 10 + landingDistance;
      if (score < bestScore) {
        bestScore = score;
        best = transition;
      }
    });

    return best;
  }

  function findNearbyFloorChangeTile(position, waypoint) {
    if (!position || !waypoint) {
      return null;
    }

    const waypointDistance = Math.abs(position.x - waypoint.x) + Math.abs(position.y - waypoint.y);
    const radius = Math.max(4, Math.min(20, waypointDistance + 2));
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    getNearbyFloorChangeTiles(position, radius).forEach((entry) => {
      const playerDistance = getDistance(position, entry.position);
      const tileToWaypointDistance =
        Math.abs(entry.position.x - waypoint.x) + Math.abs(entry.position.y - waypoint.y);
      const score = playerDistance * 10 + tileToWaypointDistance;

      if (score < bestScore) {
        bestScore = score;
        best = {
          tile: entry.tile,
          position: entry.position,
          playerDistance,
          waypointDistance: tileToWaypointDistance,
        };
      }
    });

    return best;
  }

  function isAtWaypoint(position, waypoint) {
    const distance = getDistanceToWaypoint(position, waypoint);
    if (!Number.isFinite(distance)) {
      return false;
    }

    return distance <= Math.max(0, Number(config.waypointTolerance) || 0);
  }

  function goToWaypoint(waypoint) {
    const from = bot.getPlayerPosition();
    if (!from || !waypoint) {
      return false;
    }

    const to = new Position(waypoint.x, waypoint.y, waypoint.z);

    try {
      window.gameClient?.world?.pathfinder?.findPath?.(from, to);
      state.lastPathAt = Date.now();
      bot.log("cave pathing to waypoint", {
        ...waypoint,
        index: state.currentIndex + 1,
        total: route.length,
      });
      return true;
    } catch (error) {
      bot.log("cave pathing failed", { ...waypoint, error: error?.message || error });
      return false;
    }
  }

  function goToPosition(position) {
    if (!position) {
      return false;
    }

    return goToWaypoint(position);
  }

  function markPendingTransitionSource(source) {
    const normalized = normalizePosition(source);
    if (!normalized) {
      return;
    }

    state.pendingTransitionSource = {
      ...normalized,
      at: Date.now(),
    };
  }

  function upsertTransition(from, to) {
    const normalizedFrom = normalizePosition(from);
    const normalizedTo = normalizePosition(to);
    if (!normalizedFrom || !normalizedTo || normalizedFrom.z === normalizedTo.z) {
      return null;
    }

    const key = getPositionKey(normalizedFrom);
    const index = transitions.findIndex((transition) => getPositionKey(transition.from) === key);
    const next = {
      from: normalizedFrom,
      to: normalizedTo,
      count: index >= 0 ? transitions[index].count + 1 : 1,
      lastSeenAt: Date.now(),
    };

    if (index >= 0) {
      transitions[index] = next;
    } else {
      transitions.push(next);
    }

    persistTransitions();
    bot.log("cave learned floor transition", next);
    return cloneValue(next);
  }

  function resolveObservedTransitionSource(previousPosition) {
    const pending = normalizePosition(state.pendingTransitionSource);
    if (pending && pending.z === previousPosition.z) {
      return pending;
    }

    const currentTile = getTileAt(previousPosition);
    if (currentTile && isFloorChangeTile(currentTile)) {
      return previousPosition;
    }

    const nearby = findFloorChangeTileNearPosition(previousPosition, 1);
    if (nearby?.position) {
      return nearby.position;
    }

    return null;
  }

  function observePosition() {
    const current = normalizePosition(bot.getPlayerPosition());
    if (!current) {
      return;
    }

    const previous = state.lastObservedPosition;
    if (previous && !isSameTile(previous, current) && previous.z !== current.z) {
      const source = resolveObservedTransitionSource(previous);
      if (source) {
        upsertTransition(source, current);
      }
      state.pendingTransitionSource = null;
    }

    state.lastObservedPosition = current;
  }

  function useFloorChangeTile(target, waypoint, now = Date.now()) {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position || !target) {
      return false;
    }

    if (!isSameTile(position, target.position)) {
      return goToPosition(target.position);
    }

    if (now - state.lastStairsUseAt < 1200) {
      return true;
    }

    const currentTile = getTileAt(position);
    if (!currentTile || !isFloorChangeTile(currentTile)) {
      return false;
    }

    window.gameClient?.mouse?.use?.({ which: currentTile, index: 0xFF });
    state.lastStairsUseAt = now;
    state.lastPathAt = now;
    markPendingTransitionSource(position);
    bot.log("cave used floor-change tile", {
      source: position,
      targetZ: waypoint?.z ?? null,
    });
    return true;
  }

  function handleFloorChange(waypoint, now = Date.now()) {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position || !waypoint || position.z === waypoint.z) {
      return false;
    }

    const knownTransition = findBestKnownTransition(position, waypoint);
    if (knownTransition) {
      const target = {
        tile: getTileAt(knownTransition.from),
        position: knownTransition.from,
      };
      const moved = useFloorChangeTile(target, waypoint, now);
      if (moved) {
        bot.log("cave using learned floor transition", {
          from: knownTransition.from,
          to: knownTransition.to,
          waypoint,
        });
      }
      return moved;
    }

    const fallback = findNearbyFloorChangeTile(position, waypoint);
    if (!fallback) {
      return false;
    }

    const moved = useFloorChangeTile(fallback, waypoint, now);
    if (moved) {
      bot.log("cave probing floor-change tile", {
        tileX: fallback.position.x,
        tileY: fallback.position.y,
        tileZ: fallback.position.z,
        targetZ: waypoint.z,
      });
    }
    return moved;
  }

  function advanceWaypoint() {
    if (!route.length) {
      return null;
    }

    if (route.length === 1) {
      return route[0];
    }

    let nextIndex = state.currentIndex + state.direction;

    if (nextIndex >= route.length) {
      state.direction = -1;
      nextIndex = route.length - 2;
    } else if (nextIndex < 0) {
      state.direction = 1;
      nextIndex = 1;
    }

    state.currentIndex = Math.max(0, Math.min(route.length - 1, nextIndex));

    const nextWaypoint = getCurrentWaypoint();
    bot.log("cave advanced waypoint", {
      index: state.currentIndex + 1,
      total: route.length,
      direction: state.direction,
      waypoint: nextWaypoint,
    });
    return nextWaypoint;
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
  }

  function tick() {
    if (!state.running) return;

    try {
      observePosition();

      if (!route.length) {
        stop();
        return;
      }

      const position = normalizePosition(bot.getPlayerPosition());
      const positionKey = getPositionKey(position);
      const now = Date.now();

      if (positionKey && positionKey !== state.lastPositionKey) {
        state.lastPositionKey = positionKey;
        state.lastProgressAt = now;
      }

      let waypoint = getCurrentWaypoint();
      if (!waypoint) {
        stop();
        return;
      }

      if (isAtWaypoint(position, waypoint)) {
        waypoint = advanceWaypoint();
      }

      if (!waypoint) {
        return;
      }

      if (position && waypoint.z !== position.z) {
        handleFloorChange(waypoint, now);
        return;
      }

      const shouldRepath =
        now - state.lastPathAt >= config.repathMs ||
        !state.lastProgressAt ||
        now - state.lastProgressAt >= config.repathMs;

      if (shouldRepath) {
        goToWaypoint(waypoint);
      }
    } catch (error) {
      bot.log("cave tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  function startObserver() {
    if (state.observerTimerId != null) {
      return;
    }

    state.observerTimerId = window.setInterval(() => {
      try {
        observePosition();
      } catch (error) {
        bot.log("cave observer failed", error?.message || error);
      }
    }, 200);
  }

  function stopObserver() {
    if (state.observerTimerId == null) {
      return;
    }

    window.clearInterval(state.observerTimerId);
    state.observerTimerId = null;
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 500;
    persistConfig();

    if (!route.length) {
      bot.log("cave bot cannot start without waypoints");
      return false;
    }

    if (state.running) {
      bot.log("cave bot already running");
      return false;
    }

    const position = normalizePosition(bot.getPlayerPosition());
    state.running = true;
    state.currentIndex = findClosestWaypointIndex(position);
    state.direction = state.currentIndex >= route.length - 1 ? -1 : 1;
    if (route.length <= 1) {
      state.direction = 1;
    }
    state.lastPathAt = 0;
    state.lastPositionKey = getPositionKey(position);
    state.lastProgressAt = Date.now();
    bot.log("cave bot started", {
      waypoints: route.length,
      currentIndex: state.currentIndex + 1,
      direction: state.direction,
      waypoint: getCurrentWaypoint(),
    });
    tick();
    return true;
  }

  function stop() {
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    config.enabled = false;
    persistConfig();
    bot.log("cave bot stopped");
    return true;
  }

  function addWaypoint(waypoint) {
    const normalized = normalizeWaypoint(waypoint);
    if (!normalized) {
      return null;
    }

    route.push(normalized);
    persistRoute();
    bot.log("cave waypoint added", { ...normalized, total: route.length });
    return cloneValue(normalized);
  }

  function addWaypointCurrentSpot() {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position) {
      bot.log("could not read current position for cave waypoint");
      return null;
    }

    return addWaypoint(position);
  }

  function clearWaypoints() {
    route = [];
    state.currentIndex = 0;
    state.direction = 1;
    persistRoute();
    bot.log("cave route cleared");

    if (state.running) {
      stop();
    }

    return [];
  }

  function clearTransitions() {
    transitions = [];
    state.pendingTransitionSource = null;
    persistTransitions();
    bot.log("cave learned transitions cleared");
    return [];
  }

  function removeLastWaypoint() {
    if (!route.length) {
      return null;
    }

    const removed = route.pop();
    if (state.currentIndex >= route.length) {
      state.currentIndex = Math.max(0, route.length - 1);
    }
    if (route.length <= 1) {
      state.direction = 1;
    }
    persistRoute();
    bot.log("cave waypoint removed", removed);

    if (!route.length && state.running) {
      stop();
    }

    return removed;
  }

  function setCurrentIndex(index) {
    if (!route.length) {
      state.currentIndex = 0;
      state.direction = 1;
      return 0;
    }

    const nextIndex = Math.max(0, Math.min(route.length - 1, Math.trunc(Number(index) || 0)));
    state.currentIndex = nextIndex;
    state.direction = nextIndex >= route.length - 1 ? -1 : 1;
    if (route.length <= 1) {
      state.direction = 1;
    }
    return state.currentIndex;
  }

  function status() {
    const position = normalizePosition(bot.getPlayerPosition());
    const waypoint = getCurrentWaypoint();

    return {
      running: state.running,
      config: { ...config },
      route: getRoute(),
      transitions: getTransitions(),
      currentIndex: state.currentIndex,
      direction: state.direction,
      currentWaypoint: cloneValue(waypoint),
      distanceToWaypoint: getDistanceToWaypoint(position, waypoint),
      lastPathAt: state.lastPathAt,
      lastProgressAt: state.lastProgressAt,
      pendingTransitionSource: cloneValue(state.pendingTransitionSource),
    };
  }

  function updateConfig(nextConfig = {}) {
    Object.assign(config, nextConfig);
    config.tickMs = 500;
    persistConfig();
    bot.log("cave config updated", { ...config });
    return { ...config };
  }

  startObserver();
  bot.addCleanup(stopObserver);

  if (config.enabled && route.length) {
    start();
  }

  bot.cave = {
    start,
    stop,
    status,
    updateConfig,
    config,
    getRoute,
    getTransitions,
    getCurrentWaypoint,
    addWaypoint,
    addWaypointCurrentSpot,
    clearWaypoints,
    clearTransitions,
    removeLastWaypoint,
    setCurrentIndex,
    goToWaypoint,
    goToPosition,
    handleFloorChange,
    findClosestWaypointIndex,
    isAtWaypoint,
  };
};
