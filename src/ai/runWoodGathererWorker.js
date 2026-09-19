/** Worker forestry mandiri: panen pohon alami, bawa pulang kayu, dan tanam ulang sapling dalam grid. */
const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
patchMineflayerVersionGate(process.env.MC_REMOTE_VERSION || '26.1');

const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { walkToBase } = require('./walkToBase');
const { SharedWorldMemory } = require('./sharedWorldMemory');
const { StructureRegistry } = require('./structureRegistry');
const { getSharedChestAssignments, parseChestPositionKey, TOOLS_CHEST, STONE_COBBLE_CHEST } = require('./storageMemory');
const { withStorageLock, chestResourceKey } = require('./storageRoomLock');
const { WoodGathererEngine, LOG_NAMES, SAPLING_NAMES } = require('./woodGathererEngine');

// Titik pusat ruangan berada di balik blok/furnace yang membuat GoalNear
// berhenti di lantai bawah. Ladder di sisi utara adalah titik akses fisik yang
// benar-benar bisa diinjak; dari sana worker dapat menyebar ke peti lantai 71.
const BASE = { x: -187, y: 71, z: -343 };
  // Forestry routes cross uneven natural terrain. Allow a few blocks of
  // controlled descent during onboarding and return trips so a small ravine
  // does not make a fresh worker freeze at world spawn.
const SAFE_BASE_TRAVEL = {
  goal: BASE,
  // Sampai di area X/Z saja belum cukup: storage chest berada di lantai Y=71
  // dan worker yang berhenti di Y=67 tidak akan pernah bisa mengambil bekal.
  range: 2,
  // X/Z saja pernah melaporkan "sampai di base" dari lantai bawah (Y=63),
  // sementara gudang dan peti kayu berada di lantai Y=71..74. Validasi Y
  // wajib supaya worker benar-benar naik ke level gudang sebelum deposit.
  goalXZOnly: false,
  minimumY: 50,
  // Medan alami di sekitar base memiliki teras kecil/ravine dangkal. Izinkan
  // langkah turun beberapa blok agar worker tidak salah menganggap rute pulang
  // putus; batas ini tetap mencegah lompatan jatuh besar.
  // Worker dapat selesai di kanopi pohon beberapa blok di atas jalur pulang.
  // Izinkan landing turun lebih lebar; coordinatedActions tetap memvalidasi
  // setiap segmen dan tidak mengizinkan lompatan tak terukur.
  maxDropDown: 4,
  // Perjalanan world-spawn ke base dapat ratusan blok. Lompatan 32 blok
  // memberi pathfinder ruang untuk memuat chunk baru; walkToBase juga
  // memperbarui titik antara dari posisi aktual setelah setiap lompatan.
  stageDistance: 32,
  // Forestry boleh membuka jalur natural yang pendek saat pulang. Allowlist
  // pathfinder tetap mencegahnya menggali blok bangunan; ini hanya recovery
  // dari bukit/ravine yang membuat rute biasa berulang timeout.
  allowTerrainWork: true,
  allow1by1Towers: false,
  allowParkour: true,
  allowSprinting: false,
  terrainBreakAllowlist: ['dirt', 'grass_block', 'sand', 'gravel', 'clay', 'snow', 'stone', 'cobblestone', 'tuff'],
  sharedRoute: true
};
const AXES = ['iron_axe', 'diamond_axe', 'stone_axe', 'wooden_axe'];
const FOREST_SEARCH_RADIUS = 384;
const MIN_FORESTRY_Y = 50;
// Work navigation may reshape a small natural step to reach a tree, but it
// must never turn pathfinding into a general-purpose excavator. Logs and all
// construction/storage blocks stay protected; harvesting removes logs only
// through WoodGathererEngine after a tree has been classified.
const FORESTRY_TERRAIN_BLOCKS = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium',
  'mud', 'muddy_mangrove_roots', 'sand', 'red_sand', 'gravel', 'clay',
  'snow', 'snow_block', 'stone', 'cobblestone', 'tuff', 'deepslate'
]);
const FOREST_SWEEP_DIRECTIONS = Object.freeze([
  [0, -1], [1, 0], [0, 1], [-1, 0],
  [1, -1], [1, 1], [-1, 1], [-1, -1]
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const withTimeout = (promise, timeoutMs, fallback) => Promise.race([
  Promise.resolve(promise),
  new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs))
]);

function horizontalDistance(a, b) {
  return Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0));
}

function createForestryMovements(bot, { allow1by1Towers = false, scaffoldingBlocks = [], maxDropDown = 4 } = {}) {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.canOpenDoors = true;
  movements.allow1by1towers = allow1by1Towers;
  movements.allowParkour = false;
  movements.allowSprinting = false;
  // Izinkan teras alami kecil, tetapi jangan biarkan survey turun ke gua/ravine.
  // Akses batang yang lebih rendah ditangani oleh pijakan/scaffolding, bukan
  // dengan membiarkan pathfinder memilih koridor bawah tanah.
  movements.maxDropDown = Math.max(1, Math.min(8, Number(maxDropDown) || 8));
  movements.scafoldingBlocks = scaffoldingBlocks;
  movements.exclusionAreasBreak.push(block => (
    FORESTRY_TERRAIN_BLOCKS.has(block?.name) ? 0 : 100
  ));
  return movements;
}

async function findTreesWithExpansion({ engine, base, surveyNavigate, log = () => {}, maxRadius = FOREST_SEARCH_RADIUS }) {
  const scan = radius => typeof engine.findTrees === 'function'
    ? engine.findTrees(radius)
    : [engine.findTree(radius)].filter(Boolean);
  const local = scan(128);
  // Mangrove roots above swamp water are valid trees, but they are a poor
  // first target for a worker that has not proved its access route yet. Give
  // the spatial survey a chance to find ordinary ground trees farther away;
  // only fall back to mangrove when the expanded survey finds nothing better.
  const preferred = trees => trees.filter(tree => tree?.type !== 'mangrove');
  const localPreferred = preferred(local);
  if (localPreferred.length) return localPreferred;
  let fallback = local;
  // findBlocks hanya melihat chunk yang sudah diketahui bot. Buka chunk secara
  // bertahap pada cincin 192..384 blok, lalu scan radius lokal lagi setelah
  // worker benar-benar tiba di sektor tersebut.
  // Survei cincin dekat lebih dulu. Hutan oak di sekitar base sering berada
  // 70-120 blok jauhnya, sedangkan langsung melompat ke 192 membuat worker
  // masuk rawa/mangrove dan membuang waktu pada rute air.
  const radii = [...new Set([64, 96, 128, 160, 192, 256, 320, maxRadius])]
    .filter(radius => radius <= maxRadius);
  for (const radius of radii) {
    for (const [dx, dz] of FOREST_SWEEP_DIRECTIONS) {
      const center = { x: base.x + dx * radius, y: base.y, z: base.z + dz * radius };
      log(`Survei hutan sektor (${center.x},${center.z}) pada radius ${radius} blok.`);
      if (!surveyNavigate || !await surveyNavigate(center)) continue;
      const nearby = scan(160);
      const nearbyPreferred = preferred(nearby);
      if (nearbyPreferred.length) return nearbyPreferred;
      if (!fallback.length && nearby.length) fallback = nearby;
    }
  }
  const expanded = scan(maxRadius);
  return preferred(expanded).length ? preferred(expanded) : (fallback.length ? fallback : expanded);
}

async function findTreeWithExpansion(options) {
  return (await findTreesWithExpansion(options))[0] || null;
}

async function recoverUnsafeSpawn(bot, log) {
  const position = bot.entity?.position;
  if (!position) return false;
  // Pada protokol server ini entity.position kadang berupa object numerik
  // biasa, bukan Vec3. Jangan panggil position.floored() secara langsung;
  // normalisasi sendiri supaya worker baru tidak berhenti saat spawn.
  const origin = new Vec3(
    Math.floor(Number(position.x) || 0),
    Math.floor(Number(position.y) || 0),
    Math.floor(Number(position.z) || 0)
  );
  const feet = typeof bot.blockAt === 'function' ? bot.blockAt(origin) : null;
  const unsafeLiquid = ['water', 'flowing_water', 'lava', 'flowing_lava'].includes(feet?.name);
  // World spawn kadang menempatkan worker di rongga satu-dua blok di bawah
  // permukaan. Y masih terlihat aman, tetapi pathfinder tidak punya koridor
  // keluar dan mengulang goto selama berpuluh detik. Tanah di bawah saja tidak
  // cukup untuk memicu teleport; area outdoor tetap diperlakukan normal.
  let solidAround = 0;
  if (typeof bot.blockAt === 'function') {
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = 0; dy <= 2; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      const block = bot.blockAt(new Vec3(origin.x + dx, origin.y + dy, origin.z + dz));
      if (block?.boundingBox === 'block' && !['water', 'flowing_water', 'lava', 'flowing_lava'].includes(block.name)) solidAround += 1;
    }
  }
  const enclosedSpawn = solidAround >= 12;
  if (position.y >= 50 && !unsafeLiquid && !enclosedSpawn) return true;
  // A low spawn can still be a shallow excavation or ravine edge that a
  // bounded natural-terrain route can escape after nearby chunks load. Keep
  // this allowlist narrow so recovery never digs storage blocks or structures.
  if (!unsafeLiquid && typeof walkToBase === 'function' && bot.pathfinder) {
    const reason = enclosedSpawn
      ? `terkurung blok padat (${solidAround}/27 voxel sekitar terisi)`
      : `terlalu rendah (Y=${position.y.toFixed(1)})`;
    log(`Pemulihan spawn forestry mencoba rute alami dari Y=${position.y.toFixed(1)} (${reason}).`);
    const naturalRoute = await walkToBase({
      bot,
      goal: BASE,
      range: 4,
      maxGotoMs: 12000,
      thinkTimeoutMs: 12000,
      minimumY: 45,
      stageDistance: 16,
      allowTerrainWork: true,
      allow1by1Towers: false,
      allowParkour: true,
      allowSprinting: false,
      maxDropDown: 3,
      terrainBreakAllowlist: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'sand', 'red_sand', 'gravel', 'clay', 'snow', 'snow_block', 'stone', 'cobblestone', 'tuff', 'deepslate'],
      sharedRoute: false,
      log
    });
    if (naturalRoute.success) return true;
    log(`Rute alami spawn forestry belum berhasil: ${naturalRoute.reason}; lanjut fallback aman.`);
  }
  if (typeof bot.chat !== 'function') return false;
  const reason = unsafeLiquid
    ? `berada di ${feet.name}`
    : enclosedSpawn
      ? `terkurung blok padat (${solidAround}/27 voxel sekitar terisi)`
      : `terlalu rendah (Y=${position.y.toFixed(1)})`;
  log(`Spawn forestry ${reason}; meminta teleport server-authoritative ke base agar tidak macet di air/ruang tertutup.`);
  bot.chat(`/tp @s ${BASE.x} ${BASE.y} ${BASE.z}`);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const p = bot.entity?.position;
    if (p && Math.hypot(p.x - BASE.x, p.z - BASE.z) <= 6 && Math.abs(p.y - BASE.y) <= 5) return true;
    await sleep(150);
  }
  return false;
}

function startWoodGathererWorker({
  host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
  port = Number(process.env.MC_PORT) || 25565,
  botName = process.env.MC_BOT_NAME || 'WoodGatherer1',
  workerIndex = Number(process.env.WORKER_INDEX) || 0,
  workerCount = Math.max(1, Number(process.env.WORKER_COUNT) || 1),
  log = message => console.log(message),
  onDisconnect = () => {},
  tickMs = Number(process.env.WOOD_GATHERER_TICK_MS) || 3000
} = {}) {
  const bot = mineflayer.createBot({ host, port, username: String(botName).slice(0, 16), version: process.env.MC_REMOTE_VERSION || '26.1', auth: 'offline', plugins: { time: false } });
  const memory = new SharedWorldMemory();
  let engine = null;
  let stopped = false;
  let disconnectNotified = false;
  let timer = null;
  let activeCyclePromise = null;
  let spawnPromise = null;
  let memoryClosed = false;
  let surfaceWatchdog = null;
  let surfaceRecoveryPromise = null;
  let status = 'CONNECTING';

  const closeMemory = () => {
    if (memoryClosed) return;
    memoryClosed = true;
    try { memory.close(); } catch {}
  };

  const notifyDisconnect = reason => {
    if (disconnectNotified) return;
    disconnectNotified = true;
    onDisconnect(reason);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearInterval(surfaceWatchdog);
    surfaceWatchdog = null;
    const pending = activeCyclePromise || spawnPromise;
    if (pending) pending.then(closeMemory, closeMemory);
    else closeMemory();
    bot.pathfinder?.stop?.();
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
    bot.quit();
    notifyDisconnect('stopped');
  };

  bot.once('spawn', async () => {
    const operation = (async () => {
    try {
      bot.loadPlugin(pathfinder);
      bot.pathfinder.setMovements(createForestryMovements(bot));
      // Survey dan navigasi pohon bisa menahan satu promise cukup lama. Jangan
      // menunggu promise itu selesai untuk memeriksa elevasi: satu watchdog
      // global memutus rute begitu worker masuk gua/ravine yang terlalu dalam.
      const enforceSurfaceSafety = async () => {
        if (stopped || surfaceRecoveryPromise) return;
        const currentY = Number(bot.entity?.position?.y);
        if (!Number.isFinite(currentY) || currentY >= MIN_FORESTRY_Y) return;
        status = 'RECOVER_SURFACE';
        log(`Watchdog elevasi: worker berada di Y=${currentY.toFixed(1)}; rute dihentikan dan kembali ke base.`);
        bot.pathfinder.setGoal?.(null);
        surfaceRecoveryPromise = recoverUnsafeSpawn(bot, log)
          .catch(error => { log(`Pemulihan elevasi gagal: ${error.message}`); return false; })
          .finally(() => {
            surfaceRecoveryPromise = null;
            if (!stopped) status = 'SEARCH_TREE';
          });
        await surfaceRecoveryPromise;
      };
      surfaceWatchdog = setInterval(() => { void enforceSurfaceSafety(); }, 250);
      // Start workers in short staggered slots. Starting four pathfinders on
      // the same tick makes their initial goals overwrite one another near
      // world spawn before the shared reservation layer has a chance to see
      // the corridor. This keeps the movement natural without teleporting or
      // widening the safety policy.
      const departureDelayMs = Math.max(0, Number(workerIndex) || 0) * 4000;
      if (departureDelayMs > 0) {
        log(`Keberangkatan forestry dijeda ${departureDelayMs}ms agar rute worker tidak saling menimpa.`);
        await sleep(departureDelayMs);
      }
      if (!await recoverUnsafeSpawn(bot, log)) throw new Error('spawn bawah tanah tidak dapat dipulihkan secara server-authoritative');
      // Rute jauh dari world spawn tidak perlu memesan sel koridor gudang.
      // Reservasi bersama dipulihkan pada operasi base/chest agar beberapa
      // worker tetap terkoordinasi ketika sudah berada di area kerja.
      const landingCandidates = [
        {
          ...SAFE_BASE_TRAVEL,
          sharedRoute: false,
          maxGotoMs: 20000,
          settleMs: 1000
        },
        {
          ...SAFE_BASE_TRAVEL,
          goal: { x: -185, y: 71, z: -352 },
          goalXZOnly: true,
          range: 4,
          stageDistance: 16,
          sharedRoute: false,
          maxGotoMs: 16000,
          settleMs: 500
        },
        {
          ...SAFE_BASE_TRAVEL,
          goal: { x: -183, y: 72, z: -347 },
          goalXZOnly: true,
          range: 3,
          stageDistance: 12,
          sharedRoute: false,
          maxGotoMs: 12000,
          settleMs: 500
        }
      ];
      let arrival = { success: false, reason: 'belum mencoba landing forestry' };
      for (const [index, candidate] of landingCandidates.entries()) {
        if (stopped) break;
        log(`Mencoba landing forestry ${index + 1}/${landingCandidates.length} di (${candidate.goal.x},${candidate.goal.y},${candidate.goal.z})...`);
        arrival = await walkToBase({ bot, ...candidate, shouldStop: () => stopped, log });
        if (arrival.success) break;
        log(`Landing forestry ${index + 1} gagal: ${arrival.reason}; mencoba titik akses berikutnya.`);
      }
      if (!arrival.success) throw new Error(`base tidak terjangkau: ${arrival.reason}`);
      // walkToBase installs its own travel profile. Restore the forestry work
      // profile before surveying or harvesting, otherwise terrain digging is
      // silently disabled again after onboarding.
      bot.pathfinder.setMovements(createForestryMovements(bot));
      // Perjalanan onboarding dari world spawn hanya membaca medan dan tidak melakukan kerja.
      // Pasang observer + reservasi sesudah tiba agar rute jauh tidak berebut koridor kerja lokal.
      // Forestry tetap memakai reservasi objek pohon, tetapi navigasi lokal ke
      // batang/chest tidak boleh menunggu graph koridor bersama yang belum
      // dipelajari. Tanpa ini worker sudah berada di base namun setiap target
      // lokal berhenti di NEEDS_SURVEY.
      const adapter = new MineflayerRoleAdapter(bot, { log, sharedWorld: false, capabilities: ['woodcut', 'haul', 'plant'], coordinateMovement: false });
      status = 'ONBOARDING';
      try {
        const spawnSet = await withTimeout(adapter.setSpawnAtNearestBed(24), 8000, false);
        if (!spawnSet) log('Bed forestry belum tersedia atau timeout; lanjut tanpa mengubah spawn point.');
      } catch (error) { log(`Bed forestry belum tersedia: ${error.message}`); }
      if (!AXES.some(name => adapter.getItemCount(name) > 0)) {
        try {
          const result = await withTimeout(
            adapter.withdrawFromChest(parseChestPositionKey(TOOLS_CHEST), AXES, 1),
            15000,
            { withdrawn: 0 }
          );
          if (!(result?.withdrawn > 0)) log('Kapak belum tersedia di chest tools; worker tetap lanjut survei dan akan retry pada siklus berikutnya.');
        }
        catch (error) { log(`Axe dari gudang belum bisa diambil: ${error.message}`); }
      }
      // Gudang lama bisa belum mempunyai kapak di barrel tools. Buat kapak
      // darurat dari bahan yang sudah dibawa worker. Kapak batu diprioritaskan:
      // worker forestry memang sudah dibekali cobblestone untuk pijakan, sehingga
      // ia tidak perlu menunggu wood worker lain sebelum bisa mulai menebang.
      if (!AXES.some(name => adapter.getItemCount(name) > 0)) {
        try {
          const assignments = getSharedChestAssignments(log);
          const woodNames = [
            'spruce_planks', 'oak_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
            'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
            'stripped_spruce_log', 'stripped_oak_log', 'oak_log', 'spruce_log'
          ];
          const woodSources = [...new Set(woodNames.map(name => assignments[name]).filter(Boolean))]
            .map(parseChestPositionKey);
          const stickSource = assignments.stick ? parseChestPositionKey(assignments.stick) : null;
          for (const source of woodSources) {
            if (adapter.getItemCount('cobblestone') >= 3 && adapter.getItemCount('stick') >= 2) break;
            await withTimeout(adapter.withdrawFromChest(source, woodNames, 8), 12000, { withdrawn: 0 });
          }
          if (adapter.getItemCount('stick') < 2 && stickSource) {
            await withTimeout(adapter.withdrawFromChest(stickSource, ['stick'], 2), 12000, { withdrawn: 0 });
          }
          // A stone axe only needs the cobblestone already carried for scaffolding
          // and two sticks. It is the reliable bootstrap when the tools barrel is
          // empty; craftItem verifies the recipe and the caller verifies inventory.
          if (adapter.getItemCount('cobblestone') >= 3 && adapter.getItemCount('stick') >= 2) {
            await withTimeout(adapter.craftItem('stone_axe', 1), 12000, false);
          }
          const plank = ['spruce_planks', 'oak_planks', 'birch_planks', 'jungle_planks', 'acacia_planks'].find(name => adapter.getItemCount(name) > 0);
          if (!AXES.some(name => adapter.getItemCount(name) > 0) && plank && adapter.getItemCount('stick') >= 2) {
            await withTimeout(adapter.craftItem('wooden_axe', 1), 12000, false);
          }
          if (AXES.some(name => adapter.getItemCount(name) > 0)) log('Kapak forestry darurat berhasil dibuat dari stok gudang.');
          else log('Kapak forestry belum tersedia setelah percobaan ambil dan craft darurat.');
        } catch (error) { log(`Craft kapak forestry darurat ditunda: ${error.message}`); }
      }
      // Pohon di area ini kadang berada di atas tepian air/teras. Sediakan
      // sedikit cobblestone sebagai pijakan sementara, bukan bekal tambang.
      // Profil pathfinder tetap melarang parkour dan hanya memakai blok ini
      // saat memang perlu naik satu blok demi satu blok.
      let scaffoldingIds = [];
      const scaffoldingChest = parseChestPositionKey(STONE_COBBLE_CHEST);
      const withdrawScaffolding = async (desired = 24) => {
        const before = adapter.getItemCount('cobblestone');
        if (before < desired) {
          await withTimeout(
            adapter.withdrawFromChest(scaffoldingChest, ['cobblestone'], desired - before),
            12000,
            { withdrawn: 0 }
          );
        }
        // Gudang dapat memecah cobblestone ke beberapa chest. Bila chest
        // assignment hanya menyisakan 7 blok, cari chest berisi cobble lain
        // di sekitar base sebelum worker menyerah pada pohon tinggi.
        if (adapter.getItemCount('cobblestone') < desired && typeof adapter.findMatchingChest === 'function') {
          const alternate = await withTimeout(
            adapter.findMatchingChest(['cobblestone'], {
              maxDistance: 48,
              count: 48,
              excludePositions: [scaffoldingChest]
            }),
            15000,
            null
          );
          if (alternate) {
            await withTimeout(
              adapter.withdrawFromChest(alternate, ['cobblestone'], desired - adapter.getItemCount('cobblestone')),
              12000,
              { withdrawn: 0 }
            );
          }
        }
        return adapter.getItemCount('cobblestone') - before;
      };
      try {
        await withdrawScaffolding(24);
        const cobblestoneId = bot.registry?.itemsByName?.cobblestone?.id;
        if (cobblestoneId && adapter.getItemCount('cobblestone') > 0) scaffoldingIds = [cobblestoneId];
        if (!scaffoldingIds.length) log('Cobblestone pijakan tidak tersedia; worker tetap mencoba rute alami.');
      } catch (error) { log(`Bekal pijakan tidak bisa diambil: ${error.message}`); }
      bot.pathfinder.setMovements(createForestryMovements(bot, {
        allow1by1Towers: scaffoldingIds.length > 0,
        scaffoldingBlocks: scaffoldingIds
      }));
      let lastSupplyRetryAt = 0;
      const retryForestrySupplies = async () => {
        if (Date.now() - lastSupplyRetryAt < 15000) return;
        lastSupplyRetryAt = Date.now();
        const needsAxe = !AXES.some(name => adapter.getItemCount(name) > 0);
        // Bekal pijakan dicoba saat onboarding. Jangan scan puluhan peti setiap
        // siklus hanya karena stok cobble kurang; itu merebut pathfinder dari
        // pencarian pohon dan membuat worker tampak bolak-balik tanpa panen.
        if (!needsAxe) return;

        // Bekal selalu diambil dari base, bukan dari tengah hutan. Sebelumnya
        // retry membuka peti dari posisi remote sehingga worker mengulang rute
        // jauh tanpa pernah memperoleh kapak atau cobblestone.
        const position = bot.entity?.position;
        const farFromBase = position && (
          Math.hypot(position.x - BASE.x, position.z - BASE.z) > 12 ||
          Math.abs(position.y - BASE.y) > 6
        );
        if (farFromBase) {
          status = 'RETURN_SUPPLIES';
          const arrival = await walkToBase({ bot, ...SAFE_BASE_TRAVEL, shouldStop: () => stopped, log });
          if (!arrival.success) {
            log(`Bekal forestry ditunda: base belum terjangkau (${arrival.reason}).`);
            return;
          }
          bot.pathfinder.setMovements(createForestryMovements(bot, {
            allow1by1Towers: scaffoldingIds.length > 0,
            scaffoldingBlocks: scaffoldingIds
          }));
        }
        let changed = false;
        if (needsAxe) {
          try {
            const result = await withTimeout(
              adapter.withdrawFromChest(parseChestPositionKey(TOOLS_CHEST), AXES, 1),
              15000,
              { withdrawn: 0 }
            );
            if (result?.withdrawn > 0) {
              log('Kapak forestry berhasil diambil setelah peti tools tersedia kembali.');
              changed = true;
            }
          } catch (error) { log(`Retry kapak forestry ditunda: ${error.message}`); }
        }
        if (changed) {
          bot.pathfinder.setMovements(createForestryMovements(bot, {
            allow1by1Towers: scaffoldingIds.length > 0,
            scaffoldingBlocks: scaffoldingIds
          }));
        }
      };
      const contextWorld = process.env.MC_WORLD_ID || `${host}:${port}`;
      const structures = new StructureRegistry(memory).list().filter(item => item.world === contextWorld && String(item.dimension).endsWith('overworld'));
      const surveyNavigate = async center => {
        const beforeY = Number(bot.entity?.position?.y);
        if (Number.isFinite(beforeY) && beforeY < MIN_FORESTRY_Y) {
          log(`Survei sektor (${center.x},${center.z}) dibatalkan: elevasi worker Y=${beforeY.toFixed(1)} berada di bawah batas kerja Y=${MIN_FORESTRY_Y}.`);
          return false;
        }
        // Semua navigasi forestry masuk antrean adapter yang sama dengan operasi
        // chest/harvest. GoalNearXZ membiarkan pathfinder memilih ketinggian
        // permukaan aktual sektor, bukan memaksa Y=71 di bukit atau rawa.
        const currentY = Number.isFinite(beforeY) ? Math.floor(beforeY) : BASE.y;
        const reached = await adapter.navigateNear(
          { x: center.x, y: currentY, z: center.z },
          8,
          { goalXZOnly: true, sharedRoute: false, timeoutMs: 30000 }
        );
        const afterY = Number(bot.entity?.position?.y);
        if (!reached || !Number.isFinite(afterY) || afterY < MIN_FORESTRY_Y) {
          log(`Survei sektor (${center.x},${center.z}) dilewati: rute permukaan tidak aman atau belum tercapai.`);
          return false;
        }
        return true;
      };
      engine = new WoodGathererEngine({
        adapter,
        base: BASE,
        structures,
        surveyNavigate,
        workerIndex,
        workerCount,
        minWorkY: MIN_FORESTRY_Y,
        log
      });
      // Survei kebun bukan prasyarat panen. Survei jauh dapat menunggu rute
      // terrain yang buntu selama beberapa menit, sementara pohon alami sudah
      // tersedia di chunk sekitar. Kebun akan dicoba terbatas setelah panen.
      status = 'READY';
      log('Onboarding selesai; pencarian pohon dimulai tanpa menunggu survei kebun.');

      const assignments = getSharedChestAssignments(log);
      const woodChest = parseChestPositionKey(assignments.oak_log || '-181,74,-347');
      const cargoCount = () => [...LOG_NAMES, ...SAPLING_NAMES].reduce((sum, name) => sum + adapter.getItemCount(name), 0);
      const chestKey = position => `${position.x},${position.y},${position.z}`;
      const forestryChestCandidates = () => {
        const candidates = [woodChest];
        if (typeof adapter.findChestPositions === 'function') {
          for (const position of adapter.findChestPositions(48, 96)) {
            if (!candidates.some(candidate => chestKey(candidate) === chestKey(position))) candidates.push(position);
          }
        }
        return candidates;
      };
      const atStorageFloor = () => {
        const position = bot.entity?.position;
        // Koridor peti yang benar berada beberapa blok di barat-laut ladder;
        // posisi berdiri yang aman dapat berjarak sampai sekitar 8 blok dari
        // titik pusat BASE tanpa berarti worker masih berada di lantai bawah.
        return Boolean(position && position.y >= BASE.y - 1 && horizontalDistance(position, BASE) <= 8);
      };
      const climbToStorageFloor = async () => {
        if (stopped) return false;
        const current = bot.entity?.position;
        if (!current || atStorageFloor() || typeof bot.findBlocks !== 'function') return atStorageFloor();
        // Jalur gudang yang sudah berhasil dipakai materials worker. Coba
        // waypoint berdiri di lorong terlebih dahulu; ladder di utara hanya
        // menghubungkan lantai atas dan sering tidak memiliki koneksi langsung
        // dari teras bawah tempat worker forestry tiba.
        const aisleWaypoints = [
          { x: -186, y: 72, z: -342 },
          { x: -185, y: 72, z: -342 },
          { x: -184, y: 72, z: -342 },
          { x: -183, y: 72, z: -342 },
          { x: -183, y: 72, z: -343 },
          { x: -183, y: 72, z: -345 },
          { x: -183, y: 72, z: -347 }
        ];
        for (const waypoint of aisleWaypoints) {
          if (stopped) return false;
          log(`Jalur pulang forestry mencoba waypoint lorong (${waypoint.x},${waypoint.y},${waypoint.z})...`);
          const reached = await withTimeout(
            adapter.navigateNear(waypoint, 1, { sharedRoute: true }),
            18000,
            false
          );
          if (reached && atStorageFloor()) return true;
        }
        if (stopped) return false;
        const scaffolding = ['cobblestone', 'dirt', 'stone'].find(name =>
          typeof adapter.getItemCount === 'function' && adapter.getItemCount(name) > 0);
        const accessBlocks = bot.findBlocks({
          matching: block => block?.name === 'ladder'
            || block?.name === 'scaffolding'
            || String(block?.name || '').endsWith('_stairs'),
          maxDistance: 64,
          count: 128
        }).map(position => ({ x: position.x, y: position.y, z: position.z }))
          .filter(position => position.y >= Math.floor(current.y) - 1)
          .sort((a, b) => horizontalDistance(current, a) - horizontalDistance(current, b) || a.y - b.y);
        // If the worker already carries a natural block, the bounded temporary
        // staircase below is faster and more reliable than probing up to 128
        // ladder/stair candidates one by one. Keep the access scan as fallback
        // for workers that have no building material.
        for (const access of scaffolding ? [] : accessBlocks) {
          if (stopped) return false;
          const accessBlock = bot.blockAt?.(new Vec3(access.x, access.y, access.z));
          const kind = accessBlock?.name === 'ladder' ? 'tangga' : 'jalur naik';
          log(`Jalur pulang forestry mencari ${kind} terdekat (${access.x},${access.y},${access.z})...`);
          const approach = await withTimeout(
            adapter.navigateNear({ x: access.x, y: Math.min(access.y, Math.floor(current.y) + 1), z: access.z }, 1, { sharedRoute: true }),
            18000,
            false
          );
          if (!approach) continue;
          const deadline = Date.now() + 7000;
          try {
            await bot.lookAt(new Vec3(access.x + 0.5, access.y + 1.5, access.z + 0.5), true);
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            while (Date.now() < deadline) {
              if (stopped) return false;
              if (atStorageFloor()) return true;
              await sleep(250);
            }
          } finally {
            bot.setControlState('forward', false);
            bot.setControlState('jump', false);
          }
          if (atStorageFloor()) return true;
        }
        // The lower terrace can be reachable while the storage ladder is not in
        // the local pathfinder graph yet. Use the same jump-before-placement
        // recovery as tree harvesting, but only for the short final rise to the
        // known storage floor and only with carried natural blocks. This avoids
        // abandoning harvested cargo on a safe terrace just because a chunk
        // boundary hid the ladder from pathfinder.
        if (scaffolding && bot.entity?.position && bot.entity.position.y < BASE.y) {
          if (stopped) return false;
          const maxSteps = Math.min(12, Math.max(0, Math.ceil(BASE.y - bot.entity.position.y)));
          log(`Pemulihan tangga sementara forestry: ${maxSteps} langkah memakai ${scaffolding}.`);
          for (let step = 0; step < maxSteps && !atStorageFloor(); step += 1) {
            if (stopped) return false;
            const before = bot.entity?.position;
            if (!before) break;
            const foot = { x: Math.floor(before.x), y: Math.floor(before.y), z: Math.floor(before.z) };
            const footBlock = adapter.blockAt(foot);
            const reference = await adapter.findReference?.(foot);
            if (!reference || !footBlock || ['water', 'lava'].includes(footBlock.name)) break;
            try {
              if (!await adapter.equipItem(scaffolding, 'hand')) break;
              await adapter.placeBlockAt(foot, reference.reference, reference.face);
              await sleep(250);
              bot.setControlState('jump', true);
              bot.setControlState('forward', false);
              const deadline = Date.now() + 1600;
              while (Date.now() < deadline && (bot.entity?.position?.y || 0) <= before.y + 0.35) await sleep(100);
              bot.setControlState('jump', false);
              const after = bot.entity?.position;
              if (!after || after.y <= before.y + 0.35) {
                log(`Tangga sementara tidak menaikkan worker dari Y=${before.y.toFixed(1)}; hentikan recovery.`);
                break;
              }
              log(`Tangga sementara forestry naik ke Y=${after.y.toFixed(1)}.`);
            } catch (error) {
              bot.setControlState('jump', false);
              log(`Pembuatan tangga sementara gagal di (${foot.x},${foot.y},${foot.z}): ${error.message}`);
              break;
            }
          }
          if (atStorageFloor()) return true;
        }
        return atStorageFloor();
      };
      const withForestryChestLock = (action, position) => withStorageLock(action, {
        lockPath: process.env.STORAGE_ROOM_RESTOCK_LOCK || 'data/storage-room-restock.lock',
        resourceKey: chestResourceKey(position, adapter),
        actionTimeoutMs: 45000,
        waitMessage: 'Wood gatherer menunggu lock peti kayu...'
      });
      const deliverCargo = async () => {
        if (stopped) return false;
        status = 'DELIVER';
        const arrival = await walkToBase({ bot, ...SAFE_BASE_TRAVEL, shouldStop: () => stopped, log });
        if (stopped) return false;
        if (!arrival.success || !atStorageFloor()) {
          const position = bot.entity?.position;
          // A failed precise-Y route does not mean the nearby base is
          // unreachable. Forestry workers often arrive one terrace below the
          // storage floor; first warm and approach the base footprint at the
          // worker's current elevation, then use the ladder recovery below.
          if (position && position.y >= MIN_FORESTRY_Y) {
            const surfaceArrival = await walkToBase({
              bot,
              ...SAFE_BASE_TRAVEL,
              goal: { ...BASE, y: Math.floor(position.y) },
              goalXZOnly: true,
              range: 2,
              stageDistance: 16,
              maxGotoMs: 20000,
              shouldStop: () => stopped,
              log
            });
            if (surfaceArrival.success) log('Pijakan permukaan base tercapai; lanjut pemulihan naik ke lantai gudang.');
          }
          if (stopped) return false;
          // Posisi yang sudah berada di lantai gudang tetap harus meneruskan
          // proses deposit. Sebelumnya status rute yang kurang sempurna di
          // sini dianggap sukses lalu fungsi keluar sebelum peti dibuka.
          if (!atStorageFloor()) {
            log(`Pulang forestry belum berada di lantai gudang (posisi ${position?.x?.toFixed?.(1)},${position?.y?.toFixed?.(1)},${position?.z?.toFixed?.(1)}); mencoba tangga dunia.`);
            if (!await climbToStorageFloor()) return false;
          }
        }
        const predicate = item => LOG_NAMES.includes(item.name) || SAPLING_NAMES.includes(item.name);
        let deposited = 0;
        for (const candidate of forestryChestCandidates()) {
          if (cargoCount() <= 0) break;
          // The assigned chest remains first choice. If another worker owns its
          // approach corridor, try another known storage chest instead of
          // holding logs forever at base. The shared reservation layer still
          // protects each individual chest and double-chest pair.
          const before = cargoCount();
          const result = await withForestryChestLock(
            () => adapter.depositToChest(candidate, predicate),
            candidate
          );
          const moved = Math.max(0, before - cargoCount());
          deposited += Math.max(result.deposited || 0, moved);
          if (moved > 0 && chestKey(candidate) !== chestKey(woodChest)) {
            log(`Peti kayu utama sedang dipakai; ${moved} item forestry dialihkan ke peti (${candidate.x},${candidate.y},${candidate.z}).`);
          }
        }
        engine.metrics.delivered += deposited;
        if (cargoCount() > 0) {
          log(`Muatan forestry belum tersetor (${cargoCount()} item); menunggu lock peti lalu mencoba lagi.`);
          return false;
        }
        return true;
      };
      const cycle = async () => {
        if (stopped) return;
        try {
          const currentY = Number(bot.entity?.position?.y);
          if (Number.isFinite(currentY) && currentY < MIN_FORESTRY_Y) {
            status = 'RECOVER_SURFACE';
            log(`Worker forestry berada di Y=${currentY.toFixed(1)}; hentikan rute bawah tanah dan pulihkan ke base.`);
            bot.pathfinder.setGoal?.(null);
            const recovered = await recoverUnsafeSpawn(bot, log);
            if (!recovered) throw new Error(`elevasi kerja tidak aman dan pemulihan gagal (Y=${currentY.toFixed(1)})`);
            status = 'SEARCH_TREE';
          }
          if ((bot.health ?? 20) < 10) {
            status = 'RETREAT';
            await walkToBase({ bot, ...SAFE_BASE_TRAVEL, shouldStop: () => stopped, log });
          } else if (cargoCount() > 0 && !engine.pendingTree) {
            await deliverCargo();
          } else {
            status = 'SEARCH_TREE';
            await retryForestrySupplies();
            // Kebun hanya target tanam ulang. Aksesnya tidak boleh menjadi
            // prasyarat panen ketika koridor sedang dipakai worker lain.
            const pendingTree = engine.pendingTree;
            const trees = pendingTree ? [pendingTree] : await findTreesWithExpansion({
              engine,
              base: BASE,
              surveyNavigate,
              log,
              maxRadius: FOREST_SEARCH_RADIUS
            });
            let harvestedTree = null;
            // Satu pohon yang tidak punya pijakan tidak boleh memblokir seluruh
            // worker. Kandidat yang sudah diberi cooldown dilewati oleh engine;
            // kandidat berikutnya dicoba pada siklus yang sama.
            for (const tree of trees.slice(0, 8)) {
              status = 'HARVEST';
              if (await engine.harvest(tree)) {
                harvestedTree = tree;
                break;
              }
            }
            if (!harvestedTree && engine.pendingTree) {
              status = 'WAITING_TREE';
              log('Kayu parsial masih ditahan; worker mengulang pohon yang sama sebelum kembali ke base.');
            } else if (!harvestedTree) {
              status = 'WAITING_TREE';
              log('Belum ada pohon alami aman di radius kerja; menunggu tanpa menebang struktur.');
            } else {
              await sleep(3500);
              await adapter.navigateNear(harvestedTree.bottom, 1);
              status = 'REPLANT';
              await engine.plantSaplings();
              await deliverCargo();
            }
          }
        } catch (error) {
          status = 'RETRY';
          log(`Siklus forestry ditunda: ${error.message}`);
        }
        if (!stopped) timer = setTimeout(runCycle, tickMs);
      };
      const runCycle = () => {
        if (stopped) return;
        const promise = cycle();
        activeCyclePromise = promise;
        promise.then(
          () => { if (activeCyclePromise === promise) activeCyclePromise = null; if (stopped) closeMemory(); },
          () => { if (activeCyclePromise === promise) activeCyclePromise = null; closeMemory(); }
        );
      };
      runCycle();
    } catch (error) {
      status = 'BLOCKED';
      log(`WoodGatherer berhenti aman: ${error.message}`);
      stop();
    }
    })();
    spawnPromise = operation;
    await operation;
  });

  bot.on('error', error => log(`ERROR forestry: ${error.message}`));
  bot.on('kicked', reason => log(`DIKICK forestry: ${JSON.stringify(reason)}`));
  bot.on('end', reason => {
    clearInterval(surfaceWatchdog);
    surfaceWatchdog = null;
    bot.pathfinder?.stop?.();
    bot.pathfinder?.setGoal(null);
    if (!stopped) {
      stopped = true;
      clearTimeout(timer);
      const pending = activeCyclePromise || spawnPromise;
      if (pending) pending.then(closeMemory, closeMemory);
      else closeMemory();
    }
    notifyDisconnect(reason);
  });

  return {
    stop,
    getMetrics: () => {
      if (!engine) return null;
      const carriedLogs = bot.inventory?.items()
        .filter(item => LOG_NAMES.includes(item.name))
        .reduce((total, item) => total + item.count, 0) || 0;
      const carriedSaplings = bot.inventory?.items()
        .filter(item => SAPLING_NAMES.includes(item.name))
        .reduce((total, item) => total + item.count, 0) || 0;
      return { ...engine.metrics, carriedLogs, carriedSaplings,
        pendingLogs: engine.pendingTree?.logs?.length || 0 };
    },
    getStatus: () => ({ role: 'Wood Gatherer', status, position: bot.entity?.position || null, health: bot.health ?? null,
      inventory: bot.inventory?.items().map(item => ({ name: item.name, count: item.count })) || [],
      plantation: engine?.plantation?.center || null,
      pendingTree: engine?.pendingTree ? {
        id: engine.pendingTree.id,
        type: engine.pendingTree.type,
        requiredLogs: engine.pendingTree.requiredLogs,
        collected: engine.pendingTree.collected,
        remainingLogs: engine.pendingTree.logs?.length || 0,
        noProgressAttempts: engine.pendingTree.noProgressAttempts || 0
      } : null })
  };
}

module.exports = { startWoodGathererWorker, recoverUnsafeSpawn, findTreeWithExpansion, findTreesWithExpansion, FOREST_SEARCH_RADIUS };

if (require.main === module) startWoodGathererWorker();
