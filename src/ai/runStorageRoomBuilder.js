/**
 * Runner builder storage room melalui Mineflayer.
 * Default hanya preflight. Aktifkan STORAGE_ROOM_EXECUTE=1 setelah origin live diverifikasi.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
// minecraft-data memakai nama rilis kanonis 26.1; server melaporkan patch 26.1.2
// tetapi protokolnya sama-sama 775.
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const fsSync = require('node:fs');
const path = require('node:path');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { claimExternalRoleTask } = require('./externalRoleTask');
const { walkToBase, buildMovements } = require('./walkToBase');
const { createStorageRoomBlueprint } = require('./storageRoomBlueprint');
const { StorageRoomBuilder, NATURAL_EXCAVATION_NAMES } = require('./storageRoomBuilder');
const { supplyStorageMaterial } = require('./storageRoomMaterials');
const { withStorageLock, chestResourceKey } = require('./storageRoomLock');
const fs = require('node:fs/promises');

const BASE_GOAL = { x: -185, y: 71, z: -352 };
const FOOD_SOURCE = { x: -180, y: 72, z: -348 };
const FOOD_NAMES = ['cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'baked_potato', 'bread', 'carrot', 'potato'];

function parseOrigin(raw = process.env.STORAGE_ROOM_ORIGIN) {
  if (!raw) return null;
  const values = raw.split(',').map(Number);
  if (values.length !== 3 || !values.every(Number.isInteger)) throw new Error('STORAGE_ROOM_ORIGIN harus berbentuk x,y,z integer.');
  return { x: values[0], y: values[1], z: values[2] };
}

async function bootstrapTeleport(bot, origin, log) {
  if (typeof bot.chat !== 'function') return false;
  log(`Meminta teleport server-authoritative ke worksite (${origin.x},${origin.y},${origin.z})...`);
  bot.chat(`/tp @s ${origin.x} ${origin.y} ${origin.z}`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const position = bot.entity?.position;
    if (position && Math.hypot(position.x - origin.x, position.z - origin.z) <= 4 && Math.abs(position.y - origin.y) <= 4) {
      log('Teleport server-authoritative berhasil; posisi dikonfirmasi dari entity update.');
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  log('Teleport server-authoritative tidak terkonfirmasi; lanjut memakai pathfinding natural.');
  return false;
}

function partitionBlueprint(blueprint, workerIndex, workerCount = 2) {
  if (!Number.isInteger(workerIndex) || workerIndex < 0) return blueprint;
  const depth = blueprint.dimensions?.depth || 0;
  const count = Math.max(1, Math.min(8, Number(workerCount) || 1));
  if (workerIndex >= count) throw new RangeError(`Worker index ${workerIndex} di luar jumlah worker ${count}.`);
  // Batas selalu di antara baris z; pasangan double chest berada pada satu baris,
  // jadi tidak pernah terbelah di antara dua worker.
  const minZ = Math.floor(workerIndex * depth / count);
  const maxZ = Math.floor((workerIndex + 1) * depth / count) - 1;
  // Entry blocks live just outside z=0 and are shared infrastructure. Assign
  // them to worker zero so the two wings never duplicate or omit the doorway.
  const sharedEntry = workerIndex === 0 ? blueprint.blocks.filter(block => block.phase === 'entry') : [];
  const blocks = [
    ...sharedEntry,
    ...blueprint.blocks.filter(block => block.phase !== 'entry' && block.z >= minZ && block.z <= maxZ)
  ];
  const pairs = blueprint.pairs.filter(pair =>
    pair.left.z >= minZ && pair.left.z <= maxZ && pair.right.z >= minZ && pair.right.z <= maxZ
  );
  const materials = {};
  for (const block of blocks) {
    if (block.name === 'air') continue;
    materials[block.name] = (materials[block.name] || 0) + 1;
  }
  return {
    ...blueprint,
    blocks,
    pairs,
    materials,
    chestBlocks: pairs.length * 2,
    doubleChests: pairs.length,
    inventorySlots: pairs.length * 54,
    wing: workerIndex,
    workerIndex,
    workerCount: count,
    wingBounds: { minZ: workerIndex === 0 ? Math.min(minZ, -2) : minZ, maxZ }
  };
}

function filterBlueprintPhases(blueprint, phases) {
  const requested = Array.isArray(phases)
    ? phases
    : String(phases || '').split(',').map(value => value.trim()).filter(Boolean);
  if (requested.length === 0) return blueprint;
  const allowed = new Set(requested);
  const blocks = blueprint.blocks.filter(block => allowed.has(block.phase));
  const pairs = allowed.has('storage') ? blueprint.pairs : [];
  const materials = {};
  for (const block of blocks) materials[block.name] = (materials[block.name] || 0) + 1;
  return {
    ...blueprint,
    blocks,
    pairs,
    materials,
    chestBlocks: pairs.length * 2,
    doubleChests: pairs.length,
    inventorySlots: pairs.length * 54,
    selectedPhases: [...allowed]
  };
}

function getWorksiteGoal(origin, blueprint) {
  const entryOnly = blueprint.selectedPhases?.length === 1 && blueprint.selectedPhases[0] === 'entry';
  if (entryOnly) return { x: origin.x + 21, y: origin.y + 1, z: origin.z - 4 };
  return {
    x: origin.x - 3,
    y: origin.y + 1,
    z: origin.z + (blueprint.wingBounds?.minZ || 0) + 1
  };
}

function isNearEntryApproach(position, goal, radius = 4) {
  return Boolean(position && goal &&
    Math.hypot(position.x - goal.x, position.z - goal.z) <= radius &&
    Math.abs(position.y - goal.y) <= radius);
}

function configureBuilderMovements(movements, { blueprint, origin, allowTerrainWork }) {
  // Terrain work remains opt-in. When enabled, coordinatedActions reserves the
  // full path volume and this filter limits breaks to the worker's own blueprint wing.
  movements.canDig = allowTerrainWork === true;
  // Saat membangun, target roof berada di atas dinding dan sering tidak bisa
  // dicapai dari lantai. Pathfinder boleh membuat pijakan vertikal sementara
  // hanya di wing milik builder ini; perjalanan spawn/base tetap konservatif.
  movements.allow1by1towers = allowTerrainWork === true;
  const minZ = origin.z + (blueprint.wingBounds?.minZ || 0);
  const maxZ = origin.z + (blueprint.wingBounds?.maxZ ?? blueprint.dimensions.depth - 1);
  // Pathfinder hanya boleh menggali terrain natural di wilayah worker sendiri.
  movements.exclusionAreasBreak.push(block => {
    const p = block.position;
    return p && NATURAL_EXCAVATION_NAMES.has(block.name) &&
      p.x >= origin.x && p.x < origin.x + blueprint.dimensions.width &&
      p.z >= minZ && p.z <= maxZ && p.y >= origin.y &&
      p.y < origin.y + blueprint.dimensions.height ? 0 : 100;
  });
  return movements;
}

function nextPausedRetries(result, previous) {
  return result.built > 0 ? 0 : previous + 1;
}

function isUnsafeSpawnPosition(position, minimumTravelY = 58) {
  return Number.isFinite(position?.y) && position.y < minimumTravelY - 8;
}

function isNearWorksite(position, { origin, blueprint, margin = 4 } = {}) {
  if (!position || !origin || !blueprint?.dimensions) return false;
  const minZ = origin.z + (blueprint.wingBounds?.minZ || 0);
  const maxZ = origin.z + (blueprint.wingBounds?.maxZ ?? blueprint.dimensions.depth - 1);
  return position.x >= origin.x - margin && position.x <= origin.x + blueprint.dimensions.width + margin &&
    position.z >= minZ - margin && position.z <= maxZ + margin;
}

function capBatchRestock(requiredMaterials, remainingMaterials = {}) {
  return Object.fromEntries(Object.entries(requiredMaterials).map(([name, count]) => [
    name, Math.min(remainingMaterials[name] || count, count)
  ]));
}

async function withRestockLock(lockPath, action, log, lockOptions = {}) {
  return withStorageLock(action, {
    lockPath,
    log,
    waitMessage: 'Restock menunggu kapasitas chest sumber...',
    ...lockOptions
  });
}

function acquireInstanceLock(lockPath, { staleMs = 180000, log = () => {} } = {}) {
  if (!lockPath) return () => {};
  fsSync.mkdirSync(path.dirname(lockPath), { recursive: true });
  const acquire = () => {
    try {
      fsSync.mkdirSync(lockPath, { recursive: false });
      fsSync.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ownerAlive = true;
      try {
        const owner = JSON.parse(fsSync.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        if (Number.isInteger(owner.pid)) {
          try { process.kill(owner.pid, 0); } catch (probeError) { ownerAlive = probeError.code !== 'ESRCH'; }
        }
      } catch (ownerError) {
        if (ownerError.code === 'ENOENT') ownerAlive = false;
      }
      if (!ownerAlive) {
        fsSync.rmSync(lockPath, { recursive: true, force: true });
        return acquire();
      }
      try {
        const age = Date.now() - fsSync.statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          fsSync.rmSync(lockPath, { recursive: true, force: true });
          return acquire();
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') return acquire();
        throw statError;
      }
      return false;
    }
  };
  if (!acquire()) throw new Error(`worker/checkpoint sedang dipakai proses lain (${lockPath})`);
  const heartbeat = setInterval(() => {
    try { fsSync.utimesSync(lockPath, new Date(), new Date()); } catch {}
  }, 15000);
  return () => {
    clearInterval(heartbeat);
    try { fsSync.rmSync(lockPath, { recursive: true, force: true }); } catch (error) { log(`Lock worker tidak bisa dibersihkan: ${error.message}`); }
  };
}

function startStorageRoomBuilder({
  host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
  port = Number(process.env.MC_PORT) || 25565,
  botName = process.env.MC_BOT_NAME || 'StorageBuilder',
  origin = parseOrigin(),
  execute = process.env.STORAGE_ROOM_EXECUTE === '1',
  maxBlocks = Number(process.env.STORAGE_ROOM_BATCH) || 32,
  checkpointFile = process.env.STORAGE_ROOM_CHECKPOINT || 'data/storage-room-checkpoint.json',
  minHealth = Number(process.env.STORAGE_ROOM_MIN_HEALTH) || 12,
  placementAttempts = Number(process.env.STORAGE_ROOM_PLACEMENT_ATTEMPTS) || 4,
  placementVerifyTimeoutMs = Number(process.env.STORAGE_ROOM_PLACEMENT_VERIFY_MS) || 5000,
  placementRetryDelayMs = Number(process.env.STORAGE_ROOM_PLACEMENT_RETRY_MS) || 1000,
  allowTerrainWork = process.env.STORAGE_ROOM_ALLOW_TERRAIN_WORK === '1',
  sourceDistance = Number(process.env.STORAGE_ROOM_SOURCE_DISTANCE) || 128,
  skipBaseWalk = process.env.STORAGE_ROOM_SKIP_BASE === '1',
  walkToWorksite = process.env.STORAGE_ROOM_WALK_TO_WORKSITE === '1',
  bootstrapTeleportEnabled = process.env.STORAGE_ROOM_BOOTSTRAP_TP === '1',
  wing = Number.isInteger(Number(process.env.STORAGE_ROOM_WORKER_INDEX || process.env.STORAGE_ROOM_WING)) ? Number(process.env.STORAGE_ROOM_WORKER_INDEX || process.env.STORAGE_ROOM_WING) : null,
  workerCount = Number.isInteger(Number(process.env.STORAGE_ROOM_WORKER_COUNT)) ? Number(process.env.STORAGE_ROOM_WORKER_COUNT) : (wing === null ? 1 : 2),
  restockLockPath = process.env.STORAGE_ROOM_RESTOCK_LOCK || '',
  continuous = process.env.STORAGE_ROOM_CONTINUOUS === '1',
  maxPausedRetries = Number(process.env.STORAGE_ROOM_MAX_PAUSED_RETRIES) || 12,
  pauseDelayMs = Number(process.env.STORAGE_ROOM_PAUSE_DELAY_MS) || 3000,
  startDelayMs = Number(process.env.STORAGE_ROOM_START_DELAY_MS) || 0,
  foodSearchCount = Number(process.env.STORAGE_ROOM_FOOD_SEARCH_COUNT) || 160,
  foodSearchMaxSources = Number(process.env.STORAGE_ROOM_FOOD_SEARCH_SOURCES) || 8,
  materialSearchCount = Number(process.env.STORAGE_ROOM_MATERIAL_SEARCH_COUNT) || 32,
  materialFallbackSearch = process.env.STORAGE_ROOM_MATERIAL_FALLBACK_SEARCH === '1',
  allowMaterialProcessing = process.env.STORAGE_ROOM_ALLOW_MATERIAL_PROCESSING !== '0',
  healthRecoveryMs = Number(process.env.STORAGE_ROOM_HEALTH_RECOVERY_MS) || 30000,
  maxRunMs = Number(process.env.STORAGE_ROOM_MAX_RUN_MS) || 0,
  minimumTravelY = Number(process.env.STORAGE_ROOM_MIN_TRAVEL_Y) || 58,
  instanceLockPath = process.env.STORAGE_ROOM_INSTANCE_LOCK || '',
  log = message => console.log(message)
} = {}) {
  if (!origin) throw new Error('Origin belum diberikan. Set STORAGE_ROOM_ORIGIN=x,y,z setelah survei live menyatakan area aman.');
  const username = String(botName).slice(0, 16);
  if (username !== botName) log(`Nama bot dipotong menjadi maksimal 16 karakter: ${username}`);
  log(`Menghubungkan builder ${username} ke ${host}:${port}...`);
  const lockPath = instanceLockPath || path.resolve(`${checkpointFile}.${username}.lock`);
  const releaseInstanceLock = acquireInstanceLock(lockPath, { log });
  let bot;
  try {
    bot = mineflayer.createBot({ host, port, username, version: SERVER_VERSION, auth: 'offline', plugins: { time: false } });
  } catch (error) {
    releaseInstanceLock();
    throw error;
  }
  let finished = false;
  let spawned = false;
  let died = false;
  let respawnTimer;
  let runTimer;
  let spawnTimer;
  let roleTask = null;
  const finish = (code, verification = null) => {
    if (finished) return;
    finished = true;
    if (roleTask) {
      if (code === 0 && verification) roleTask.complete({ exitCode: code, role: 'builder', verification });
      else roleTask.defer(`PROCESS_EXIT_${code}`, 5000);
      roleTask = null;
    }
    clearTimeout(spawnTimer);
    clearTimeout(runTimer);
    clearTimeout(respawnTimer);
    releaseInstanceLock();
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
    bot.quit();
    setTimeout(() => process.exit(code), 250);
  };
  if (maxRunMs > 0) runTimer = setTimeout(() => {
    log('STOP: batas sesi tercapai; blok terverifikasi tersimpan di checkpoint.');
    finish(2);
  }, maxRunMs);
  const spawnTimeoutMs = Number(process.env.STORAGE_ROOM_SPAWN_TIMEOUT_MS) || 30000;
  spawnTimer = setTimeout(() => {
    if (spawned || finished) return;
    log(`STOP: event spawn tidak diterima setelah ${spawnTimeoutMs}ms; koneksi builder ditutup dan lock dibersihkan.`);
    finish(2);
  }, spawnTimeoutMs);
  bot.once('spawn', async () => {
    if (died || finished) return;
    spawned = true;
    clearTimeout(spawnTimer);
    try {
    const reportWork = (phase, extra = {}) => {
      const details = { phase, ...extra };
      log(`WORK_EVENT ${JSON.stringify(details)}`);
      roleTask?.reportProgress(details);
    };
    reportWork('PREPARE');
    bot.loadPlugin(pathfinder);
    bot.pathfinder.setMovements(buildMovements(bot));
    bot.pathfinder.thinkTimeout = 30000;
    const adapter = new MineflayerRoleAdapter(bot, {
      log,
      capabilities: ['build', 'craft', 'haul'],
      // Builder wing sudah dipisah secara geometris. Shared memory tetap aktif,
      // tetapi reservasi koridor global dimatikan agar bot tidak memblokir akses
      // miner/materials hanya karena berdiri dekat pintu base.
      coordinateMovement: process.env.STORAGE_ROOM_COORDINATE_MOVEMENT !== '0'
    });
    roleTask = claimExternalRoleTask(adapter, { taskTypes: ['BUILD_STORAGE'], capabilities: ['build'], log });
    log(`Spawn builder di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
    if (isUnsafeSpawnPosition(bot.entity.position, minimumTravelY) && !bootstrapTeleportEnabled) {
      log(`STOP: posisi spawn terlalu rendah (${bot.entity.position.y.toFixed(1)}); worker tidak akan mencoba rute palsu dari gua. Pulihkan posisi secara server-authoritative atau login ulang dari spawn yang aman.`);
      finish(2);
      return;
    }
    if (!skipBaseWalk) {
      const walk = await walkToBase({ bot, goal: BASE_GOAL, range: 4, settleMs: 3000, minimumY: minimumTravelY, allowTerrainWork: false, allow1by1Towers: false, log });
      if (!walk.success) {
        log(`STOP: builder belum sampai base (${walk.reason})`);
        finish(2);
        return;
      }
      if (execute) {
        try { await adapter.setSpawnAtNearestBed(24); } catch (error) { log(`Bed base belum terjangkau: ${error.message}`); }
        await withRestockLock(restockLockPath, async () => {
          if ((bot.food ?? 20) < 18 && !adapter.hasItem(FOOD_NAMES)) await adapter.withdrawFromChest(FOOD_SOURCE, FOOD_NAMES, 32);
          for (let bites = 0; bites < 16 && (bot.food ?? 20) < 18; bites += 1) {
            if (!await adapter.eatBestFood(FOOD_NAMES)) break;
          }
        }, log, { resourceKey: chestResourceKey(FOOD_SOURCE, adapter) });
        const recoveryDeadline = Date.now() + healthRecoveryMs;
        while (bot.health < minHealth + 3 && bot.food >= 18 && Date.now() < recoveryDeadline) await new Promise(resolve => setTimeout(resolve, 1000));
        if (bot.health < minHealth) { log('STOP: health belum cukup untuk perjalanan ke worksite.'); finish(2); return; }
      }
    } else {
      log('Mode survei: perjalanan otomatis ke base dilewati; menunggu posisi live yang diberikan.');
    }
    if (startDelayMs > 0) await new Promise(resolve => setTimeout(resolve, startDelayMs));
    let chunkTimer;
    try {
      await Promise.race([
        bot.waitForChunksToLoad(),
        new Promise((_, reject) => { chunkTimer = setTimeout(() => reject(new Error('chunk spawn belum siap')), 15000); })
      ]);
    } finally { clearTimeout(chunkTimer); }
    const partitionedBlueprint = partitionBlueprint(createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' }), wing, workerCount);
    const blueprint = filterBlueprintPhases(partitionedBlueprint, process.env.STORAGE_ROOM_PHASES);
    if (blueprint.selectedPhases) log(`Fase builder dibatasi ke: ${blueprint.selectedPhases.join(', ')}.`);
    const position = bot.entity.position;
    // Jangan arahkan pathfinder ke sudut blueprint yang kelak berupa blok solid. Titik pendekatan
    // di luar dinding lebih mudah diinjak dan tetap membuat chunk sayap termuat sebelum preflight.
    const worksiteGoal = getWorksiteGoal(origin, blueprint);
    const entryOnly = blueprint.selectedPhases?.length === 1 && blueprint.selectedPhases[0] === 'entry';
    if (bootstrapTeleportEnabled) await bootstrapTeleport(bot, origin, log);
    const isAtWorksite = entryOnly
      ? isNearEntryApproach(bot.entity?.position, worksiteGoal)
      : isNearWorksite(bot.entity?.position, { origin, blueprint });
    if (walkToWorksite && !isAtWorksite) {
      const walk = await walkToBase({ bot, goal: worksiteGoal, range: 4, maxGotoMs: 45000, settleMs: 1000, minimumY: minimumTravelY, allowTerrainWork: false, allow1by1Towers: false, log });
      if (!walk.success) {
        log(`STOP: builder belum sampai worksite (${walk.reason})`);
        finish(2);
        return;
      }
    } else if (walkToWorksite) {
      log('Posisi bot sudah di sekitar sayap worksite; perjalanan eksplisit dilewati.');
    }
    const setBuilderMovements = () => {
      const scaffoldingBlocks = ['cobblestone', 'dirt']
        .filter(name => adapter.getItemCount(name) > 0)
        .map(name => bot.registry?.itemsByName?.[name]?.id)
        .filter(Number.isInteger);
      const movements = configureBuilderMovements(buildMovements(bot, { scaffoldingBlocks }), { blueprint, origin, allowTerrainWork: execute && allowTerrainWork });
      log(`[Builder] Pijakan pathfinder: cobblestone=${adapter.getItemCount('cobblestone')}, dirt=${adapter.getItemCount('dirt')}, candidates=${movements.scafoldingBlocks?.length || 0}.`);
      bot.pathfinder.setMovements(movements);
    };
    setBuilderMovements();
    const sourceCache = new Map();
    const sourceSearchState = new Map();
    const sourceKey = names => [...names].sort().join('|');
    const findMaterialSource = async (names, options = {}) => {
      const cacheKey = sourceKey(names);
      const cached = sourceCache.get(cacheKey);
      if (cached) return cached;
      const state = sourceSearchState.get(cacheKey) || { attempted: [], exhausted: false, exhaustedAt: 0 };
      // Isi chest berubah ketika materials worker selesai smelting. Cache kosong
      // tidak boleh menjadi keputusan permanen; ulangi pencarian bounded setelah
      // cooldown agar stok baru bisa ditemukan tanpa scan pada setiap tick.
      if (state.exhausted && Date.now() - (state.exhaustedAt || 0) < 15000) return null;
      if (state.exhausted) {
        state.attempted = [];
        state.exhausted = false;
        state.exhaustedAt = 0;
      }
      const source = await adapter.findMatchingChest(names, { ...options, excludePositions: state.attempted });
      if (source) sourceCache.set(cacheKey, source);
      else {
        state.exhausted = true;
        state.exhaustedAt = Date.now();
        sourceSearchState.set(cacheKey, state);
      }
      return source;
    };
    const withdrawFromMaterialSource = async (names, count, options = {}, chestLock = null) => {
      if (!(count > 0)) return { withdrawn: 0, source: null };
      const cacheKey = sourceKey(names);
      const source = await findMaterialSource(names, options);
      if (!source) return { withdrawn: 0, source: null };
      let result = { withdrawn: 0 };
      const withdraw = () => adapter.withdrawFromChest(source, names, count);
      try {
        result = typeof chestLock === 'function'
          ? await chestLock(withdraw, { resourceKey: chestResourceKey(source, adapter) })
          : await withdraw();
      }
      catch (error) { log(`Restock sumber ${names.join('/')} gagal: ${error.message}`); }
      if (result.withdrawn <= 0) {
        sourceCache.delete(cacheKey);
        const state = sourceSearchState.get(cacheKey) || { attempted: [], exhausted: false };
        state.attempted.push(source);
        sourceSearchState.set(cacheKey, state);
      }
      return { ...result, source };
    };
    if (blueprint.wing !== undefined) log(`Worker segmen ${blueprint.workerIndex + 1}/${blueprint.workerCount}: z relatif ${blueprint.wingBounds.minZ}-${blueprint.wingBounds.maxZ}, ${blueprint.doubleChests} double chest.`);
    let lastRestockKey = '';
    let lastRestockAt = 0;
    let noProgressRestockAttempts = 0;
    let scaffoldingPrepared = false;
    const builder = new StorageRoomBuilder({
      bot,
      adapter,
      blueprint,
      origin,
      checkpointFile,
      options: {
        log,
        minHealth,
        placementAttempts,
        placementVerifyTimeoutMs,
        placementRetryDelayMs,
        repairExistingChests: process.env.STORAGE_ROOM_REPAIR_EMPTY_CHESTS === '1',
        requiresScaffolding: execute && allowTerrainWork && blueprint.blocks.some(block => block.phase === 'roof'),
        allowFoundationFill: allowTerrainWork,
        allowExcavation: allowTerrainWork,
        // Bahan diambil bertahap dari peti yang sudah ada; bot tidak perlu membawa 4.353 batu
        // sekaligus. Gagal menemukan sumber membuat builder berhenti tanpa mutasi blok dunia.
        restockMaterials: async (requiredMaterials, activeBuilder) => {
          const remainingMaterials = activeBuilder.remainingMaterials();
          requiredMaterials = capBatchRestock(requiredMaterials, remainingMaterials);
          const restockKey = JSON.stringify(requiredMaterials);
          if (restockKey === lastRestockKey && noProgressRestockAttempts > 0 && Date.now() - lastRestockAt < 15000) {
            log(`Restock ditunda: sumber material belum berubah (${Math.ceil((15000 - (Date.now() - lastRestockAt)) / 1000)}s).`);
            reportWork('WAITING_MATERIAL', { verifiedBlocks: 0, reason: 'MATERIAL_SOURCE_UNCHANGED' });
            return;
          }
          lastRestockKey = restockKey;
          lastRestockAt = Date.now();
          let restocked = false;
      const withChestLock = (action, lockOptions = {}) => withRestockLock(restockLockPath, action, log, lockOptions);
          const supplyWalk = await walkToBase({ bot, goal: BASE_GOAL, range: 4, maxGotoMs: 45000, minimumY: minimumTravelY, allowTerrainWork: false, allow1by1Towers: false, log });
          if (!supplyWalk.success) {
            log(`STOP: builder tidak bisa kembali ke base untuk restock (${supplyWalk.reason}).`);
            return;
          }
          const healthTarget = minHealth + 3;
          if ((bot.food ?? 20) < 18 || (bot.health ?? 20) < healthTarget) {
            const foodTarget = (bot.health ?? 20) < healthTarget ? 20 : 18;
            const foodNames = FOOD_NAMES;
            for (let attempt = 0; attempt < 12 && (bot.food ?? 20) < foodTarget; attempt += 1) {
              if (!await adapter.eatBestFood(foodNames)) break;
              restocked = true;
            }
            const foodSources = [FOOD_SOURCE];
            let foodSource = null;
            let foodResult = { withdrawn: 0 };
            for (const candidate of foodSources) {
              let withdrawnTotal = 0;
              for (let attempt = 0; attempt < 4 && (bot.food ?? 20) < foodTarget; attempt += 1) {
                try {
                  foodResult = await withChestLock(() => adapter.withdrawFromChest(candidate, foodNames, 16), { resourceKey: chestResourceKey(candidate, adapter) });
                } catch (error) {
                  log(`Restock makanan gagal di (${candidate.x},${candidate.y},${candidate.z}): ${error.message}`);
                  foodResult = { withdrawn: 0 };
                }
                withdrawnTotal += foodResult.withdrawn;
                if (foodResult.withdrawn <= 0) break;
                let ate = false;
                for (let bites = 0; bites < 16 && (bot.food ?? 20) < foodTarget; bites += 1) {
                  if (!await adapter.eatBestFood(foodNames)) break;
                  ate = true;
                }
                log(ate ? 'Bot makan sebelum melanjutkan pembangunan.' : 'Makanan tersedia, tetapi belum berhasil dimakan.');
              }
              if (withdrawnTotal > 0) { foodSource = candidate; foodResult = { withdrawn: withdrawnTotal }; break; }
            }
            if (!foodSource) {
              const attemptedSources = [];
              for (let sourceAttempt = 0; sourceAttempt < foodSearchMaxSources && (bot.food ?? 20) < foodTarget; sourceAttempt += 1) {
                const candidate = await adapter.findMatchingChest(foodNames, {
                  maxDistance: sourceDistance,
                  count: foodSearchCount,
                  excludePositions: attemptedSources
                });
                if (!candidate) break;
                attemptedSources.push(candidate);
                let candidateResult = { withdrawn: 0 };
                try {
                  candidateResult = await withChestLock(() => adapter.withdrawFromChest(candidate, foodNames, 16), { resourceKey: chestResourceKey(candidate, adapter) });
                } catch (error) {
                  log(`Restock makanan gagal: ${error.message}`);
                }
                if (candidateResult.withdrawn <= 0) continue;
                foodSource = candidate;
                foodResult = candidateResult;
                let ate = false;
                for (let attempt = 0; attempt < 16 && (bot.food ?? 20) < foodTarget; attempt += 1) {
                  const consumed = await adapter.eatBestFood(foodNames);
                  ate = ate || consumed;
                  if (!consumed) break;
                }
                log(ate ? `Bot makan dari peti fallback (food=${bot.food ?? 'unknown'}) sebelum melanjutkan pembangunan.` : 'Makanan fallback tersedia, tetapi belum berhasil dimakan.');
                restocked = true;
              }
            }
            if ((bot.food ?? 20) < foodTarget && typeof adapter.craftItem === 'function') {
                const wheatSource = adapter.getItemCount('wheat') >= 3 ? null : await findMaterialSource(['wheat'], {
                maxDistance: sourceDistance,
                count: foodSearchCount
              });
              if (wheatSource) {
                let wheatResult = { withdrawn: 0 };
                try {
                  wheatResult = await withChestLock(() => adapter.withdrawFromChest(wheatSource, ['wheat'], 27), { resourceKey: chestResourceKey(wheatSource, adapter) });
                } catch (error) {
                  log(`Restock wheat untuk crafting gagal: ${error.message}`);
                }
                if (wheatResult.withdrawn <= 0) {
                  sourceCache.delete(sourceKey(['wheat']));
                  const state = sourceSearchState.get(sourceKey(['wheat'])) || { attempted: [], exhausted: false };
                  state.attempted.push(wheatSource);
                  sourceSearchState.set(sourceKey(['wheat']), state);
                }
                const wheatCount = adapter.getItemCount('wheat');
                if (wheatCount >= 3) {
                  let crafted = false;
                  try {
                    crafted = await adapter.craftItem('bread', Math.floor(wheatCount / 3));
                  } catch (error) {
                    log(`Craft bread gagal: ${error.message}`);
                  }
                  log(crafted ? `Craft bread dari ${wheatCount} wheat.` : 'Craft bread gagal: crafting table atau resep tidak tersedia.');
                  if (crafted) {
                    let ate = false;
                    for (let attempt = 0; attempt < 4 && (bot.food ?? 20) < foodTarget; attempt += 1) {
                      const consumed = await adapter.eatBestFood(foodNames);
                      ate = ate || consumed;
                      if (!consumed) break;
                    }
                    log(ate ? `Bot makan bread hasil crafting (food=${bot.food ?? 'unknown'}).` : 'Bread hasil crafting belum berhasil dimakan.');
                    restocked = true;
                  }
                }
              }
            }
            if (foodSource) {
              log(`Restock makanan: ${foodResult.withdrawn}/16 dari peti (${foodSource.x},${foodSource.y},${foodSource.z}).`);
              if (foodResult.withdrawn > 0) {
                restocked = true;
              }
            } else if ((bot.food ?? 20) < foodTarget) {
              log('Food rendah; tidak ada peti sumber makanan yang terdeteksi.');
            }
          }
          if ((bot.health ?? 20) < healthTarget && (bot.food ?? 20) >= 18) {
            const deadline = Date.now() + healthRecoveryMs;
            log(`Menunggu regenerasi health di base (${bot.health}/${healthTarget})...`);
            while ((bot.health ?? 20) < healthTarget && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            log(`Health setelah regenerasi: ${bot.health ?? 'unknown'}.`);
            if ((bot.health ?? 20) < healthTarget) {
              log(`STOP restock: health belum aman (${bot.health}/${minHealth}); bot tidak kembali ke worksite.`);
              return;
            }
          }
          for (const [name, required] of Object.entries(requiredMaterials)) {
            const missing = required - adapter.getItemCount(name);
            if (missing <= 0) continue;
            // Fallback live dikendalikan di bawah dengan batas materialSearchCount.
            // Jangan mengaktifkan fallback default supplyStorageMaterial (96 chest),
            // karena builder akan melakukan dua scan berurutan dan tampak macet di base.
            const supply = await supplyStorageMaterial({ bot, adapter, name, required, log, withLock: withChestLock, allowProcessing: allowMaterialProcessing, allowCrafting: name.endsWith('_door'), fallbackSearch: false });
            const remaining = supply.missing;
            restocked = restocked || supply.added > 0;
            if (remaining <= 0) continue;
            if (!materialFallbackSearch) {
              log(`Material ${name} kurang ${remaining}; fallback scan seluruh chest dimatikan karena sumber material resmi sudah dipetakan.`);
              continue;
            }
            const sourceResult = await withdrawFromMaterialSource(
              [name],
              remaining,
              { maxDistance: sourceDistance, count: materialSearchCount },
              withChestLock
            );
            const source = sourceResult.source;
            if (!source) {
              log(`Material ${name} kurang ${missing}; tidak ada peti sumber yang terdeteksi.`);
              continue;
            }
            const result = sourceResult;
            log(`Restock ${name}: ${result.withdrawn}/${missing} dari peti (${source.x},${source.y},${source.z}).`);
            restocked = restocked || result.withdrawn > 0;
          }
          // Atap berada di atas ruang kosong; pathfinder hanya dapat menaikkan
          // builder secara survival bila ia membawa pijakan sementara. Ambil
          // batch kecil dari rumah cobblestone, bukan menghabiskan material
          // stone_bricks bangunan dan bukan memindai seluruh gudang.
          if (!scaffoldingPrepared || adapter.getItemCount('cobblestone') < 8) {
            const scaffoldBefore = adapter.getItemCount('cobblestone');
            const scaffoldNeed = Math.max(0, 24 - scaffoldBefore);
            if (scaffoldNeed > 0) {
              try {
                const scaffoldResult = await withChestLock(
                  () => adapter.withdrawFromChest({ x: -181, y: 71, z: -352 }, ['cobblestone'], scaffoldNeed),
                  { resourceKey: chestResourceKey({ x: -181, y: 71, z: -352 }, adapter) }
                );
                if (scaffoldResult.withdrawn > 0) {
                  restocked = true;
                  log(`Bekal pijakan builder: ${scaffoldResult.withdrawn} cobblestone.`);
                }
              } catch (error) {
                log(`Bekal pijakan builder gagal: ${error.message}`);
              }
            }
            scaffoldingPrepared = adapter.getItemCount('cobblestone') > 0;
          }
          if ((bot.health ?? 20) < healthTarget) return;
          if (restocked) {
            const returnWalk = await walkToBase({
              bot,
              goal: worksiteGoal,
              range: 4,
              maxGotoMs: 45000,
              minimumY: minimumTravelY,
              allowTerrainWork: false,
              allow1by1Towers: false,
              log
            });
            if (!returnWalk.success) log(`STOP: builder gagal kembali ke worksite (${returnWalk.reason}).`);
          }
          if (restocked) noProgressRestockAttempts = 0;
          else noProgressRestockAttempts += 1;
          reportWork(restocked ? 'RESTOCK' : 'WAITING_MATERIAL', {
            verifiedBlocks: 0,
            reason: restocked ? undefined : 'MATERIAL_UNAVAILABLE'
          });
          setBuilderMovements();
        }
      }
    });
    // Checkpoint dapat membuat blok berikutnya berada jauh dari sudut awal sayap. Muat progres
    // lebih dulu lalu dekati target berikutnya supaya chunk target dan fondasinya tersedia saat
    // preflight. Tanpa langkah ini, blok valid di tepi view-distance keliru dilaporkan UNKNOWN.
    await builder.loadCheckpoint();
    const nextBuildBlock = builder.remainingBlocks()[0];
    if (nextBuildBlock && typeof adapter.navigateNear === 'function') {
      const nextBuildTarget = builder.absolute(nextBuildBlock);
      const current = adapter.getPosition();
      if (!current || Math.hypot(current.x - nextBuildTarget.x, current.z - nextBuildTarget.z) > 12) {
        log(`Memuat area blok berikutnya di (${nextBuildTarget.x},${nextBuildTarget.y},${nextBuildTarget.z}) sebelum preflight...`);
        const reached = await adapter.navigateNear(nextBuildTarget, 4);
        if (!reached) log('Area blok berikutnya belum terjangkau; preflight akan menilai data voxel yang tersedia secara fail-closed.');
        else await new Promise(resolve => setTimeout(resolve, 750));
      }
    }
    if (allowTerrainWork) log('Terrain-work aktif: builder boleh menggali blok natural dan mengisi fondasi sesuai batas preflight.');
    const preflight = await builder.preflight({ maxBlocks });
    log(`Preflight: ${JSON.stringify({ ok: preflight.ok, health: bot.health, food: bot.food, minHealth, batchBlocks: preflight.batchBlocks, foundationBlocks: builder.foundationBlocks.length, requiredMaterials: preflight.requiredMaterials, remainingMaterials: preflight.remainingMaterials, missingMaterials: preflight.missingMaterials, blockedCount: preflight.blockedCount, hazard: preflight.hazard })}`);
    if (!execute) {
      log('Mode observasi: tidak ada blok yang dipasang. Set STORAGE_ROOM_EXECUTE=1 setelah hasil preflight aman.');
      finish(preflight.ok ? 0 : 2);
      return;
    }
    let result = await builder.build({ maxBlocks });
    log(`Hasil builder: ${JSON.stringify(result)}`);
    reportWork(result.status === 'COMPLETE' ? 'COMPLETE' : result.status === 'BLOCKED' ? 'BLOCKED' : 'BUILD', {
      verifiedBlocks: Number.isInteger(result.built) ? result.built : 0,
      buildPhase: result.phase,
      remainingBlocks: result.remainingBlocks,
      reason: result.reason || result.code || undefined
    });
    if (!continuous) {
      const complete = result.status === 'COMPLETE' && Number(result.remainingBlocks || 0) === 0;
      finish(complete ? 0 : 2, complete ? {
        status: 'VERIFIED', observedAt: Date.now(),
        checks: [{ name: 'blueprint_remaining_blocks', passed: true, expected: 0, actual: 0 }]
      } : null);
      return;
    }
    let pausedRetries = 0;
    while (result.status !== 'COMPLETE') {
      const recoverableBlock = result.status === 'BLOCKED' &&
        (Object.keys(result.missingMaterials || {}).length > 0 ||
          typeof result.hazard === 'string' &&
          (result.hazard.startsWith('food rendah') || result.hazard.startsWith('health rendah') || result.hazard.startsWith('mob berbahaya terlalu dekat')));
      if (result.status !== 'PAUSED' && !recoverableBlock) {
        finish(2);
        return;
      }
      pausedRetries = nextPausedRetries(result, pausedRetries);
      if (pausedRetries > maxPausedRetries) {
        log(`STOP continuous: terlalu banyak pause berturut-turut (${maxPausedRetries}), blocker terakhir=${result.code || 'UNKNOWN'}.`);
        finish(2);
        return;
      }
      log(`Batch berikutnya; kegagalan tanpa progres ${pausedRetries}/${maxPausedRetries}.`);
      await new Promise(resolve => setTimeout(resolve, pauseDelayMs));
      result = await builder.build({ maxBlocks });
      log(`Hasil builder: ${JSON.stringify(result)}`);
      reportWork(result.status === 'COMPLETE' ? 'COMPLETE' : result.status === 'BLOCKED' ? 'BLOCKED' : 'BUILD', {
        verifiedBlocks: Number.isInteger(result.built) ? result.built : 0,
        buildPhase: result.phase,
        remainingBlocks: result.remainingBlocks,
        reason: result.reason || result.code || undefined
      });
    }
    const complete = result.status === 'COMPLETE' && Number(result.remainingBlocks || 0) === 0;
    finish(complete ? 0 : 2, complete ? {
      status: 'VERIFIED', observedAt: Date.now(),
      checks: [{ name: 'blueprint_remaining_blocks', passed: true, expected: 0, actual: 0 }]
    } : null);
    } catch (error) {
      if (finished || died) return;
      log(`STOP builder: ${error.stack || error.message}`);
      finish(2);
    }
  });
  bot.on('death', () => {
    died = true;
    log('STOP builder: bot mati; menunggu respawn normal sebelum logout.');
    bot.once('spawn', () => finish(2));
    respawnTimer = setTimeout(() => finish(2), 10000);
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
  });
  bot.on('error', error => log(`ERROR builder: ${error.message}`));
  bot.on('kicked', reason => log(`DIKICK builder: ${JSON.stringify(reason)}`));
  bot.on('end', () => { if (!finished) { log('Koneksi builder berakhir sebelum proses selesai.'); finish(2); } });
  return bot;
}

module.exports = { startStorageRoomBuilder, parseOrigin, partitionBlueprint, filterBlueprintPhases, getWorksiteGoal, isNearEntryApproach, configureBuilderMovements, nextPausedRetries, capBatchRestock, acquireInstanceLock, isUnsafeSpawnPosition, isNearWorksite };

if (require.main === module) {
  try { startStorageRoomBuilder(); } catch (error) { console.error(`GAGAL memulai builder: ${error.message}`); process.exitCode = 2; }
}
