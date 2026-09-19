const fs = require('node:fs/promises');
const { AdaptiveMiningPlanner } = require('./adaptiveMiningPlanner');
const { surveyAdaptiveMiningCell } = require('./adaptiveMiningSurvey');
const { excavateStorageQuarry, inventoryFill } = require('./storageRoomQuarry');
const { writeCheckpoint } = require('./storageRoomBuilder');
const { worldContext } = require('./sharedWorldObserver');

async function readFrontier(file, seedBounds) {
  if (!file) return { bounds: seedBounds, parentId: null };
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved?.bounds && ['minX', 'maxX', 'minZ', 'maxZ', 'floorY', 'maxY'].every(key => Number.isInteger(saved.bounds[key]))) {
      return { bounds: saved.bounds, parentId: saved.parentId || null };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Checkpoint frontier tidak bisa dibaca: ${error.message}`);
  }
  return { bounds: seedBounds, parentId: null };
}

async function runAdaptiveMiningFrontier({
  bot,
  adapter,
  seedBounds,
  checkpointFile,
  frontierFile = checkpointFile ? `${checkpointFile}.frontier.json` : null,
  protectedCells = [],
  mode = process.env.STORAGE_QUARRY_MODE || 'strip_surface_to_floor',
  minInventoryFillRatio = 0.75,
  planner = new AdaptiveMiningPlanner({ cellSize: seedBounds.maxX - seedBounds.minX + 1, direction: 'east' }),
  survey = surveyAdaptiveMiningCell,
  surveyOptions = {},
  excavate = excavateStorageQuarry,
  prepareCell = null,
  shouldStop = () => false,
  log = () => {}
}) {
  let current = await readFrontier(frontierFile, seedBounds);
  let totalCleared = 0;
  let cellsCompleted = 0;
  let seedFallbackUsed = false;
  while (true) {
    if (shouldStop()) return result('PAUSED', 'TIME_LIMIT');
    const cell = { id: require('./adaptiveMiningPlanner').cellId(current.bounds), bounds: current.bounds, parentId: current.parentId };
    if (typeof prepareCell === 'function' && !await prepareCell(cell, { phase: 'stage' })) {
      if (cell.parentId && !seedFallbackUsed) {
        seedFallbackUsed = true;
        current = { bounds: seedBounds, parentId: null };
        log(`MINING_FRONTIER_FALLBACK_SEED ${JSON.stringify({ from: cell.id, reason: 'STAGE_UNREACHABLE' })}`);
        continue;
      }
      return result('PAUSED', 'FRONTIER_UNREACHABLE');
    }
    const assessment = survey(adapter, cell.bounds, {
      planner,
      mode,
      ...surveyOptions,
      ignoredStructureCells: protectedCells
    });
    log(`MINING_FRONTIER_SURVEY ${JSON.stringify({ cell: cell.id, mode, classification: assessment.classification, confidence: assessment.confidence, surface: assessment.surface, voids: assessment.voidTopology?.evidence })}`);
    if (!assessment.mineable) {
      if (assessment.classification === 'PROTECTED') {
        const next = planner.nextFrontierCells(cell, { classification: assessment.classification, exhausted: true })[0];
        if (next) {
          current = { bounds: next.bounds, parentId: cell.id };
          if (frontierFile) await writeCheckpoint(frontierFile, {
            version: 1, bounds: current.bounds, parentId: current.parentId,
            direction: next.direction, cellsCompleted, updatedAt: new Date().toISOString(),
            skipped: 'PROTECTED'
          });
          log(`MINING_FRONTIER_SKIP ${JSON.stringify({ cell: cell.id, reason: 'PROTECTED', next: next.id })}`);
          continue;
        }
      }
      return result('PAUSED', `FRONTIER_${assessment.classification}`);
    }
    // The stage navigation above only proves that the chunk is loaded. A new
    // frontier still needs its own verified stair/entrance before excavation;
    // this second hook lets the runner build it after 3D survey confirms the
    // cell is mineable, without touching protected or liquid cells.
    if (typeof prepareCell === 'function' && !await prepareCell(cell, { phase: 'access', assessment })) {
      if (cell.parentId && !seedFallbackUsed) {
        seedFallbackUsed = true;
        current = { bounds: seedBounds, parentId: null };
        log(`MINING_FRONTIER_FALLBACK_SEED ${JSON.stringify({ from: cell.id, reason: 'ACCESS_UNREACHABLE' })}`);
        continue;
      }
      return result('PAUSED', 'FRONTIER_ACCESS_UNREACHABLE');
    }

    const reservations = adapter.sharedWorldObserver?.reservations;
    const context = worldContext(bot);
    const resource = `mining-cell:${cell.id}`;
    const lease = reservations?.acquire(context, [resource], 60000) || null;
    if (reservations && !lease) return result('PAUSED', 'FRONTIER_RESERVED');
    let renewTimer;
    let leaseLost = false;
    if (lease) {
      renewTimer = setInterval(() => {
        if (!reservations.renew(lease)) {
          leaseLost = true;
          log(`MINING_FRONTIER_LEASE_LOST ${JSON.stringify({ cell: cell.id })}`);
        }
      }, 20000);
      renewTimer.unref?.();
    }
    let excavation;
    try {
      const allowSafeVoidBoundary = assessment.restricted === true &&
        ['CAVE_EDGE', 'RAVINE_EDGE'].includes(assessment.classification);
      if (allowSafeVoidBoundary) {
        log(`MINING_VOID_POLICY ${JSON.stringify({ cell: cell.id, policy: 'SAFE_SOLID_TARGETS_ONLY', classification: assessment.classification })}`);
      }
      excavation = await excavate({
        bot, adapter, maxBlocks: Number.MAX_SAFE_INTEGER, minInventoryFillRatio,
        checkpointFile, bounds: assessment.excavationBounds || cell.bounds, protectedCells, mode,
        voidTopology: assessment.voidTopology, allowSafeVoidBoundary, log,
        shouldStop: () => shouldStop() || leaseLost, stateDriven: true
      });
    } finally {
      clearInterval(renewTimer);
      if (lease) reservations.release(lease);
    }
    if (leaseLost) return result('PAUSED', 'FRONTIER_LEASE_LOST', excavation);
    totalCleared += Number(excavation.cleared) || 0;
    // A restricted cave/ravine cell can be exhausted after all solid targets
    // have either been mined or rejected by the voxel safety check. Continue
    // the survey eastward instead of treating the boundary as a terminal stop.
    const boundaryExhausted = ['VOID_BOUNDARY', 'NO_REACHABLE_TARGET'].includes(excavation.reason) &&
      ['CAVE_EDGE', 'RAVINE_EDGE'].includes(assessment.classification);
    if (excavation.reason !== 'EXCAVATED' && !boundaryExhausted) {
      return result(excavation.status, excavation.reason, excavation);
    }

    cellsCompleted += 1;
    const fill = inventoryFill(adapter);
    const returnDecision = planner.shouldReturn({
      inventoryFillRatio: fill.ratio,
      returnInventoryRatio: minInventoryFillRatio,
      health: bot.health,
      food: bot.food,
      routeHomeAvailable: true,
      safeTargetsRemaining: 1
    });
    if (returnDecision.return) return result('PAUSED', returnDecision.reason, excavation);

    const next = planner.nextFrontierCells(cell, { classification: assessment.classification, exhausted: true })[0];
    if (!next) return result('PAUSED', 'NO_SAFE_TARGET', excavation);
    current = { bounds: next.bounds, parentId: cell.id };
    if (frontierFile) await writeCheckpoint(frontierFile, {
      version: 1, bounds: current.bounds, parentId: current.parentId,
      direction: next.direction, cellsCompleted, updatedAt: new Date().toISOString()
    });
  }

  function result(status, reason, last = {}) {
    const fill = inventoryFill(adapter);
    return {
      ...last,
      status,
      reason,
      cleared: totalCleared,
      cellsCompleted,
      frontierBounds: current.bounds,
      inventoryFillRatio: fill.ratio,
      inventoryOccupiedSlots: fill.occupiedSlots,
      inventoryCapacitySlots: fill.capacitySlots
    };
  }
}

module.exports = { runAdaptiveMiningFrontier, readFrontier };
