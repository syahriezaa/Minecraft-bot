/** Menjalankan quarry terukur untuk memasok stone/cobblestone storage room. */
const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
patchMineflayerVersionGate(process.env.MC_REMOTE_VERSION || '26.1');
const mineflayer = require('mineflayer');
const { pathfinder, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('node:fs/promises');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { buildMovements, walkToBase } = require('./walkToBase');
const { prepareStorageRoomTools } = require('./storageRoomToolPreparation');
const { supplyStorageMaterial } = require('./storageRoomMaterials');
const { excavateStorageQuarry, flattenStorageQuarrySurface, parseQuarryBounds, surveyStorageQuarry } = require('./storageRoomQuarry');
const { runAdaptiveMiningFrontier } = require('./adaptiveMiningRuntime');
const { surveyAdaptiveMiningCell } = require('./adaptiveMiningSurvey');
const { buildQuarryAccess, deriveLegacyQuarryAccessPath } = require('./quarryAccess');
const { NATURAL_NAMES } = require('./storageRoomLandscaper');
const { withStorageLock, chestResourceKey } = require('./storageRoomLock');
const { claimExternalRoleTask } = require('./externalRoleTask');

const BASE = { x: -185, y: 71, z: -352 };
const STONE_CHEST = { x: -181, y: 71, z: -352 };
const STONE_OVERFLOW_CHEST = { x: -181, y: 73, z: -344 };
const LOCK = process.env.STORAGE_ROOM_RESTOCK_LOCK || 'data/storage-room-restock.lock';
const QUARRY_DEPOSIT_NAMES = new Set([
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'dirt', 'grass_block',
  'gravel', 'sand', 'clay', 'granite', 'diorite', 'andesite', 'tuff',
  'coal', 'raw_iron', 'raw_copper', 'raw_gold', 'iron_ore', 'copper_ore', 'coal_ore'
]);
const BOOTSTRAP_TERRAIN_NAMES = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'sand', 'gravel', 'clay', 'snow', 'snow_block', 'mud',
  // Region quarry sudah disurvey sebagai area kerja tanpa struktur. Batu dan turunannya
  // perlu diizinkan saat bootstrap supaya bot dapat membuka pijakan/tangga dari permukaan;
  // izin ini tidak dibawa ke navigasi base atau builder.
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'tuff',
  'andesite', 'diorite', 'granite', 'terracotta'
]);

function countQuarryMaterials(adapter) {
  if (typeof adapter?.getItemCount !== 'function') return 0;
  return [...QUARRY_DEPOSIT_NAMES].reduce((total, name) => total + Math.max(0, Number(adapter.getItemCount(name)) || 0), 0);
}

function quarryMaxSafeDrop() {
  // Beberapa blok masih dapat dinaiki kembali, tetapi jangan pernah membuka
  // kebijakan jatuh tanpa batas. Tiga blok memberi ruang untuk lubang lama;
  // ravine/cave yang lebih dalam tetap masuk jalur inspeksi khusus.
  return Math.max(1, Math.min(4, Number(process.env.STORAGE_QUARRY_MAX_SAFE_DROP) || 3));
}

function shouldDeliverQuarryResult(result, carriedMaterials = 0) {
  return Number(result?.cleared) > 0 || Number(carriedMaterials) > 0;
}

function frontierApproachTarget(bounds, mode = 'surface_to_floor') {
  const surfaceMode = mode !== 'depth_first';
  return {
    x: bounds.minX - 1,
    y: surfaceMode ? bounds.maxY - 3 : bounds.floorY + 1,
    z: Math.floor((bounds.minZ + bounds.maxZ) / 2),
    goalXZOnly: surfaceMode,
    minimumY: surfaceMode ? Math.max(bounds.floorY, bounds.maxY - 24) : bounds.floorY
  };
}

function isImmediateCarrySafetyOverride(reason) {
  return ['SURVIVAL', 'INVENTORY_FULL', 'LIQUID_OR_UNKNOWN_NEIGHBOUR', 'UNSAFE_OVERHEAD',
    'VOID_BOUNDARY', 'NO_REACHABLE_TARGET', 'NO_SAFE_TARGET', 'TOOL_LOW', 'LOW_HEALTH', 'LOW_FOOD',
    'MISSING_pickaxe', 'MISSING_shovel', 'DIG_UNCONFIRMED', 'FRONTIER_']
    .some(prefix => String(reason || '').startsWith(prefix));
}

function isRetryableAccessFailure(reason) {
  return ['NO_REACHABLE_ENTRANCE', 'EXISTING_PATH_UNREACHABLE', 'EXISTING_RETURN_UNREACHABLE',
    'ENTRANCE_UNREACHABLE', 'STEP_UNREACHABLE', 'RETURN_UNREACHABLE',
    'SUPPORT_UNCONFIRMED', 'UNSAFE_CLEARANCE', 'HAZARD_OR_UNKNOWN']
    .some(prefix => String(reason || '').startsWith(prefix));
}

function shouldRecoverQuarrySpawnToBase(position, bounds) {
  if (!position || !bounds) return false;
  const insideFootprint = position.x >= bounds.minX - 1 && position.x <= bounds.maxX + 1 &&
    position.z >= bounds.minZ - 1 && position.z <= bounds.maxZ + 1;
  return insideFootprint && position.y < bounds.floorY - 2;
}

function isInsideQuarryFootprint(position, bounds, margin = 1) {
  if (!position || !bounds) return false;
  return position.x >= bounds.minX - margin && position.x <= bounds.maxX + margin &&
    position.z >= bounds.minZ - margin && position.z <= bounds.maxZ + margin;
}

function needsQuarryAccessExit(position, bounds) {
  return isInsideQuarryFootprint(position, bounds) && position.y < bounds.maxY - 3;
}

async function followQuarryAccessPath({ bot, adapter, accessPath = [], bounds, log = () => {}, shouldStop = () => false }) {
  const position = bot?.entity?.position;
  if (!needsQuarryAccessExit(position, bounds)) return { success: true, skipped: true, reason: 'ALREADY_OUTSIDE_QUARRY_ACCESS' };
  if (!Array.isArray(accessPath) || accessPath.length === 0) return { success: false, reason: 'NO_VERIFIED_ACCESS_PATH' };
  if (typeof adapter?.navigateNear !== 'function') return { success: false, reason: 'NO_NAVIGATOR' };

  const distanceToFeet = step => Math.hypot(
    (position.x || 0) - step.x - 0.5,
    (position.y || 0) - step.y - 1,
    (position.z || 0) - step.z - 0.5
  );
  const nearestIndex = accessPath.reduce((best, step, index) =>
    distanceToFeet(step) < distanceToFeet(accessPath[best]) ? index : best, 0);

  log(`Return quarry: keluar lewat access path terverifikasi mulai index=${nearestIndex}/${accessPath.length - 1}.`);
  const movement = bot?.pathfinder?.movements;
  const previousMovement = movement ? {
    maxDropDown: movement.maxDropDown,
    allowParkour: movement.allowParkour,
    canDig: movement.canDig,
    allow1by1Towers: movement.allow1by1Towers,
    allow1by1towers: movement.allow1by1towers
  } : null;
  if (movement) {
    movement.maxDropDown = 1;
    movement.allowParkour = true;
    movement.canDig = false;
    movement.allow1by1Towers = false;
    movement.allow1by1towers = false;
  }
  const atStep = step => {
    const feet = bot?.entity?.position;
    if (!feet) return false;
    return Math.floor(feet.y) === step.y + 1 &&
      Math.hypot(feet.x - step.x - 0.5, feet.z - step.z - 0.5) <= 1.25;
  };
  const jumpToStep = async step => {
    if (typeof bot?.setControlState !== 'function' || typeof bot?.lookAt !== 'function') return false;
    const startY = Number(bot.entity?.position?.y);
    const needsJump = Number.isFinite(startY) && step.y + 1 > startY + 0.2;
    const deadline = Date.now() + 1200;
    try {
      await bot.lookAt(new Vec3(step.x + 0.5, step.y + 1, step.z + 0.5), true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', needsJump);
      while (Date.now() < deadline) {
        if (atStep(step)) return true;
        const position = bot.entity?.position;
        if (position && Number.isFinite(startY) && position.y < startY - 2.2) return false;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      return atStep(step);
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
    }
  };
  try {
    for (let index = nearestIndex; index >= 0; index -= 1) {
      if (shouldStop()) return { success: false, reason: 'TIME_LIMIT' };
      const step = accessPath[index];
      let reached = await adapter.navigateNear({ x: step.x, y: step.y + 1, z: step.z }, 0.75);
      if (reached && !atStep(step)) reached = false;
      if (!reached) reached = await jumpToStep(step);
      if (!reached) {
        log(`Return quarry: pijakan akses gagal dicapai index=${index} step=(${step.x},${step.y},${step.z}).`);
        return { success: false, reason: `ACCESS_STEP_UNREACHABLE:${index}` };
      }
    }
    return { success: true, usedAccessPath: true, steps: nearestIndex + 1 };
  } finally {
    if (movement && previousMovement) Object.assign(movement, previousMovement);
  }
}

async function returnToBaseFromQuarry({
  bot,
  adapter,
  bounds,
  accessPath,
  goal = BASE,
  report = null,
  log = () => {},
  shouldStop = () => false,
  walk = walkToBase,
  emergencyExit = null,
  walkOptions = {}
}) {
  const accessExit = await followQuarryAccessPath({ bot, adapter, accessPath, bounds, log, shouldStop });
  if (!accessExit.success) {
    const recoverable = ['NO_VERIFIED_ACCESS_PATH', 'ACCESS_STEP_UNREACHABLE'].some(reason => accessExit.reason.includes(reason));
    if (!recoverable || typeof emergencyExit !== 'function') {
      return { success: false, reason: `ACCESS_RETURN_FAILED:${accessExit.reason}` };
    }
    log(`Return quarry: access checkpoint tidak valid (${accessExit.reason}); mencoba emergency exit terbatas.`);
    const rescued = await emergencyExit();
    if (!rescued?.success) return { success: false, reason: `EMERGENCY_EXIT_FAILED:${rescued?.reason || 'UNKNOWN'}` };
    return { ...rescued, emergency: true };
  }
  if (accessExit.usedAccessPath && typeof report === 'function') {
    report('RETURN', { stage: 'ACCESS_EXIT', accessSteps: accessExit.steps });
  }
  const walked = await walk({
    bot,
    goal,
    range: 4,
    ...walkOptions,
    log
  });
  if (walked?.success || typeof emergencyExit !== 'function') return walked;

  // Jalur akses bisa benar, tetapi A* ke base dapat gagal ketika chunk di antara
  // quarry dan base belum termuat atau bentuk medan berubah. Jangan jadikan satu
  // kegagalan ini terminal: beri satu percobaan keluar bertahap yang bounded.
  log(`Return quarry: rute base gagal (${walked?.reason || 'UNKNOWN'}); mencoba jalur pemulihan alternatif.`);
  const rescued = await emergencyExit({ reason: walked?.reason || 'RETURN_FAILED' });
  if (rescued?.success) return { ...rescued, emergency: true, initialFailure: walked?.reason };
  return {
    ...(walked || { success: false }),
    reason: `${walked?.reason || 'RETURN_FAILED'}; EMERGENCY_EXIT_FAILED:${rescued?.reason || 'UNKNOWN'}`
  };
}

async function bootstrapTeleport(bot, target, log) {
  if (typeof bot.chat !== 'function') return false;
  log(`Bootstrap server-authoritative ke base (${target.x},${target.y},${target.z})...`);
  bot.chat(`/tp @s ${target.x} ${target.y} ${target.z}`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const position = bot.entity?.position;
    if (position && Math.hypot(position.x - target.x, position.z - target.z) <= 4 && Math.abs(position.y - target.y) <= 4) {
      log('Bootstrap base berhasil dan posisi dikonfirmasi.');
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  log('Bootstrap base tidak terkonfirmasi; kembali ke navigasi natural.');
  return false;
}

async function reserveQuarryTools({ bot, adapter, execute, pickaxes = 1, shovels = 1, log = () => {} }) {
  if (!execute) return;
  for (const [name, required] of [['iron_pickaxe', pickaxes], ['iron_shovel', shovels]]) {
    if (adapter.getItemCount(name) >= required) continue;
    const result = await supplyStorageMaterial({ bot, adapter, name, required, log });
    if (result.missing > 0) log(`Reserve tool ${name} kurang ${result.missing}; worker tetap memakai tool yang tersedia.`);
  }
}

async function depositQuarryMaterials({ adapter, log = () => {}, withLock = null }) {
  const runExclusive = typeof withLock === 'function' ? withLock : async action => action();
  // Quarry workers use a short timeout while searching reachable excavation
  // blocks. Base containers need a separate budget: the live base route can
  // take longer than the local quarry search even when the chest is usable.
  const previousNavigateTimeoutMs = adapter?.options?.navigateTimeoutMs;
  if (adapter?.options && Number.isFinite(previousNavigateTimeoutMs)) {
    adapter.options.navigateTimeoutMs = Math.max(previousNavigateTimeoutMs, 30000);
  }
  try {
    const deposited = await runExclusive(
      () => adapter.depositToChest(STONE_CHEST, item => QUARRY_DEPOSIT_NAMES.has(item.name)),
      { resourceKey: chestResourceKey(STONE_CHEST, adapter) }
    );
    const overflow = await runExclusive(
      () => adapter.depositToChest(STONE_OVERFLOW_CHEST, item => QUARRY_DEPOSIT_NAMES.has(item.name)),
      { resourceKey: chestResourceKey(STONE_OVERFLOW_CHEST, adapter) }
    );
    const result = { deposited: (deposited.deposited || 0) + (overflow.deposited || 0), primary: deposited, overflow };
    log(`Quarry deposit: ${JSON.stringify(result)}`);
    return result;
  } finally {
    if (adapter?.options && Number.isFinite(previousNavigateTimeoutMs)) {
      adapter.options.navigateTimeoutMs = previousNavigateTimeoutMs;
    }
  }
}

async function bootstrapQuarryAccessMaterial({ adapter, bounds, log = () => {}, target = 32 }) {
  const supportNames = new Set(['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'grass_block']);
  const diggable = new Set([...NATURAL_NAMES, 'coal_ore', 'copper_ore', 'lapis_ore']);
  const countSupports = () => [...supportNames].reduce((sum, name) => sum + adapter.getItemCount(name), 0);
  if (countSupports() >= target) return countSupports();
  const candidates = [];
  // Ambil stok awal dari blok natural di tepi posisi miner. Ini memutus deadlock ketika
  // chest support kosong dan bagian dalam quarry sudah berupa ruang kosong, sehingga tidak
  // ada blok reachable di dalam perimeter yang bisa ditambang lebih dulu.
  const local = adapter.bot?.entity?.position;
  if (local) {
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          for (let dy = -1; dy <= 2; dy += 1) {
            const pos = { x: Math.floor(local.x) + dx, y: Math.floor(local.y) + dy, z: Math.floor(local.z) + dz };
            if (pos.x === Math.floor(local.x) && pos.z === Math.floor(local.z) && pos.y <= Math.floor(local.y)) continue;
            const block = adapter.blockAt(pos);
            if (!block || !diggable.has(block.name) || !supportNames.has(block.name) || block.boundingBox !== 'block') continue;
            candidates.push(block);
          }
        }
      }
      if (candidates.length >= 8) break;
    }
  }
  const top = Math.max(bounds.floorY + 1, bounds.maxY - 3);
  for (let y = top; y >= bounds.floorY; y--) {
    for (let x = bounds.minX + 1; x < bounds.maxX; x++) {
      for (let z = bounds.minZ + 1; z < bounds.maxZ; z++) {
        const block = adapter.blockAt({ x, y, z });
        if (!block || !diggable.has(block.name) || block.boundingBox !== 'block') continue;
        if (['water', 'lava', 'sand', 'gravel'].includes(block.name)) continue;
        candidates.push(block);
      }
    }
  }
  let mined = 0;
  let attempts = 0;
  const bootstrapStartedAt = Date.now();
  const bootstrapMaxMs = Math.max(5000, Number(process.env.STORAGE_QUARRY_BOOTSTRAP_MAX_MS) || 20000);
  const bootstrapMaxAttempts = Math.max(4, Number(process.env.STORAGE_QUARRY_BOOTSTRAP_MAX_ATTEMPTS) || 16);
  const pathfinder = adapter.bot?.pathfinder;
  const previousMovements = pathfinder?.movements;
  const previousNavigateTimeoutMs = adapter.options?.navigateTimeoutMs;
  // Kandidat berada di dalam perimeter quarry dan sering belum dapat didekati dari
  // permukaan. Bootstrap boleh membuka jalur pendek melalui blok natural yang aman,
  // tetapi hanya ketika orkestrator mengaktifkan terrain bootstrap secara eksplisit.
  // Setelah material terkumpul, movement dikembalikan agar penggalian produksi tidak
  // mendapat izin terrain tambahan secara diam-diam.
  if (pathfinder && process.env.STORAGE_QUARRY_BOOTSTRAP_TERRAIN_WORK === '1') {
    pathfinder.setMovements(buildMovements(adapter.bot, {
      allowTerrainWork: true,
      terrainBreakAllowlist: BOOTSTRAP_TERRAIN_NAMES,
      allow1by1Towers: false,
      maxDropDown: 2
    }));
    log('Bootstrap akses: terrain work terbatas diaktifkan untuk mencapai blok natural lokal.');
  }
  if (adapter.options && Number.isFinite(previousNavigateTimeoutMs)) {
    adapter.options.navigateTimeoutMs = Math.min(previousNavigateTimeoutMs, 8000);
  }
  try {
    for (const block of candidates) {
      if (countSupports() >= target || attempts >= bootstrapMaxAttempts || Date.now() - bootstrapStartedAt >= bootstrapMaxMs) break;
      attempts += 1;
      if (await adapter.dig(block, { collectDrops: true })) mined += 1;
    }
  } finally {
    if (pathfinder && previousMovements) pathfinder.setMovements(previousMovements);
    if (adapter.options && Number.isFinite(previousNavigateTimeoutMs)) adapter.options.navigateTimeoutMs = previousNavigateTimeoutMs;
  }
  if (attempts >= bootstrapMaxAttempts || Date.now() - bootstrapStartedAt >= bootstrapMaxMs) {
    log(`Bootstrap material akses dibatasi: attempts=${attempts}, elapsedMs=${Date.now() - bootstrapStartedAt}.`);
  }
  log(`Bootstrap material akses: mined=${mined}, supports=${countSupports()}/${target}`);
  return countSupports();
}

async function supplyQuarryAccessMaterials({ bot, adapter, log = () => {}, withLock = null, target = 128 }) {
  const supportNames = ['dirt', 'cobblestone', 'stone', 'grass_block'];
  const countSupports = () => supportNames.reduce((sum, name) => sum + adapter.getItemCount(name), 0);
  const runExclusive = typeof withLock === 'function' ? withLock : async action => action();
  for (const name of supportNames) {
    if (countSupports() >= target) break;
    const before = countSupports();
    try {
      await supplyStorageMaterial({ bot, adapter, name, required: target, log, withLock: runExclusive });
    } catch (error) {
      log(`Supply material akses ${name} gagal: ${error.message}`);
    }
    const after = countSupports();
    if (after > before) log(`Material akses quarry bertambah ${after - before} (${after}/${target}) dari ${name}.`);
  }
  const available = countSupports();
  log(`Supply material akses quarry selesai: ${available}/${target}.`);
  return available;
}

async function withLock(action, log = () => {}, lockPath = LOCK, lockOptions = {}) {
  return withStorageLock(action, {
    lockPath,
    log,
    waitMessage: 'Quarry menunggu kapasitas chest logistik...',
    // Navigasi ke gudang + settle window chest dapat melewati 60 detik pada
    // server remote. Jangan memutus transaksi valid sebelum withdraw/deposit
    // selesai; kapasitas per chest tetap diserialkan oleh storageRoomLock.
    actionTimeoutMs: 120000,
    ...lockOptions
  });
}

function startStorageRoomQuarry({
  host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
  port = Number(process.env.MC_PORT) || 25565,
  botName = process.env.MC_BOT_NAME || 'StorageW6',
  execute = process.env.STORAGE_ROOM_EXECUTE === '1',
  maxBlocks = Number(process.env.STORAGE_QUARRY_BATCH) || 512,
  checkpointFile = process.env.STORAGE_QUARRY_CHECKPOINT || 'data/storage-room-quarry.json',
  quarryBounds = parseQuarryBounds(),
  maxRunMs = Number(process.env.STORAGE_QUARRY_MAX_RUN_MS) || 420000,
  minInventoryFillRatio = Number.isFinite(Number(process.env.STORAGE_QUARRY_MIN_CARRY_RATIO)) ? Number(process.env.STORAGE_QUARRY_MIN_CARRY_RATIO) : 0.75,
  pickaxeReserve = Number(process.env.STORAGE_QUARRY_PICKAXE_RESERVE) || 1,
  shovelReserve = Number(process.env.STORAGE_QUARRY_SHOVEL_RESERVE) || 1,
  log = message => console.log(message)
} = {}) {
  const bot = mineflayer.createBot({ host, port, username: String(botName).slice(0, 16), version: process.env.MC_REMOTE_VERSION || '26.1', auth: 'offline', plugins: { time: false } });
  let finished = false;
  let stopRequested = false;
  let runTimer;
  let roleTask = null;
  let roleTaskOutcome = null;
  const workShouldStop = () => stopRequested || Boolean(roleTask?.leaseLost);
  const report=(phase,extra={})=>{
    const details={phase,...extra};
    log(`WORK_EVENT ${JSON.stringify(details)}`);
    roleTask?.reportProgress(details);
  };
  const finish = code => {
    if (finished) return;
    finished = true;
    if (roleTask) {
      if (code === 0 && roleTaskOutcome?.verification?.status === 'VERIFIED') roleTask.complete({ exitCode: code, role: 'miner', ...roleTaskOutcome });
      else if (code === 0) roleTask.defer(roleTaskOutcome?.reason || 'RESULT_NOT_VERIFIED', 10000);
      else roleTask.fail(`PROCESS_EXIT_${code}`);
      roleTask = null;
    }
    clearTimeout(runTimer);
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
    bot.quit();
    setTimeout(() => process.exit(code), 250);
  };
  runTimer = setTimeout(() => {
    stopRequested = true;
    log('STOP quarry: batas sesi tercapai; pekerjaan akan dihentikan pada checkpoint berikutnya lalu material dibawa pulang.');
  }, maxRunMs);
  bot.once('spawn', async () => {
    try {
      report('PREPARE');
      bot.loadPlugin(pathfinder);
      bot.pathfinder.setMovements(buildMovements(bot, { allowTerrainWork: false, allow1by1Towers: false }));
      // Perjalanan spawn/base adalah logistik umum. Batas satu blok hanya
      // berlaku setelah worker berada di ring quarry dan turun lewat tangga.
      bot.pathfinder.movements.maxDropDown = 3;
      bot.pathfinder.thinkTimeout = 30000;
      const spawnPosition = bot.entity?.position;
      const spawnInsideQuarry = spawnPosition && spawnPosition.y < quarryBounds.maxY - 3 &&
        spawnPosition.x >= quarryBounds.minX - 1 && spawnPosition.x <= quarryBounds.maxX + 1 &&
        spawnPosition.z >= quarryBounds.minZ - 1 && spawnPosition.z <= quarryBounds.maxZ + 1;
      if (shouldRecoverQuarrySpawnToBase(spawnPosition, quarryBounds) && process.env.STORAGE_QUARRY_BOOTSTRAP_TP !== '0') {
        log(`Recovery darurat: spawn berada di bawah lantai quarry (${spawnPosition.x.toFixed(1)},${spawnPosition.y.toFixed(1)},${spawnPosition.z.toFixed(1)}); pindah ke base.`);
        await bootstrapTeleport(bot, BASE, log);
      } else if (spawnInsideQuarry) {
        log(`Recovery posisi: melanjutkan langsung dari quarry (${spawnPosition.x.toFixed(1)},${spawnPosition.y.toFixed(1)},${spawnPosition.z.toFixed(1)}), tanpa pulang ke base.`);
      }
      const startDelayMs = Number(process.env.STORAGE_QUARRY_START_DELAY_MS) || 0;
      if (startDelayMs > 0) {
        log(`Menunggu stagger gatherer ${startDelayMs}ms sebelum persiapan tool.`);
        await new Promise(resolve => setTimeout(resolve, startDelayMs));
      }
      const workNavigateTimeoutMs = Math.max(3000, Math.min(
        Number(process.env.STORAGE_QUARRY_WORK_NAVIGATE_TIMEOUT_MS) || 8000,
        Number(process.env.STORAGE_QUARRY_NAVIGATE_TIMEOUT_MS) || 30000
      ));
      const adapter = new MineflayerRoleAdapter(bot, {
        log,
        coordinateMovement: false,
        capabilities: ['mine', 'survey', 'access', 'haul'],
        // Empat region sudah eksklusif per worker. Reservasi gerak global di dalam region
        // justru membuat target quarry yang berbeda saling memblokir; lock chest/logistik tetap
        // aktif di bawah, sedangkan area gali dijaga oleh pembagian bounds + checkpoint.
        sharedWorld: process.env.STORAGE_QUARRY_SHARED_WORLD !== '0',
        // Koridor sempit menuju lapisan bawah membutuhkan waktu lebih panjang daripada
        // navigasi chest biasa; batas ini hanya berlaku untuk quarry agar worker tidak
        // berhenti sebelum mencapai blok target yang masih valid.
        // Target quarry yang tidak reachable harus dilewati cepat. Perjalanan base dan
        // chest memakai walkToBase/lock terpisah; timeout panjang di sini membuat A*
        // mengulang pencarian lokal dan mengunci satu core saat bentuk quarry berubah.
        navigateTimeoutMs: workNavigateTimeoutMs,
        reachableWorkCandidateLimit: Math.max(8, Math.min(16, Number(process.env.STORAGE_QUARRY_REACHABLE_CANDIDATES) || 12)),
        reachableWorkPathTimeoutMs: Math.max(8, Math.min(20, Number(process.env.STORAGE_QUARRY_REACHABLE_PATH_TIMEOUT_MS) || 15)),
        reachableWorkMaxPages: Math.max(2, Math.min(4, Number(process.env.STORAGE_QUARRY_REACHABLE_PAGES) || 4))
      });
      roleTask = claimExternalRoleTask(adapter, { taskTypes: ['MINING_SUPPLY'], capabilities: ['mine'], log });
      const quarryThinkTimeoutMs = Math.max(2000, Number(process.env.STORAGE_QUARRY_THINK_TIMEOUT_MS) || 8000);
      log(`Spawn quarry ${bot.username || botName} di ${bot.entity.position}`);
      let chunkTimer;
      try {
        await Promise.race([
          bot.waitForChunksToLoad(),
          new Promise((_, reject) => { chunkTimer = setTimeout(() => reject(new Error('chunk spawn belum siap')), 15000); })
        ]);
      } catch (error) {
        log(`Peringatan quarry: chunk awal belum sepenuhnya siap (${error.message}); navigasi tetap dibatasi dan akan retry bertahap.`);
      } finally { clearTimeout(chunkTimer); }
      const bootstrapTerrainWork = process.env.STORAGE_QUARRY_BOOTSTRAP_TERRAIN_WORK === '1';
      const warmupWalk = options => walkToBase({ ...options, thinkTimeoutMs: quarryThinkTimeoutMs, settleMs: Math.max(3000, options.settleMs || 0),
        // Sebagian bot baru muncul di Y56 dekat world spawn. Batas umum Y58
        // akan menolak posisi awal itu sebelum rute sempat dimulai; miner
        // tetap dibatasi agar tidak turun melewati lantai quarry.
        minimumY: quarryBounds.floorY,
        allowTerrainWork: bootstrapTerrainWork, terrainBreakAllowlist: bootstrapTerrainWork ? BOOTSTRAP_TERRAIN_NAMES : null,
        fallbackGoalYOffsets: [-1, -2, -3, -4], stageDistance: bootstrapTerrainWork ? 32 : undefined });
      const tools = await prepareStorageRoomTools({ adapter, bot, execute, allowTerrainWork: bootstrapTerrainWork,
        terrainBreakAllowlist: bootstrapTerrainWork ? BOOTSTRAP_TERRAIN_NAMES : null, fallbackGoalYOffsets: [-1, -2, -3, -4],
        stageDistance: bootstrapTerrainWork ? 32 : undefined, walk: warmupWalk,
        withLock: (action, lockOptions) => withLock(action, log, LOCK, {
          actionTimeoutMs: 120000,
          ...lockOptions
        }),
        log });
      if (!tools.ready) { log(`STOP quarry: tool belum siap ${JSON.stringify(tools.missing)}`); finish(2); return; }
      // prepareStorageRoomTools sudah memastikan minimal satu pickaxe dan shovel
      // tersedia. Reserve tambahan per miner membuat worker pertama menahan lock
      // chest sambil mencari empat tool, lalu tiga miner lain ikut tertahan.
      // Aktifkan hanya untuk deployment lama yang memang memerlukan cadangan ekstra.
      if (process.env.STORAGE_QUARRY_RESERVE_TOOLS === '1') {
        await withLock(async () => {
          await reserveQuarryTools({ bot, adapter, execute, pickaxes: Math.max(1, pickaxeReserve), shovels: Math.max(1, shovelReserve), log });
        }, log);
      }
      // Deposit dan pengambilan bahan tidak boleh berada dalam lock yang sama:
      // satu chest timeout tidak boleh menahan seluruh startup empat miner.
      if (execute) {
        await depositQuarryMaterials({ adapter, log,
          withLock: (action, lockOptions) => withLock(action, log, LOCK, lockOptions) });
      }
      report('APPROACH');
      const approachQuarry = () => {
        // Tinggi permukaan berbeda-beda antar region dan titik staging Y69 bisa
        // jatuh di dalam tebing. Pakai target X/Z yang cukup jauh di luar
        // perimeter agar bot yang reconnect di dasar quarry tidak dianggap tiba,
        // lalu biarkan survei entrance memilih pijakan 3D aktual yang reachable.
        const stagingOffset = Math.max(8, Number(process.env.STORAGE_QUARRY_STAGING_OFFSET) || 8);
        const position = bot.entity?.position;
        const recoveringFromQuarry = position && position.x >= quarryBounds.minX - 1 && position.x <= quarryBounds.maxX + 1 &&
          position.z >= quarryBounds.minZ - 1 && position.z <= quarryBounds.maxZ + 1 && position.y < quarryBounds.maxY - 3;
        // Checkpoint frontier dapat menempatkan bot sedikit di luar seed region
        // (misalnya satu sel ke timur) dan tetap berada di ruang kerja yang sudah
        // disurvei. Jangan paksa bot menggali kembali ke staging permukaan dari
        // posisi bawah tanah; validasi access path di bawah akan menentukan apakah
        // ia bisa melanjutkan atau perlu recovery terkontrol.
        const nearKnownWorkspace = position && position.y >= quarryBounds.floorY && position.y <= quarryBounds.maxY &&
          isInsideQuarryFootprint(position, quarryBounds, Math.max(4, Number(process.env.STORAGE_QUARRY_WORKSPACE_MARGIN) || 12));
        if (nearKnownWorkspace) {
          log(`Recovery posisi: worker masih berada di workspace quarry (${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}); lanjutkan survey lokal.`);
          return { success: true, resumed: true };
        }
        return walkToBase({ bot, goal: { x: quarryBounds.minX - stagingOffset, y: quarryBounds.maxY - 3, z: quarryBounds.minZ - stagingOffset },
          range: 4, goalXZOnly: true, maxGotoMs: Number(process.env.STORAGE_QUARRY_APPROACH_GOTO_MS) || 60000,
          thinkTimeoutMs: quarryThinkTimeoutMs,
          fallbackGoalYOffsets: [],
          minimumY: quarryBounds.floorY,
          allowTerrainWork: Boolean(recoveringFromQuarry && bootstrapTerrainWork),
          terrainBreakAllowlist: recoveringFromQuarry && bootstrapTerrainWork ? NATURAL_NAMES : null,
          allow1by1Towers: Boolean(recoveringFromQuarry && bootstrapTerrainWork),
          scaffoldingBlocks: recoveringFromQuarry && bootstrapTerrainWork
            ? ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'grass_block'] : [],
          maxDropDown: recoveringFromQuarry ? 1 : 3,
          stageDistance: recoveringFromQuarry ? 16 : undefined,
          log });
      };
      const approach = await approachQuarry();
      if (!approach.success) {
        // Pendekatan awal dapat gagal sementara ketika chunk/koridor belum termuat atau
        // worker lain sedang memegang jalur. Jangan jadikan satu kegagalan navigasi sebagai
        // terminal BLOCKED; parent gatherer akan menjadwalkan retry dengan checkpoint yang sama.
        const reason = `NEEDS_SURVEY: pendekatan quarry gagal (${approach.reason})`;
        report('PAUSED', { reason });
        log(`PAUSE quarry: ${reason}; worker akan retry dari base.`);
        finish(0);
        return;
      }
      await bot.waitForChunksToLoad();
      let protectedCells=[];
      let legacyAccessPath = null;
      let verifiedAccessPath = null;
      const accessFile=`${checkpointFile}.access.json`;
      try {
        const saved=JSON.parse(await fs.readFile(accessFile,'utf8'));
        const validCheckpoint = saved.verified === true && JSON.stringify(saved.bounds) === JSON.stringify(quarryBounds) &&
          Array.isArray(saved.supports) && Array.isArray(saved.steps) && saved.steps.length > 0;
        if (validCheckpoint) {
          const liveSteps = saved.steps.every(step => {
            const block = adapter.blockAt(step);
            return block && block.boundingBox === 'block' &&
              [1, 2].every(dy => {
                const above = adapter.blockAt({ ...step, y: step.y + dy });
                return above && ['air', 'cave_air', 'void_air'].includes(above.name);
              });
          });
          if (liveSteps) {
            protectedCells = saved.supports;
            verifiedAccessPath = saved.steps;
          }
          else log('Checkpoint akses diabaikan: salah satu anak tangga tidak lagi terkonfirmasi live.');
        } else if (saved.bounds && JSON.stringify(saved.bounds) === JSON.stringify(quarryBounds) && Array.isArray(saved.supports)) {
          legacyAccessPath = deriveLegacyQuarryAccessPath(quarryBounds, saved.supports, adapter);
          log(`Checkpoint akses legacy: supports=${saved.supports.length}, reconstructedSteps=${legacyAccessPath?.length || 0}`);
          if (legacyAccessPath) {
            protectedCells = saved.supports;
            verifiedAccessPath = legacyAccessPath;
            log(`Checkpoint akses lama direkonstruksi dari ${legacyAccessPath.length} pijakan live; akan divalidasi naik-turun sebelum dipakai.`);
          }
        }
      } catch(error){if(error.code!=='ENOENT')throw error;}
      if (execute) {
        report('SURVEY');
        const accessAssessment = surveyAdaptiveMiningCell(adapter, quarryBounds, { aboveScanHeight: 8,
          maxSafeDrop: quarryMaxSafeDrop() });
        const reachable = await adapter.approachReachableWork(surveyStorageQuarry(adapter, quarryBounds, protectedCells,
          { voidTopology: accessAssessment.voidTopology }).actions, workShouldStop);
        log(`QUARRY_SPATIAL ${JSON.stringify({ status: reachable.status, nodes: reachable.survey.nodes.size, target: reachable.target?.pos })}`);
        if(!reachable.target)report('REPAIR_ACCESS');
        const surfaceFlatThenStair = process.env.STORAGE_QUARRY_MODE === 'surface_flat_then_stair';
        if (surfaceFlatThenStair) {
          report('SURFACE_FLATTEN');
          const flatten = await flattenStorageQuarrySurface({ bot, adapter, checkpointFile, bounds: quarryBounds,
            protectedCells, voidTopology: accessAssessment.voidTopology, maxBlocks: Math.max(128, maxBlocks),
            shouldStop: workShouldStop, log });
          log(`HASIL_SURFACE_FLATTEN ${JSON.stringify({ status: flatten.status, reason: flatten.reason,
            cleared: flatten.cleared, targetY: flatten.targetY })}`);
          if (flatten.status !== 'COMPLETE') {
            // Surface work memiliki checkpoint sendiri; siklus berikutnya akan
            // deposit material yang terkumpul lalu melanjutkan kolom tersisa.
            report('PAUSED', { reason: `SURFACE_${flatten.reason}`, verifiedBlocks: flatten.cleared || 0 });
            finish(0);
            return;
          }
          log(`Permukaan region rata di Y${flatten.targetY}; mulai membangun tangga akses.`);
        }
        // Target yang bisa dicapai dari permukaan belum membuktikan jalur turun ke
        // lapisan dalam. Selalu validasi koridor tangga; bila belum ada, bangun
        // hanya footprint perimeter region ini sebelum excavation dimulai.
        const accessMaterialCount = ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'grass_block']
          .reduce((sum, name) => sum + adapter.getItemCount(name), 0);
        if (accessMaterialCount < 32) {
          await bootstrapQuarryAccessMaterial({ adapter, bounds: quarryBounds, log, target: 32 });
        }
        const remainingAccessMaterialCount = ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'grass_block']
          .reduce((sum, name) => sum + adapter.getItemCount(name), 0);
        if (remainingAccessMaterialCount < 8) {
          // Jangan menahan lock sambil melakukan navigasi ratusan blok. Kembali
          // dahulu ke base, lakukan transaksi chest di lokasi, lalu kembali ke
          // quarry; ini mencegah satu miner memblokir tiga miner lain.
          const returnForMaterials = await returnToBaseFromQuarry({ bot, adapter, bounds: quarryBounds,
            accessPath: verifiedAccessPath, report, shouldStop: workShouldStop, log,
            emergencyExit: async () => {
              const stagingOffset = Math.max(8, Number(process.env.STORAGE_QUARRY_STAGING_OFFSET) || 8);
              const staging = await warmupWalk({
                bot,
                goal: { x: quarryBounds.minX - stagingOffset, y: quarryBounds.maxY - 3, z: quarryBounds.minZ - stagingOffset },
                range: 4,
                goalXZOnly: true,
                maxGotoMs: Number(process.env.STORAGE_QUARRY_EMERGENCY_EXIT_MS) || 60000,
                allowTerrainWork: bootstrapTerrainWork,
                terrainBreakAllowlist: bootstrapTerrainWork ? BOOTSTRAP_TERRAIN_NAMES : null,
                allow1by1Towers: bootstrapTerrainWork,
                scaffoldingBlocks: bootstrapTerrainWork ? ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'grass_block'] : [],
                maxDropDown: 1,
                log
              });
              if (!staging.success) return staging;
              return warmupWalk({
                bot,
                goal: BASE,
                range: 4,
                maxGotoMs: Number(process.env.STORAGE_QUARRY_RETURN_GOTO_MS) || 60000,
                allowTerrainWork: false,
                allow1by1Towers: false,
                maxDropDown: 3,
                log
              });
            },
            walkOptions: {
              maxGotoMs: Number(process.env.STORAGE_QUARRY_RETURN_GOTO_MS) || 60000,
              thinkTimeoutMs: quarryThinkTimeoutMs,
              minimumY: quarryBounds.floorY, allowTerrainWork: false, allow1by1Towers: false,
              maxDropDown: 3
            } });
          if (!returnForMaterials.success) {
            report('BLOCKED', { reason: `MATERIAL_BASE_UNREACHABLE:${returnForMaterials.reason}` });
            finish(2);
            return;
          }
          // Recovery hanya perlu stok untuk satu koridor akses lokal. Meminta
          // 128 blok di sini membuat semua miner berebut chest yang sama dan
          // menunda pekerjaan quarry berikutnya.
          await supplyQuarryAccessMaterials({ bot, adapter, target: 32, log,
            withLock: (action, lockOptions) => withLock(action, log, LOCK, lockOptions) });
          const resumeQuarry = await approachQuarry();
          if (!resumeQuarry.success) {
            report('BLOCKED', { reason: `QUARRY_RESUME_FAILED:${resumeQuarry.reason}` });
            finish(2);
            return;
          }
        }
        let pendingSupports = [];
        const workerPosition = bot.entity?.position;
        const reusableAccessPath = (verifiedAccessPath || legacyAccessPath)?.some(step => workerPosition &&
          Math.hypot(workerPosition.x - step.x - 0.5, workerPosition.y - step.y - 1, workerPosition.z - step.z - 0.5) <= 3.5)
          ? (verifiedAccessPath || legacyAccessPath) : null;
        const checkpointAccessPath = verifiedAccessPath || legacyAccessPath;
        if (checkpointAccessPath && !reusableAccessPath) {
          log('Checkpoint akses tervalidasi berada di luar posisi worker; menuju entrance lama sebelum membuat jalur baru.');
        }
        const access = await buildQuarryAccess({ bot, adapter, bounds: quarryBounds,
          // Reservasi diperlukan selama konstruksi, tetapi jangan dianggap
          // checkpoint valid sebelum semua langkah dan jalur pulang lolos.
          reservePlan: async supports => { pendingSupports = [...new Set(supports)]; },
          diggable: new Set([...NATURAL_NAMES, 'coal_ore', 'copper_ore', 'lapis_ore']),
          // Jalur lama tetap valid walau worker reconnect dari base. Validator
          // akan mulai dari pijakan terdekat dan menguji ulang seluruh koridor;
          // membuang checkpoint hanya karena jarak membuat worker mengulang
          // penggalian akses dan tidak pernah mencapai quarry.
          existingPath: checkpointAccessPath || reusableAccessPath,
          allowTerrainRecovery: approach.resumed === true && !checkpointAccessPath,
          maxDropDown: 1,
          approachMaxDropDown: 3,
          shouldStop: workShouldStop, log });
        log(`HASIL_AKSES_QUARRY ${JSON.stringify(access)}`);
        if (!access.ready) {
          const retryable = isRetryableAccessFailure(access.reason);
          report(retryable ? 'PAUSED' : 'BLOCKED', { reason: access.reason });
          log(`${retryable ? 'PAUSE' : 'STOP'} akses quarry: ${access.reason}; ${retryable ? 'worker akan retry.' : 'diperlukan intervensi.'}`);
          finish(retryable ? 0 : 2);
          return;
        }
        protectedCells = [...new Set([...protectedCells, ...pendingSupports])];
        verifiedAccessPath = access.accessPath;
        await require('./storageRoomBuilder').writeCheckpoint(accessFile, {
          bounds: quarryBounds,
          supports: protectedCells,
          steps: access.accessPath,
          verified: true,
          entrance: access.entrance
        });
      }
      const stateDriven = process.env.STORAGE_QUARRY_STATE_DRIVEN !== '0';
      const result = execute ? stateDriven
        ? await runAdaptiveMiningFrontier({ bot, adapter, seedBounds: quarryBounds, minInventoryFillRatio,
          surveyOptions: { maxSafeDrop: quarryMaxSafeDrop() },
          checkpointFile, protectedCells, log, shouldStop: workShouldStop,
          prepareCell: async (cell, context = { phase: 'stage' }) => {
            const bounds = cell.bounds;
            if (context.phase === 'access') {
              let frontierSupports = [];
              const frontierAccess = await buildQuarryAccess({ bot, adapter, bounds,
                reservePlan: async supports => { frontierSupports = [...new Set(supports)]; },
                diggable: new Set([...NATURAL_NAMES, 'coal_ore', 'copper_ore', 'lapis_ore']),
                existingPath: null,
                allowTerrainRecovery: true,
                maxDropDown: 1,
                approachMaxDropDown: 3,
                shouldStop: workShouldStop,
                log
              });
              if (!frontierAccess.ready) {
                log(`Frontier ${cell.id} belum punya tangga aman: ${frontierAccess.reason}.`);
                return false;
              }
              // Mutate the shared array so the adaptive runtime and the return
              // path see the access supports for the active frontier as well.
              protectedCells.splice(0, protectedCells.length, ...new Set([...protectedCells, ...frontierSupports]));
              verifiedAccessPath = frontierAccess.accessPath;
              log(`FRONTIER_ACCESS_READY ${JSON.stringify({ cell: cell.id, steps: frontierAccess.accessPath?.length || 0 })}`);
              return true;
            }
            const stage = frontierApproachTarget(bounds, process.env.STORAGE_QUARRY_MODE || 'strip_surface_to_floor');
            // Sel frontier setelah seed dapat berada di balik tebing atau beda elevasi.
            // Perjalanan menuju sel baru boleh membuka jalur pendek dari blok natural
            // dan memakai pijakan bounded; ini hanya onboarding frontier, bukan izin
            // menggali struktur atau mengganti aturan excavation produksi.
            const expandingFrontier = Boolean(cell.parentId);
            const frontierTravelTerrain = expandingFrontier && bootstrapTerrainWork;
            const position = bot.entity?.position;
            const nearCell = position && Math.abs(position.x - stage.x) <= 12 &&
              Math.abs(position.z - stage.z) <= 12 &&
              (stage.goalXZOnly ? position.y >= stage.minimumY : Math.abs(position.y - stage.y) <= 8);
            const approach = nearCell ? { success: true } : stage.goalXZOnly
              ? await walkToBase({ bot, goal: stage, range: 4, goalXZOnly: true,
              maxGotoMs: Number(process.env.STORAGE_QUARRY_APPROACH_GOTO_MS) || 60000,
                thinkTimeoutMs: quarryThinkTimeoutMs, minimumY: stage.minimumY,
                allowTerrainWork: frontierTravelTerrain,
                terrainBreakAllowlist: frontierTravelTerrain ? BOOTSTRAP_TERRAIN_NAMES : null,
                allow1by1Towers: frontierTravelTerrain,
                scaffoldingBlocks: frontierTravelTerrain ? ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'grass_block'] : [],
                maxDropDown: frontierTravelTerrain ? 1 : 3,
                stageDistance: frontierTravelTerrain ? 16 : undefined,
                log })
              : { success: await adapter.navigateNear(stage, 2) };
            if (!approach.success) {
              log(`Frontier ${cell.id} belum dapat dicapai dari koridor tambang.`);
              return false;
            }
            try { await bot.waitForChunksToLoad(); }
            catch (error) { log(`Chunk frontier belum stabil: ${error.message}`); }
            return true;
          } })
        : await (async () => {
          const assessment = surveyAdaptiveMiningCell(adapter, quarryBounds, { aboveScanHeight: 8,
            maxSafeDrop: quarryMaxSafeDrop() });
          if (!assessment.mineable) return { status: 'PAUSED', reason: `FRONTIER_${assessment.classification}`,
            cleared: 0, inventoryFillRatio: 0 };
          return excavateStorageQuarry({ bot, adapter, maxBlocks, minInventoryFillRatio, checkpointFile,
            bounds: assessment.excavationBounds, protectedCells, voidTopology: assessment.voidTopology,
            log, shouldStop: workShouldStop });
        })() :
        { status: 'OBSERVATION', plan: 'Gunakan runner dengan execute untuk mutasi.' };
      log(`HASIL_QUARRY ${JSON.stringify(result)}`);
      const carriedQuarryMaterials = countQuarryMaterials(adapter);
      if (execute && shouldDeliverQuarryResult(result, carriedQuarryMaterials)) {
        const carryReady = Number(result.inventoryFillRatio) >= Math.min(1, Math.max(0, minInventoryFillRatio));
        // Kegagalan survey/rute frontier bukan bahaya langsung dan tidak boleh
        // mengalahkan target muatan. Worker mempertahankan posisi agar restart
        // berikutnya memperbaiki akses, bukan bolak-balik ke gudang.
        // Bila checkpoint sudah menghabiskan target lokal dan worker hanya
        // membawa sisa material dari sesi sebelumnya, pulangkan material itu
        // walau slot belum 75%. Menahan worker di tempat pada kondisi tanpa
        // pekerjaan baru hanya membuatnya menjadi BLOCKED permanen.
        const noNewWorkReturn = result.status === 'PAUSED' && Number(result.cleared || 0) === 0 && carriedQuarryMaterials > 0;
        const safetyOverride = isImmediateCarrySafetyOverride(result.reason) || noNewWorkReturn;
        if (!carryReady && !safetyOverride) {
          const reason = `CARRY_TARGET_NOT_REACHED:${Number(result.inventoryFillRatio || 0).toFixed(2)}`;
          // A partial load is not a terminal failure. The worker may have
          // exhausted reachable targets in this pass while still holding
          // useful material; leave the checkpoint intact and let the swarm
          // restart the same region instead of permanently retiring it.
          report('PAUSED', { verifiedBlocks: result.cleared, inventoryFillRatio: result.inventoryFillRatio, reason });
          log(`PAUSE quarry: inventory baru ${Number(result.inventoryFillRatio || 0).toFixed(2)}; target ${minInventoryFillRatio}; retry dari checkpoint.`);
          roleTaskOutcome = { verified: false, reason, minedBlocks: Number(result.cleared) || 0 };
          finish(0);
          return;
        }
        report('RETURN',{verifiedBlocks:result.cleared, inventoryFillRatio:result.inventoryFillRatio,
          reason: safetyOverride && !carryReady ? `SAFETY_OVERRIDE:${result.reason}` : result.reason});
        const returnWalk = await returnToBaseFromQuarry({
          bot,
          adapter,
          bounds: quarryBounds,
          accessPath: verifiedAccessPath,
          report,
          shouldStop: workShouldStop,
          log,
          walkOptions: {
            maxGotoMs: Number(process.env.STORAGE_QUARRY_RETURN_GOTO_MS) || 45000,
            thinkTimeoutMs: quarryThinkTimeoutMs,
            minimumY: quarryBounds.floorY,
            // Terrain edits require a separate reserved plan, not implicit pathfinder digging.
            allowTerrainWork: false,
            maxDropDown: 3,
            allow1by1Towers: false
          }
        });
        if (!returnWalk.success) {
          report('BLOCKED', { reason: `RETURN_FAILED: ${returnWalk.reason}`, verifiedBlocks: result.cleared });
          log(`Quarry deposit dilewati: gagal kembali ke base (${returnWalk.reason}).`);
          finish(2);
          return;
        }
        const deposit = await depositQuarryMaterials({ adapter, log,
          withLock: (action, lockOptions) => withLock(action, log, LOCK, lockOptions) });
        roleTaskOutcome = deposit.deposited > 0
          ? { verified: true, minedBlocks: Number(result.cleared) || 0, depositedItems: deposit.deposited,
            inventoryFillRatio: result.inventoryFillRatio, verification: {
              status: 'VERIFIED', observedAt: Date.now(),
              checks: [{ name: 'materials_deposited', passed: true, operator: 'gt', expected: 0, actual: deposit.deposited }]
            } }
          : { verified: false, reason: 'DEPOSIT_UNCONFIRMED', minedBlocks: Number(result.cleared) || 0 };
        report(process.env.STORAGE_QUARRY_SINGLE_BATCH==='1'&&deposit.deposited>0?'COMPLETE':'DELIVER',
          {verifiedBlocks:result.cleared,delivered:deposit.deposited,reason:deposit.deposited>0?result.reason:'DEPOSIT_UNCONFIRMED'});
      } else if (execute) {
        const phase = result.status === 'PAUSED' ? 'PAUSED' : 'BLOCKED';
        report(phase, { reason: result.reason, verifiedBlocks: 0 });
      }
      finish(execute ? (result.status === 'COMPLETE' || result.status === 'PAUSED' ? 0 : 2) : 0);
    } catch (error) {
      report('BLOCKED',{reason:error.message});
      log(`STOP quarry: ${error.stack || error.message}`);
      finish(2);
    }
  });
  bot.on('error', error => log(`ERROR quarry: ${error.message}`));
  bot.on('kicked', reason => log(`DIKICK quarry: ${JSON.stringify(reason)}`));
  bot.on('end', () => { if (!finished) finish(2); });
  return bot;
}

module.exports = { startStorageRoomQuarry, withLock, supplyQuarryAccessMaterials, countQuarryMaterials,
  shouldDeliverQuarryResult, frontierApproachTarget, isImmediateCarrySafetyOverride,
  shouldRecoverQuarrySpawnToBase, followQuarryAccessPath, returnToBaseFromQuarry,
  isInsideQuarryFootprint, needsQuarryAccessExit, quarryMaxSafeDrop };

if (require.main === module) startStorageRoomQuarry();
