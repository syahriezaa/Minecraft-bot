const { AdaptiveMiningPlanner } = require('./adaptiveMiningPlanner');
const { QUARRY_NAMES } = require('./storageRoomQuarry');
const { kindOf } = require('./structureRegistry');
const { worldContext } = require('./sharedWorldObserver');
const { analyzeMiningVoidTopology } = require('./miningVoidTopology');

const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const PROTECTED_MARKERS = new Set([
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'ladder', 'scaffolding',
  'farmland', 'dirt_path', 'chest', 'trapped_chest', 'barrel', 'hopper'
]);

function cellKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

function ignoredCellSet(cells = []) {
  return new Set([...cells].map(cell => typeof cell === 'string' ? cell : cellKey(cell)));
}

function knownStructureOverlaps(adapter, bounds, margin = 0, ignoredStructureCells = []) {
  const observer = adapter?.sharedWorldObserver;
  const context = worldContext(adapter?.bot);
  if (!observer?.memory?.db || !context) return false;
  const ignored = ignoredCellSet(ignoredStructureCells);
  const rows = observer.memory.db.prepare(`SELECT x,y,z FROM structure_voxels
    WHERE world=? AND dimension=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?`)
    .all(context.world, context.dimension,
      bounds.minX - margin, bounds.maxX + margin,
      bounds.minZ - margin, bounds.maxZ + margin);
  return rows.some(row => !ignored.has(cellKey(row)));
}

function surveyAdaptiveMiningCell(adapter, bounds, options = {}) {
  if (!adapter?.blockAt) throw new TypeError('Survei mining membutuhkan adapter blockAt().');
  const planner = options.planner || new AdaptiveMiningPlanner(options);
  const game = adapter.bot?.game || {};
  const worldTop = Number.isInteger(game.minY) && Number.isInteger(game.height)
    ? game.minY + game.height - 1 : bounds.maxY + 32;
  const scanTop = Math.min(worldTop, Math.max(bounds.maxY, bounds.maxY + (Number(options.aboveScanHeight) || 24)));
  const evidence = {
    totalColumns: 0,
    unknownColumns: 0,
    structureColumns: 0,
    hazardColumns: 0,
    liquidColumns: 0,
    deepLiquidColumns: 0,
    naturalColumns: 0
  };
  const surfaceLevels = [];
  const ignoredStructureCells = ignoredCellSet(options.ignoredStructureCells);
  // A nearby structure is useful spatial evidence, but it must not reject an
  // entire mining cell when it remains outside the user-authorized bounds.
  // Blocks inside the bounds are still fail-closed below.
  const knownStructure = knownStructureOverlaps(adapter, bounds, 0, ignoredStructureCells);
  evidence.nearbyStructure = knownStructureOverlaps(
    adapter, bounds, planner.protectionMargin, ignoredStructureCells
  );
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      evidence.totalColumns += 1;
      let unknown = false;
      let structure = knownStructure;
      let hazard = false;
      let liquidDepth = 0;
      let natural = true;
      let surfaceY = null;
      for (let y = bounds.floorY; y <= scanTop; y += 1) {
        const block = adapter.blockAt({ x, y, z });
        if (!block) { unknown = true; natural = false; break; }
        if (AIR.has(block.name)) continue;
        surfaceY = y;
        if (LIQUID.has(block.name)) {
          liquidDepth += 1;
          natural = false;
          if (block.name.includes('lava')) hazard = true;
          continue;
        }
        if (ignoredStructureCells.has(`${x},${y},${z}`)) continue;
        if (PROTECTED_MARKERS.has(block.name) || kindOf(block.name)) {
          structure = true;
          natural = false;
          continue;
        }
        if (!QUARRY_NAMES.has(block.name)) {
          structure = true;
          natural = false;
        }
      }
      if (unknown) evidence.unknownColumns += 1;
      if (structure) evidence.structureColumns += 1;
      if (hazard) evidence.hazardColumns += 1;
      if (liquidDepth > 0) evidence.liquidColumns += 1;
      if (liquidDepth >= 3) evidence.deepLiquidColumns += 1;
      if (natural && !unknown && !structure && !hazard && liquidDepth === 0) evidence.naturalColumns += 1;
      if (surfaceY !== null) surfaceLevels.push(surfaceY);
    }
  }
  const surface = {
    minY: surfaceLevels.length ? Math.min(...surfaceLevels) : null,
    maxY: surfaceLevels.length ? Math.max(...surfaceLevels) : null,
    columns: surfaceLevels.length,
    scanTop
  };
  const voidTopology = analyzeMiningVoidTopology(adapter, bounds, { scanTop,
    maxSafeDrop: options.maxSafeDrop, ravineDepth: options.ravineDepth,
    minCaveHeight: options.minCaveHeight,
    plannedAccessCells: options.ignoredStructureCells });
  Object.assign(evidence, voidTopology.evidence);
  const excavationBounds = { ...bounds, maxY: surface.maxY ?? bounds.floorY };
  const result = { bounds, excavationBounds, surface, voidTopology, evidence, ...planner.classifyCell(evidence) };
  const context = worldContext(adapter?.bot);
  const memory = adapter?.sharedWorldObserver?.memory;
  if (context && typeof memory?.saveAnalysis === 'function') {
    const hypotheses = [];
    if (evidence.caveColumns) hypotheses.push({ type: 'cave', score: 1, reasons: ['enclosed_air_volume'], status: 'verified_geometry' });
    if (evidence.ravineColumns) hypotheses.push({ type: 'ravine', score: 1, reasons: ['deep_surface_drop'], status: 'verified_geometry' });
    if (hypotheses.length) {
      try {
        memory.saveAnalysis({ ...context, observer: adapter.bot?.username || 'miner' }, {
          bounds: { min: { x: bounds.minX, y: bounds.floorY, z: bounds.minZ },
            max: { x: bounds.maxX + 1, y: scanTop + 1, z: bounds.maxZ + 1 } },
          evidence: { ...voidTopology.evidence }, rooms: voidTopology.components,
          hypotheses, observedAt: Date.now(), complete: evidence.unknownColumns === 0,
          warning: 'Geometri rongga mining; boundary wajib diverifikasi ulang sebelum dig.'
        });
      } catch {}
    }
  }
  return result;
}

module.exports = { surveyAdaptiveMiningCell, knownStructureOverlaps, ignoredCellSet, PROTECTED_MARKERS };
