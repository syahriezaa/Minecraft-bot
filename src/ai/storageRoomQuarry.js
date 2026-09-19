/** Bounded quarry in surveyed natural terrain east of the storage room. */
const { NATURAL_NAMES, LIQUID_NAMES, isAir } = require('./storageRoomLandscaper');
const { writeCheckpoint } = require('./storageRoomBuilder');
const fs = require('node:fs/promises');
const { planQuarryAccess } = require('./quarryAccess');
const { columnKey, inspectMiningTargetVoidRisk } = require('./miningVoidTopology');

const QUARRY_BOUNDS = Object.freeze({ minX: -66, maxX: -43, minZ: -408, maxZ: -389, floorY: 60, maxY: 80 });
const QUARRY_NAMES = new Set([...NATURAL_NAMES, 'coal_ore', 'copper_ore', 'lapis_ore']);
const SOFT_NAMES = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'sand', 'gravel', 'clay']);

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((a.x || 0) - b.x, (a.y || 0) - b.y, (a.z || 0) - b.z);
}

function parseQuarryBounds(raw = process.env.STORAGE_QUARRY_BOUNDS) {
  if (!raw) return QUARRY_BOUNDS;
  const values = raw.split(',').map(Number);
  if (values.length !== 6 || !values.every(Number.isInteger)) {
    throw new Error('STORAGE_QUARRY_BOUNDS harus berbentuk minX,maxX,minZ,maxZ,floorY,maxY.');
  }
  const [minX, maxX, minZ, maxZ, floorY, maxY] = values;
  if (minX > maxX || minZ > maxZ || floorY > maxY) throw new Error('Batas quarry tidak berurutan.');
  return { minX, maxX, minZ, maxZ, floorY, maxY };
}

function quarryFloor(x, z, bounds = QUARRY_BOUNDS) {
  return bounds.floorY;
}

function inventoryFill(adapter) {
  if (typeof adapter?.getInventoryFreeSlotCount !== 'function') {
    return { ratio: 0, occupiedSlots: 0, capacitySlots: 0, freeSlots: 0 };
  }
  const freeSlots = Math.max(0, Number(adapter.getInventoryFreeSlotCount()) || 0);
  const items = typeof adapter.getInventoryItems === 'function' ? adapter.getInventoryItems() : null;
  const capacitySlots = Math.max(36, freeSlots + (Array.isArray(items) ? items.length : 0));
  const occupiedSlots = Math.max(0, capacitySlots - freeSlots);
  return { ratio: occupiedSlots / capacitySlots, occupiedSlots, capacitySlots, freeSlots };
}

function surveyStorageQuarry(adapter, bounds = QUARRY_BOUNDS, protectedCells = [], options = {}) {
  const actions = [];
  const blockers = [];
  const materials = {};
  const surfaceLevels = [];
  const deferred = [];
  const voidBoundaryColumns = new Set(options.voidTopology?.boundaryColumns || []);
  // A cave/ravine boundary is evidence for voxel-level checks, not proof that
  // every solid block in the column is forbidden.
  const allowSafeVoidBoundary = options.allowSafeVoidBoundary === true;
  const mode = options.mode || process.env.STORAGE_QUARRY_MODE || 'strip_surface_to_floor';
  const surfaceFirst = mode !== 'depth_first';
  const stripMode = mode === 'strip_surface_to_floor' || mode === 'surface_flat_then_stair' || mode === 'strip';
  const stripWidth = bounds.maxX - bounds.minX + 1;
  // Strip mining berarti menyelesaikan satu bidang horizontal sebelum turun
  // ke bidang berikutnya. Urutan posisi di dalam bidang tetap zig-zag-ish dan
  // stabil, tetapi Y harus menjadi kunci pertama agar worker tidak membuat
  // lubang vertikal terpisah-pisah.
  const orderFor = (x, z, y) => ({
    layerPriority: surfaceFirst ? -y : y,
    stripOrder: (z - bounds.minZ) * stripWidth + (x - bounds.minX)
  });
  const { supports } = planQuarryAccess(bounds);
  for(const key of protectedCells)supports.add(key);
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      let surfaceY = null;
      for (let y = bounds.maxY; y >= bounds.floorY; y -= 1) {
        const pos = { x, y, z };
        const block = adapter.blockAt(pos);
        if (!block || LIQUID_NAMES.has(block.name) || !isAir(block) && !QUARRY_NAMES.has(block.name)) {
          blockers.push({ pos, actual: block?.name || null });
          continue;
        }
        if (!isAir(block) && surfaceY === null) surfaceY = y;
        if (isAir(block) || y <= quarryFloor(x, z, bounds) || supports.has(`${x},${y},${z}`)) continue;
        if (voidBoundaryColumns.has(columnKey(x, z)) && !allowSafeVoidBoundary) {
          deferred.push({ pos, reason: options.voidTopology.ravineColumns?.includes(columnKey(x, z))
            ? 'RAVINE_BOUNDARY' : 'CAVE_BOUNDARY' });
          continue;
        }
        actions.push({ pos, name: block.name, priority: surfaceFirst ? -pos.y : pos.y,
          ...(stripMode ? orderFor(x, z, y) : {}) });
        materials[block.name] = (materials[block.name] || 0) + 1;
      }
      if (surfaceY !== null) surfaceLevels.push(surfaceY);
    }
  }
  // Only widen after the original excavation is exhausted, never to bypass a blocker.
  let expanded = false;
  if (!actions.length && !blockers.length && !deferred.length && adapter.isQuarryExpansionColumnSafe) {
    for (let x = bounds.minX - 1; x <= bounds.maxX + 1; x++) {
      for (let z = bounds.minZ - 1; z <= bounds.maxZ + 1; z++) {
        if (x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ) continue;
        if (!adapter.isQuarryExpansionColumnSafe({ x, z }, bounds)) continue;
        for (let y = bounds.floorY + 1; y <= bounds.maxY; y++) {
          const pos = { x, y, z };
          const block = adapter.blockAt(pos);
          if (!block || isAir(block) || !QUARRY_NAMES.has(block.name) || supports.has(`${x},${y},${z}`)) continue;
          actions.push({ pos, name: block.name, priority: surfaceFirst ? -y : y, expansion: true,
            ...(stripMode ? orderFor(x, z, y) : {}) });
          materials[block.name] = (materials[block.name] || 0) + 1;
          expanded = true;
        }
      }
    }
  }
  actions.sort((a, b) => stripMode
    ? a.layerPriority - b.layerPriority || a.stripOrder - b.stripOrder || a.pos.y - b.pos.y
    : a.priority - b.priority || a.pos.z - b.pos.z ||
      (a.pos.z % 2 === 0 ? a.pos.x - b.pos.x : b.pos.x - a.pos.x));
  const surface = {
    minY: surfaceLevels.length ? Math.min(...surfaceLevels) : null,
    maxY: surfaceLevels.length ? Math.max(...surfaceLevels) : null,
    columns: surfaceLevels.length
  };
  return { bounds, mode, surface, actions, blockers, deferred, materials, expanded, voidTopology: options.voidTopology || null };
}

function planSurfaceFlattening(adapter, bounds = QUARRY_BOUNDS, protectedCells = [], options = {}) {
  const protectedSet = new Set(protectedCells);
  const columns = [];
  const blockers = [];
  const deferred = [];
  const actions = [];
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      let surfaceY = null;
      for (let y = bounds.maxY; y >= bounds.floorY; y -= 1) {
        const pos = { x, y, z };
        const block = adapter.blockAt(pos);
        if (!block) {
          blockers.push({ pos, actual: null, reason: 'UNKNOWN_SURFACE' });
          break;
        }
        if (LIQUID_NAMES.has(block.name)) {
          blockers.push({ pos, actual: block.name, reason: 'LIQUID_SURFACE' });
          break;
        }
        if (isAir(block)) continue;
        if (!QUARRY_NAMES.has(block.name)) {
          blockers.push({ pos, actual: block.name, reason: 'STRUCTURE_SURFACE' });
          break;
        }
        surfaceY = y;
        break;
      }
      if (surfaceY !== null) columns.push({ x, z, surfaceY });
    }
  }
  if (!columns.length) return { bounds, targetY: null, columns, actions, blockers, deferred };
  const sortedSurface = columns.map(column => column.surfaceY).sort((a, b) => a - b);
  const requested = Number.isInteger(options.surfaceLevelY) ? options.surfaceLevelY : null;
  // Median lower-bound menahan target agar satu lubang lama tidak memaksa
  // seluruh region digali terlalu dalam hanya demi mengejar satu kolom.
  const targetY = requested === null ? sortedSurface[Math.floor((sortedSurface.length - 1) / 2)] : requested;
  if (targetY < bounds.floorY || targetY > bounds.maxY) {
    blockers.push({ pos: { x: bounds.minX, y: targetY, z: bounds.minZ }, actual: null, reason: 'INVALID_SURFACE_LEVEL' });
  }
  for (const column of columns) {
    if (column.surfaceY < targetY) {
      deferred.push({ pos: { x: column.x, y: column.surfaceY, z: column.z }, reason: 'LOW_SURFACE_OR_EXISTING_VOID' });
      continue;
    }
    for (let y = column.surfaceY; y > targetY; y -= 1) {
      const pos = { x: column.x, y, z: column.z };
      if (protectedSet.has(`${pos.x},${pos.y},${pos.z}`)) continue;
      const block = adapter.blockAt(pos);
      if (isAir(block)) {
        deferred.push({ pos, reason: 'OPEN_GAP_BELOW_SURFACE' });
        break;
      }
      if (!block || LIQUID_NAMES.has(block.name) || !QUARRY_NAMES.has(block.name)) {
        blockers.push({ pos, actual: block?.name || null, reason: 'SURFACE_CHANGED' });
        continue;
      }
      actions.push({ pos, name: block.name, priority: -pos.y });
    }
  }
  actions.sort((a, b) => a.priority - b.priority || a.pos.z - b.pos.z || a.pos.x - b.pos.x);
  return {
    bounds,
    targetY,
    columns,
    minY: Math.min(...columns.map(column => column.surfaceY)),
    maxY: Math.max(...columns.map(column => column.surfaceY)),
    actions,
    blockers,
    deferred
  };
}

async function flattenStorageQuarrySurface({ adapter, maxBlocks = 256, checkpointFile, bounds = QUARRY_BOUNDS,
  protectedCells = [], voidTopology = null, log = () => {}, shouldStop = () => false }) {
  const plan = planSurfaceFlattening(adapter, bounds, protectedCells);
  log(`SURFACE_FLATTEN_PLAN ${JSON.stringify({ targetY: plan.targetY, columns: plan.columns.length,
    range: [plan.minY, plan.maxY], actions: plan.actions.length, deferred: plan.deferred.length,
    blockers: plan.blockers.slice(0, 8) })}`);
  if (plan.blockers.length) return { status: 'PAUSED', reason: 'SURFACE_STRUCTURE_OR_UNKNOWN', cleared: 0, plan };
  let saved = [];
  const surfaceCheckpoint = checkpointFile ? `${checkpointFile}.surface.json` : null;
  if (surfaceCheckpoint) {
    try {
      const checkpoint = JSON.parse(await fs.readFile(surfaceCheckpoint, 'utf8'));
      saved = Array.isArray(checkpoint.completed) ? checkpoint.completed : [];
      if (checkpoint.targetY !== plan.targetY) saved = [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const savedSet = new Set(saved);
  const remaining = plan.actions.filter(action => !savedSet.has(`${action.pos.x},${action.pos.y},${action.pos.z}`));
  const completed = [];
  const deferred = [];
  let attempts = 0;
  const attemptLimit = Math.max(32, Math.min(4096, remaining.length * 4 + 32));
  while (remaining.length && completed.length < maxBlocks && attempts++ < attemptLimit) {
    if (shouldStop()) return { status: 'PAUSED', reason: 'TIME_LIMIT', cleared: completed.length, plan };
    if (adapter.getInventoryFreeSlotCount?.() < 3) return { status: 'PAUSED', reason: 'INVENTORY_FULL', cleared: completed.length, plan };
    let selection = adapter.approachReachableWork
      ? await adapter.approachReachableWork(remaining, shouldStop)
      : { target: remaining[0] };
    if (!selection?.target) {
      // Satu target permukaan yang belum punya stance tidak boleh menahan
      // seluruh region. Tandai target itu sebagai deferred dan biarkan worker
      // mencoba kolom lain, lalu bangun tangga dari sisi yang reachable.
      const fallback = remaining.slice().sort((a, b) => a.priority - b.priority ||
        distance(adapter.getPosition?.(), a.pos) - distance(adapter.getPosition?.(), b.pos))[0];
      if (!fallback) break;
      remaining.splice(remaining.indexOf(fallback), 1);
      deferred.push({ pos: fallback.pos, reason: selection?.status || 'NO_REACHABLE_SURFACE' });
      log(`SURFACE_TARGET_DEFERRED ${JSON.stringify(deferred.at(-1))}`);
      continue;
    }
    const action = selection.target;
    const index = remaining.indexOf(action);
    if (index >= 0) remaining.splice(index, 1);
    if (selection.stance && !await adapter.navigateNear(selection.stance.position, 0)) {
      deferred.push({ pos: action.pos, reason: 'SURFACE_STANCE_UNREACHABLE' });
      continue;
    }
    const current = adapter.blockAt(action.pos);
    if (isAir(current)) continue;
    if (!current || !QUARRY_NAMES.has(current.name)) {
      deferred.push({ pos: action.pos, reason: 'SURFACE_CHANGED' });
      continue;
    }
    if (voidTopology) {
      const voidRisk = inspectMiningTargetVoidRisk(adapter, action.pos, bounds, voidTopology.policy);
      if (voidRisk.unsafe) {
        deferred.push({ pos: action.pos, reason: voidRisk.reason });
        continue;
      }
    }
    try {
      const dug = await adapter.dig(current, { collectDrops: false });
      if (dug === false || !isAir(adapter.blockAt(action.pos))) throw new Error('permukaan belum terkonfirmasi kosong');
    } catch (error) {
      deferred.push({ pos: action.pos, reason: `SURFACE_DIG_FAILED:${error.message}` });
      continue;
    }
    completed.push(`${action.pos.x},${action.pos.y},${action.pos.z}`);
    log(`WORK_EVENT ${JSON.stringify({ phase: 'SURFACE_FLATTEN', verifiedBlocks: completed.length, targetY: plan.targetY })}`);
    if (surfaceCheckpoint && completed.length % 16 === 0) {
      await writeCheckpoint(surfaceCheckpoint, { phase: 'surface_flatten', targetY: plan.targetY,
        completed: [...new Set([...saved, ...completed])] });
    }
  }
  if (surfaceCheckpoint) await writeCheckpoint(surfaceCheckpoint, { phase: 'surface_flatten', targetY: plan.targetY,
    completed: [...new Set([...saved, ...completed])], deferred });
  if (deferred.length) {
    // Area yang bersebelahan dengan cave/ravine tidak dipaksa. Clearance aman
    // yang sudah selesai tetap cukup untuk membuka tahap tangga; target yang
    // ditunda akan ditangani oleh survei 3D setelah koridor akses tersedia.
    return { status: 'COMPLETE', reason: 'SURFACE_FLAT_PARTIAL', cleared: completed.length,
      deferred: deferred.length, targetY: plan.targetY, plan };
  }
  return { status: remaining.length ? 'PAUSED' : 'COMPLETE', reason: remaining.length ? 'SURFACE_BATCH_LIMIT' : 'SURFACE_FLAT',
    cleared: completed.length, targetY: plan.targetY, plan };
}

async function excavateStorageQuarry({ bot, adapter, maxBlocks = 512, minInventoryFillRatio = 0.75, checkpointFile, bounds = QUARRY_BOUNDS, protectedCells = [], voidTopology = null, allowSafeVoidBoundary = false, log = () => {}, shouldStop = () => false, stateDriven = false, mode = process.env.STORAGE_QUARRY_MODE || 'strip_surface_to_floor' }) {
  const plan = surveyStorageQuarry(adapter, bounds, protectedCells, { mode, voidTopology, allowSafeVoidBoundary });
  log(`QUARRY_PLAN ${JSON.stringify({ bounds: plan.bounds, mode: plan.mode, surface: plan.surface, actions: plan.actions.length, deferredVoids: plan.deferred.length, voids: plan.voidTopology?.evidence, materials: plan.materials, blockers: plan.blockers.slice(0, 10) })}`);
  if (plan.blockers.length) return { status: 'BLOCKED', reason: 'UNSAFE_SURVEY', blockers: plan.blockers.length, cleared: 0 };
  let saved = [];
  if (checkpointFile) {
    try {
      const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
      saved = Array.isArray(checkpoint.completed) ? checkpoint.completed : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Checkpoint quarry tidak bisa dibaca: ${error.message}`);
    }
  }
  const completed = [];
  const deferred = [...plan.deferred];
  const savedSet = new Set(saved);
  const remainingActions = plan.actions.filter(({ pos }) => !savedSet.has(`${pos.x},${pos.y},${pos.z}`));
  const carryTarget = Math.min(1, Math.max(0, Number.isFinite(minInventoryFillRatio) ? minInventoryFillRatio : 0.75));
  log(`QUARRY_RESUME ${JSON.stringify({ tersimpan: saved.length, tersisa: remainingActions.length })}`);
  const finish = async (status, reason) => {
    const allCompleted = [...new Set([...saved, ...completed])];
    await writeCheckpoint(checkpointFile, { completed: allCompleted, deferred, phase: 'quarry', remainingAtStart: plan.actions.length, reason });
    const fill = inventoryFill(adapter);
    return { status, reason, cleared: completed.length, deferred: deferred.length, cobblestone: adapter.getItemCount('cobblestone'),
      inventoryFillRatio: fill.ratio, inventoryOccupiedSlots: fill.occupiedSlots, inventoryCapacitySlots: fill.capacitySlots };
  };
  let attempts = 0;
  const failedAttempts = new Map();
  const attemptLimit = stateDriven
    ? Math.max(32, remainingActions.length * 4, 36 * 64)
    : Math.max(32, maxBlocks * 4, 36 * 64);
  while (remainingActions.length &&
      (stateDriven ? inventoryFill(adapter).ratio < carryTarget : completed.length < maxBlocks || inventoryFill(adapter).ratio < carryTarget) &&
      attempts++ < attemptLimit) {
    if (shouldStop()) return finish('PAUSED', 'TIME_LIMIT');
    if ((bot.health ?? 20) < 15 || (bot.food ?? 20) < 10) return finish('PAUSED', 'SURVIVAL');
    // Strict layer barrier: the default strip mode must finish every known
    // solid block at the highest remaining Y before it may descend. Passing
    // the full queue to the pathfinder lets its distance heuristic select a
    // lower nearby block and produces the irregular stepped result seen live.
    const stripMode = mode === 'strip_surface_to_floor' || mode === 'surface_flat_then_stair' || mode === 'strip';
    const activeLayer = stripMode ? remainingActions[0]?.pos.y : null;
    const workQueue = stripMode
      ? remainingActions.filter(action => action.pos.y === activeLayer)
      : remainingActions;
    let selection = adapter.approachReachableWork
      ? await adapter.approachReachableWork(workQueue, shouldStop)
      : adapter.selectReachableWork?.(workQueue);
    if (selection && !selection.target) {
      // Survey lokal bisa belum punya graph lengkap tepat setelah chunk quarry selesai dimuat.
      // Rencana voxel sudah melakukan safety check; pilih target terdekat sebagai fallback dan
      // biarkan adapter.dig melakukan navigasi bounded, alih-alih membatalkan seluruh batch.
      const fallback = workQueue
        .slice()
        .sort((a, b) => (a.priority || 0) - (b.priority || 0) ||
          distance(bot.entity?.position, a.pos) - distance(bot.entity?.position, b.pos))[0];
      if (fallback && selection.status === 'NEEDS_SURVEY') {
        log(`QUARRY_SPATIAL_FALLBACK ${JSON.stringify({ status: selection.status, target: fallback.pos })}`);
        selection = { ...selection, target: fallback, stance: null };
      } else {
        // Bila graph sudah selesai dipindai tetapi tidak ada stance valid,
        // bedakan "tidak ada target reachable" dari error umum. Runtime
        // frontier dapat menandai sel cave/ravine ini exhausted dan maju ke
        // sel berikutnya, bukan mengulang region yang sama tanpa akhir.
        const reason = selection.status === 'NEEDS_ACCESS' ? 'NO_REACHABLE_TARGET' : selection.status;
        return finish('PAUSED', reason);
      }
    }
    const action = selection?.target || remainingActions[0];
    remainingActions.splice(remainingActions.indexOf(action), 1);
    const { pos } = action;
    if (action.expansion && !adapter.isQuarryExpansionColumnSafe?.(pos, bounds)) return finish('PAUSED', 'EXPANSION_NO_LONGER_SAFE');
    if (selection?.stance && !await adapter.navigateNear(selection.stance.position, 0)) {
      // A single stance can be invalidated by a cave edge or a changed chunk.
      // Keep the rest of the surveyed queue alive and let the next target choose
      // another reachable stance instead of aborting the whole worker.
      deferred.push({ pos, reason: 'STANCE_UNREACHABLE' });
      log(`QUARRY_TARGET_DEFERRED ${JSON.stringify(deferred.at(-1))}`);
      continue;
    }
    if (shouldStop()) return finish('PAUSED', 'TIME_LIMIT');
    if ((bot.health ?? 20) < 15 || (bot.food ?? 20) < 10) return finish('PAUSED', 'SURVIVAL');
    if (adapter.getInventoryFreeSlotCount() < 3) return finish('PAUSED', 'INVENTORY_FULL');
    const current = adapter.blockAt(pos);
    if (isAir(current)) continue;
    if (!current || !QUARRY_NAMES.has(current.name)) return finish('PAUSED', 'WORLD_CHANGED');
    if (voidTopology) {
      const voidRisk = inspectMiningTargetVoidRisk(adapter, pos, bounds, voidTopology.policy);
      if (voidRisk.unsafe) {
        deferred.push({ pos, reason: voidRisk.reason, depth: voidRisk.depth });
        log(`QUARRY_VOID_DEFERRED ${JSON.stringify(deferred.at(-1))}`);
        continue;
      }
    }
    const hazardousNeighbour = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]].some(([x, y, z]) => {
      const block = adapter.blockAt({ x: pos.x + x, y: pos.y + y, z: pos.z + z });
      return !block || LIQUID_NAMES.has(block.name);
    });
    if (hazardousNeighbour) return finish('PAUSED', 'LIQUID_OR_UNKNOWN_NEIGHBOUR');
    const hostile = adapter.getEntities().find(entity =>
      ['creeper', 'zombie', 'skeleton', 'spider', 'witch', 'pillager', 'drowned'].includes(entity.name) && entity.position &&
      Math.abs(entity.position.y - bot.entity.position.y) < 4 && entity.position.distanceTo(bot.entity.position) < 10);
    if (hostile) return finish('PAUSED', `HOSTILE_${hostile.name}`);
    const toolKind = SOFT_NAMES.has(current.name) ? 'shovel' : current.boundingBox === 'empty' ? null : 'pickaxe';
    // Dirt/grass boleh dibersihkan dengan tangan sebagai fallback saat shovel besi habis;
    // material keras tetap wajib pickaxe agar worker tidak tersendat lama atau membuat gerakan
    // tidak natural karena mencoba memecah batu tanpa tool.
    if (toolKind === 'pickaxe' && !['iron', 'stone', 'diamond', 'netherite'].some(tier => adapter.getItemCount(`${tier}_${toolKind}`) > 0)) {
      return finish('PAUSED', `MISSING_${toolKind}`);
    }
    // Quarry pickup needs a separate safe route; never descend into the removed block.
    if (action.expansion && !adapter.isQuarryExpansionColumnSafe?.(pos, bounds)) return finish('PAUSED', 'EXPANSION_NO_LONGER_SAFE');
    const feetY = bot.entity?.position?.y;
    if (Number.isFinite(feetY) && pos.y >= Math.floor(feetY) + 1 &&
        !adapter.isQuarryOverheadSafe?.(pos)) {
      deferred.push({ pos, reason: 'UNSAFE_OVERHEAD' });
      log(`QUARRY_TARGET_DEFERRED ${JSON.stringify(deferred.at(-1))}`);
      continue;
    }
    try {
      const dug = await adapter.dig(current, { collectDrops: false });
      if (dug === false) throw new Error('navigasi ke target gagal');
    } catch (error) {
      const targetKey = `${pos.x},${pos.y},${pos.z}`;
      const retries = (failedAttempts.get(targetKey) || 0) + 1;
      failedAttempts.set(targetKey, retries);
      log(`Quarry target gagal ${retries}/3 (${error.message}); ${retries < 3 ? 'dimasukkan kembali ke antrean.' : 'dilewati.'}`);
      if (retries < 3) remainingActions.push(action);
      else deferred.push({ pos, reason: 'DIG_FAILED' });
      if (retries < 3) continue;
      if (remainingActions.length) continue;
      return finish('PAUSED', 'DIG_FAILED');
    }
    if (!isAir(adapter.blockAt(pos))) return finish('PAUSED', 'DIG_UNCONFIRMED');
    completed.push(`${pos.x},${pos.y},${pos.z}`);
    log(`WORK_EVENT ${JSON.stringify({phase:'EXCAVATE',verifiedBlocks:completed.length})}`);
    if (completed.length % 16 === 0) {
      await writeCheckpoint(checkpointFile, { completed: [...new Set([...saved, ...completed])], phase: 'quarry' });
      log(`QUARRY_PROGRESS ${JSON.stringify({ cleared: completed.length, position: pos, cobblestone: adapter.getItemCount('cobblestone'), dirt: adapter.getItemCount('dirt') })}`);
    }
  }
  if (!remainingActions.length && deferred.length) {
    const voidDeferred = deferred.some(item => /VOID|RAVINE|CAVE/.test(item.reason));
    const unreachableDeferred = deferred.some(item => item.reason === 'STANCE_UNREACHABLE');
    return finish('PAUSED', voidDeferred ? 'VOID_BOUNDARY' : unreachableDeferred ? 'NO_REACHABLE_TARGET' : 'UNSAFE_OVERHEAD');
  }
  const fill = inventoryFill(adapter);
  const reason = remainingActions.length === 0 ? 'EXCAVATED' :
    carryTarget === 0 && completed.length >= maxBlocks ? 'BATCH_LIMIT' :
    fill.ratio >= carryTarget ? 'CARRY_TARGET' : 'TARGET_SEARCH_LIMIT';
  const result = await finish(remainingActions.length === 0 ? 'COMPLETE' : 'PAUSED', reason);
  return { ...result, inventoryFillRatio: fill.ratio, inventoryOccupiedSlots: fill.occupiedSlots, inventoryCapacitySlots: fill.capacitySlots };
}

module.exports = { QUARRY_BOUNDS, QUARRY_NAMES, parseQuarryBounds, quarryFloor, inventoryFill,
  surveyStorageQuarry, planSurfaceFlattening, flattenStorageQuarrySurface, excavateStorageQuarry };
