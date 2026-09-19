/** Worker logistik storage room: smelting, crafting, dan pengantaran material. */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
patchMineflayerVersionGate(process.env.MC_REMOTE_VERSION || '26.1');

const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { pathfinder, goals } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { claimExternalRoleTask } = require('./externalRoleTask');
const { buildMovements, walkToBase } = require('./walkToBase');
const { supplyStorageMaterial } = require('./storageRoomMaterials');
const { smeltStorageStone } = require('./storageRoomSmelter');
const { expandStorageFurnaces } = require('./storageRoomFurnaces');
const { getSharedChestAssignments, parseChestPositionKey } = require('./storageMemory');
const { storageSources } = require('./storageRoomMaterials');
const { withLock } = require('./runStorageRoomQuarry');
const { chestResourceKey } = require('./storageRoomLock');

// Koridor staging live di depan baris peti. Dari sini chest/furnace terdekat
// berada dalam jangkauan interaksi tanpa pathfinder menembus deretan workstation.
// Ladder utara tetap dipakai sebagai fallback untuk onboarding dari spawn.
const BASE = { x: -182, y: 72, z: -345 };
const FOOD_NAMES = ['cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'baked_potato'];
// Bootstrap hanya boleh membuka blok alam yang menghalangi akses awal. Blok bangunan,
// chest, furnace, dan stone tidak pernah menjadi kandidat penggalian otomatis.
const BASE_TERRAIN_NAMES = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'sand', 'red_sand', 'gravel', 'clay', 'snow', 'snow_block', 'mud'
]);

function parsePosition(raw, fallback = BASE) {
  const values = String(raw || '').split(',').map(Number);
  return values.length === 3 && values.every(Number.isInteger)
    ? { x: values[0], y: values[1], z: values[2] }
    : { ...fallback };
}

function positionFor(assignments, name, fallback) {
  const key = assignments[name] || fallback;
  return parseChestPositionKey(key);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function describeLocalAccess(bot, center) {
  const origin = {
    x: Math.floor(center?.x ?? bot.entity?.position?.x ?? 0),
    y: Math.floor(center?.y ?? bot.entity?.position?.y ?? 0),
    z: Math.floor(center?.z ?? bot.entity?.position?.z ?? 0)
  };
  const offsets = [
    [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [0, 1, 0], [0, -1, 0]
  ];
  return offsets.map(([dx, dy, dz]) => {
    const pos = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
    const block = bot.blockAt?.(new Vec3(pos.x, pos.y, pos.z));
    return `${pos.x},${pos.y},${pos.z}=${block?.name || 'unknown'}/${block?.boundingBox || 'unknown'}`;
  }).join(' | ');
}

function inspectLocalPath(bot, target) {
  try {
    const result = bot.pathfinder.getPathTo(
      bot.pathfinder.movements,
      new goals.GoalNear(target.x, target.y, target.z, 0),
      2000
    );
    const path = Array.isArray(result?.path)
      ? result.path.slice(0, 8).map(step => `${step.x},${step.y},${step.z}${step.toBreak?.length ? ` break=${step.toBreak.map(block => block.name).join('|')}` : ''}${step.toPlace?.length ? ` place=${step.toPlace.map(block => block.name).join('|')}` : ''}`).join(' -> ')
      : '';
    return `${result?.status || 'unknown'} nodes=${result?.visitedNodes ?? '?'} path=${result?.path?.length ?? 0}${path ? ` [${path}]` : ''}`;
  } catch (error) {
    return `error=${error.message}`;
  }
}

async function nudgeOutOfLadder(bot, target, log) {
  const before = bot.entity?.position;
  if (!before || typeof bot.lookAt !== 'function' || typeof bot.setControlState !== 'function') return false;
  log(`Pathfinder macet di ladder; dorong manual pendek menuju (${target.x},${target.y},${target.z}) tanpa menggali.`);
  try {
    await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.2, target.z + 0.5), true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await sleep(900);
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  const after = bot.entity?.position;
  const moved = after && Math.hypot(after.x - before.x, after.z - before.z) > 0.35;
  if (moved) log(`Nudge ladder berhasil; posisi aktual (${after.x.toFixed(2)},${after.y.toFixed(2)},${after.z.toFixed(2)}).`);
  else log('Nudge ladder tidak menggeser posisi; jalur lokal tetap ditandai buntu.');
  return Boolean(moved);
}

function startStorageRoomMaterials({
  host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
  port = Number(process.env.MC_PORT) || 25565,
  botName = process.env.MC_BOT_NAME || 'StorageMat1',
  maxRunMs = Number(process.env.STORAGE_MATERIALS_MAX_RUN_MS) || Number(process.env.STORAGE_ROOM_MAX_RUN_MS) || 300000,
  cycleDelayMs = Number(process.env.STORAGE_MATERIALS_CYCLE_DELAY_MS) || 4000,
  maxCycles = Number(process.env.STORAGE_MATERIALS_MAX_CYCLES) || 60,
  // Gunakan base utama sebagai titik landing default. Titik staging -176 sebelumnya
  // membuat survey furnace berjalan di chunk yang salah dan selalu menghasilkan 0 furnace.
  baseGoal = parsePosition(process.env.STORAGE_MATERIALS_BASE_GOAL, BASE),
  restockLockPath = process.env.STORAGE_ROOM_RESTOCK_LOCK || 'data/storage-room-restock.lock',
  log = message => console.log(message)
} = {}) {
  const username = String(botName).slice(0, 16);
  const assignments = getSharedChestAssignments(log);
  const bot = mineflayer.createBot({ host, port, username, version: process.env.MC_REMOTE_VERSION || '26.1', auth: 'offline', plugins: { time: false } });
  let finished = false;
  let runTimer;
  let spawnTimer;
  let roleTask = null;
  const report = (phase, extra = {}) => {
    const details = { phase, ...extra };
    log(`WORK_EVENT ${JSON.stringify(details)}`);
    roleTask?.reportProgress(details);
  };
  const finish = code => {
    if (finished) return;
    finished = true;
    if (roleTask) {
      roleTask.defer(code === 0 ? 'SERVICE_CHECKPOINT' : `PROCESS_EXIT_${code}`, code === 0 ? 1000 : 5000);
      roleTask = null;
    }
    clearTimeout(runTimer);
    clearTimeout(spawnTimer);
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
    bot.quit();
    setTimeout(() => process.exit(code), 250);
  };

  if (!Number.isFinite(maxRunMs) || maxRunMs < 1000 || maxRunMs > 900000) throw new Error('Batas materials worker wajib 1000..900000ms.');
  runTimer = setTimeout(() => {
    report('PAUSED', { reason: 'TIME_LIMIT' });
    finish(0);
  }, maxRunMs);
  const spawnTimeoutMs = Number(process.env.STORAGE_ROOM_SPAWN_TIMEOUT_MS) || 30000;
  spawnTimer = setTimeout(() => {
    if (!finished) { log(`STOP materials: event spawn tidak diterima setelah ${spawnTimeoutMs}ms.`); finish(2); }
  }, spawnTimeoutMs);

  bot.once('spawn', async () => {
    clearTimeout(spawnTimer);
    if (finished) return;
    try {
      bot.loadPlugin(pathfinder);
      const bootstrapTerrainWork = process.env.STORAGE_MATERIALS_BOOTSTRAP_TERRAIN_WORK === '1';
      bot.pathfinder.setMovements(buildMovements(bot, {
        allowTerrainWork: bootstrapTerrainWork,
        terrainBreakAllowlist: bootstrapTerrainWork ? BASE_TERRAIN_NAMES : null,
        allow1by1Towers: false,
        maxDropDown: 3
      }));
      bot.pathfinder.thinkTimeout = 30000;
      // Worker ini hanya memegang lock saat membuka chest. Jalur menuju staging tidak perlu
      // mengunci sel yang sama dengan builder; kalau ikut reservasi gerak, antrean base dapat
      // berubah menjadi deadlock sebelum worker sempat memegang lock logistik.
      const adapter = new MineflayerRoleAdapter(bot, {
        log,
        navigateTimeoutMs: 15000,
        coordinateMovement: false,
        capabilities: ['smelt', 'craft', 'haul']
      });
      roleTask = claimExternalRoleTask(adapter, { taskTypes: ['PREPARE_MATERIALS'], capabilities: ['craft'], log });
      report('PREPARE');
      log(`Spawn materials worker di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
      // Jangan antre di sel pintu/base yang sama dengan dua builder. Titik staging ini tetap
      // cukup dekat untuk membuka chest, tetapi membuat reservasi jalur tidak saling membatalkan.
      // Live test menunjukkan staging ini aman setelah worker sudah berada di gudang, namun
      // rute spawn->staging sering buntu. Ladder utara adalah akses onboarding yang terbukti
      // selesai; pakai itu lebih dulu lalu biarkan operasi logistik menyebar dari sana.
      const landingGoals = [
        { x: -187, y: 71, z: -343 },
        baseGoal,
        { x: -185, y: 71, z: -352 },
        { x: -185, y: 71, z: -348 },
        { x: -181, y: 71, z: -348 }
      ].filter((goal, index, all) => all.findIndex(candidate => candidate.x === goal.x && candidate.y === goal.y && candidate.z === goal.z) === index);
      let arrival = { success: false, reason: 'NO_BASE_LANDING_GOAL' };
      for (const goal of landingGoals) {
        log(`Mencoba landing point base (${goal.x}, ${goal.y}, ${goal.z})${bootstrapTerrainWork ? ' dengan bootstrap terrain natural' : ''}...`);
        arrival = await walkToBase({ bot, goal, range: 4, settleMs: arrival.success ? 0 : 500, maxGotoMs: 45000,
          minimumY: 58,
          allowTerrainWork: bootstrapTerrainWork,
          terrainBreakAllowlist: bootstrapTerrainWork ? BASE_TERRAIN_NAMES : null,
          allow1by1Towers: false,
          maxDropDown: 3,
          fallbackGoalYOffsets: [-1, -2, -3],
          log });
        if (arrival.success) break;
        log(`Landing point (${goal.x}, ${goal.y}, ${goal.z}) belum terjangkau: ${arrival.reason}`);
      }
      if (!arrival.success) { report('BLOCKED', { reason: `BASE_UNREACHABLE:${arrival.reason}` }); finish(2); return; }
      log(`Posisi materials setelah landing: (${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)})`);
      log(`Blok sekitar landing: ${describeLocalAccess(bot, bot.entity.position)}`);
      // walkToBase intentionally uses a conservative no-dig profile for the
      // long journey. Restore the local logistics profile after landing: the
      // storage entrance can contain a natural dirt/grass step, and the wood
      // worker already proves this bounded profile can reach the chest aisle.
      // The allowlist still excludes stone, walls, chests and furnaces.
      bot.pathfinder.setMovements(buildMovements(bot, {
        allowTerrainWork: true,
        terrainBreakAllowlist: BASE_TERRAIN_NAMES,
        allow1by1Towers: false,
        // Lorong aktual memiliki satu step naik ke Y73; tanpa parkour ringan,
        // getPathTo dapat menemukan rute tetapi kontrol gerak tidak pernah
        // mengeksekusi lompatan tersebut.
        allowParkour: true,
        allowSprinting: false,
        maxDropDown: 3
      }));
      try { await adapter.setSpawnAtNearestBed(24); } catch (error) { log(`Bed materials belum terjangkau: ${error.message}`); }
      // Assignment memory points to the correct category, but the first
      // category chest is not always the best route seed from the ladder.
      // Warm one of the storage aisle anchors that a live forestry worker has
      // already opened successfully; after that, category chests are solved
      // from inside the aisle instead of from the doorway.
      const accessAnchors = [
        // Posisi berdiri di lorong sebelah barat peti. Jangan jadikan blok peti
        // sebagai goal: barisan peti/furnace membuat GoalNear kontainer mencari
        // voxel solid yang tidak pernah bisa ditempati.
        { x: -183, y: 72, z: -347 },
        { x: -183, y: 72, z: -348 },
        { x: -182, y: 72, z: -347 },
        { x: -183, y: 72, z: -345 }
      ];
      let aisleReady = false;
      const aisleWaypoints = [
        // Cobblestone di (-186,72,-343) menutup garis lurus dari ladder.
        // Jalur aman memutar satu blok ke utara, lalu menyusuri lantai terbuka.
        { x: -186, y: 72, z: -342 },
        { x: -185, y: 72, z: -342 },
        { x: -184, y: 72, z: -342 },
        { x: -183, y: 72, z: -342 },
        { x: -183, y: 72, z: -343 },
        { x: -183, y: 72, z: -345 },
        { x: -183, y: 72, z: -347 }
      ];
      for (const waypoint of aisleWaypoints) {
        log(`Menguji waypoint lorong (${waypoint.x},${waypoint.y},${waypoint.z})...`);
        log(`Probe path waypoint: ${inspectLocalPath(bot, waypoint)}`);
        // Posisi di ladder sering berada setengah blok dari voxel waypoint.
        // Radius nol membuat pathfinder mengulang target yang secara fisik
        // sudah tercapai; satu blok cukup presisi untuk membuka aisle tanpa
        // memaksa worker menabrak ladder atau peti.
        const reached = await adapter.navigateNear(waypoint, 1, { sharedRoute: true });
        log(`Waypoint (${waypoint.x},${waypoint.y},${waypoint.z}) ${reached ? 'tercapai' : 'gagal'}; posisi aktual (${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)}).`);
        if (reached) aisleReady = true;
        else if (waypoint === aisleWaypoints[0] && await nudgeOutOfLadder(bot, waypoint, log)) aisleReady = true;
        else break;
      }
      for (const anchor of accessAnchors) {
        log(`Mencoba masuk koridor logistik lewat anchor (${anchor.x},${anchor.y},${anchor.z})...`);
        log(`Blok sekitar anchor: ${describeLocalAccess(bot, anchor)}`);
        if (await adapter.navigateNear(anchor, 3, { sharedRoute: true })) {
          aisleReady = true;
          log(`Koridor logistik siap lewat anchor (${anchor.x},${anchor.y},${anchor.z}).`);
          break;
        }
      }
      if (!aisleReady) log('Koridor logistik belum terbuka dari ladder; lanjutkan dengan sumber assignment dan fallback live.');

      const foodChest = positionFor(assignments, 'cooked_beef', '-181,71,-345');
      let cycles = 0;
      let produced = 0;
      let deposited = 0;
      let furnaceExpansionChecked = false;
      // Lock tetap eksklusif per operasi, tetapi tidak memakai sidecar prioritas.
      // Sidecar membuat empat miner menunggu terus ketika materials segera
      // mengambil lock lagi untuk operasi berikutnya.
      const lockYieldMs = Math.max(0, Number(process.env.STORAGE_MATERIALS_LOCK_YIELD_MS) || 2500);
      const withLogisticsLock = async (action, lockOptions = {}) => {
        const result = await withLock(action, log, restockLockPath, lockOptions);
        // Beri kesempatan pada miner/builder yang sudah menunggu. Tanpa yield,
        // worker materials yang melakukan banyak operasi kecil dapat langsung
        // merebut lock berikutnya dan membuat seluruh swarm kelaparan.
        if (lockYieldMs > 0) await sleep(lockYieldMs);
        return result;
      };
      const depositAcrossStorage = async (names, predicate) => {
        let total = 0;
        const sources = storageSources(names);
        const attempted = new Set(sources.map(source => `${source.x},${source.y},${source.z}`));
        for (const source of sources) {
          const before = names.reduce((sum, name) => sum + adapter.getItemCount(name), 0);
          if (before <= 0) break;
          const result = await withLogisticsLock(
            () => adapter.depositToChest(source, predicate),
            { resourceKey: chestResourceKey(source, adapter) }
          );
          total += result.deposited || 0;
          const after = names.reduce((sum, name) => sum + adapter.getItemCount(name), 0);
          if (after >= before) continue;
          if (after <= 0) break;
        }
        // Assignment memory is a preferred destination, not a single point of failure.
        // When its chest is full, use a bounded nearby container so builder stock leaves
        // the worker inventory immediately; builders can discover this live source.
        const remaining = names.reduce((sum, name) => sum + adapter.getItemCount(name), 0);
        if (remaining > 0 && typeof adapter.findChestPositions === 'function') {
          const nearby = adapter.findChestPositions(32, 12);
          for (const source of nearby) {
            const key = `${source.x},${source.y},${source.z}`;
            if (attempted.has(key)) continue;
            attempted.add(key);
            const before = names.reduce((sum, name) => sum + adapter.getItemCount(name), 0);
            if (before <= 0) break;
            const result = await withLogisticsLock(
              () => adapter.depositToChest(source, predicate),
              { resourceKey: chestResourceKey(source, adapter) }
            );
            total += result.deposited || 0;
            const after = names.reduce((sum, name) => sum + adapter.getItemCount(name), 0);
            if (after < before) log(`Deposit fallback terkonfirmasi ${before - after} ${names.join('/')} ke (${source.x},${source.y},${source.z}).`);
          }
        }
        if (remaining > 0 && names.length === 1 && names[0] === 'stone_bricks') {
          // Jangan pernah membuat chest baru di sekitar posisi worker. Sesi lama memakai
          // fallback tersebut dan setiap restart lupa chest yang sudah dibuat, sehingga lantai
          // gudang perlahan dipenuhi peti acak dan tidak lagi menyisakan titik berdiri. Kapasitas
          // gudang harus ditambah oleh chest installer berdasarkan blueprint; materials worker
          // cukup mempertahankan barang di inventaris dan melaporkan blocker kapasitas.
          log(`BUILDING_MATERIAL_STORAGE_FULL remaining=${remaining}; peti ad-hoc dilarang, menunggu chest installer.`);
        }
        return { deposited: total };
      };
      while (!finished && cycles < maxCycles) {
        cycles += 1;
        report('LOGISTICS', { cycle: cycles, produced, deposited });
        const cycle = await (async () => {
          let cycleProduced = 0;
          let cycleDeposited = 0;
          if ((bot.food ?? 20) < 16) {
            await withLogisticsLock(async () => {
              await adapter.withdrawFromChest(foodChest, FOOD_NAMES, 16);
              for (let bite = 0; bite < 8 && (bot.food ?? 20) < 18; bite += 1) {
                if (!await adapter.eatBestFood(FOOD_NAMES)) break;
              }
            }, { resourceKey: chestResourceKey(foodChest, adapter) });
          }
          // Kosongkan output yang sudah jadi, tetapi jangan memindahkan seluruh cobble
          // sebelum produksi. Scan deposit cobble yang panjang membuat furnace baru
          // dimulai setelah beberapa menit, padahal builder hanya membutuhkan satu batch
          // stone_bricks untuk kembali bekerja.
          await depositAcrossStorage(['stone_bricks'], item => item.name === 'stone_bricks');
          await depositAcrossStorage(['chest', 'torch'], item => item.name === 'chest' || item.name === 'torch');
          // Survey awal bisa terjadi sebelum chunk yard atau posisi landing benar-benar siap.
          // Jangan mengunci hasil kosong selamanya; ulangi bounded tiap tiga siklus sampai
          // furnace berhasil ditempatkan.
          if (!furnaceExpansionChecked || cycles % 3 === 0) {
            try {
              // Penempatan furnace hanya menyentuh blok kerja materials di yard; tidak perlu
              // menahan lock chest sehingga miner dapat segera mengambil/mengantar hasil.
              const furnaceResult = await expandStorageFurnaces({ bot, adapter, execute: true, maxTargets: 4, log, withLock: withLogisticsLock });
              log(`Furnace logistik: ${JSON.stringify({ built: furnaceResult.built, targets: furnaceResult.targets.length, blocked: furnaceResult.blocked.length })}`);
              furnaceExpansionChecked = furnaceResult.targets.length > 0 && furnaceResult.built >= furnaceResult.targets.length;
            } catch (error) {
              log(`Furnace logistik dilewati: ${error.message}`);
            }
          }
          // `supplyStorageMaterial(stone_bricks)` di bawah sudah mengambil
          // cobblestone/fuel, mengisi furnace, dan menunggu output secara bounded.
          // Jangan survei ulang semua furnace di sini: pada gudang besar langkah
          // itu hanya membuka furnace kosong dan menunda batch pertama builder.
          const stoneBefore = adapter.getItemCount('stone_bricks');
          const brickSupply = await supplyStorageMaterial({
            bot,
            adapter,
            name: 'stone_bricks',
            required: 128,
            log,
            withLock: withLogisticsLock,
            fallbackSearch: false,
            // Furnace dijadwalkan tanpa menahan seluruh siklus sampai 90 detik.
            // Output diambil pada siklus berikutnya, sehingga worker tetap bisa
            // menjalankan crafting/deposit dan tidak macet pada satu furnace.
            waitForSmeltOutput: false,
            smeltTimeoutMs: Number(process.env.STORAGE_MATERIALS_SMELT_TIMEOUT_MS) || 90000,
            smeltPollMs: Number(process.env.STORAGE_MATERIALS_SMELT_POLL_MS) || 2000,
            withdrawExisting: false,
            preferCobblestone: true
          });
          const stoneProducedNow = Math.max(0, adapter.getItemCount('stone_bricks') - stoneBefore);
          cycleProduced += stoneProducedNow;
          // Prioritaskan hasil yang langsung membuka antrean builder. Jangan
          // menahan stone_bricks di inventory materials sambil memindai chest
          // utility dan cobblestone; satu batch kecil pun harus segera tersedia
          // di chest sumber konstruksi.
          const immediateBuilding = await depositAcrossStorage(['stone_bricks'], item => item.name === 'stone_bricks');
          cycleDeposited += immediateBuilding.deposited || 0;
          if (stoneProducedNow === 0 && brickSupply.missing > 0) {
            log('Output furnace masih pending; lewati crafting chest/door/torch dan panen pada siklus berikutnya.');
            return { produced: cycleProduced, deposited: cycleDeposited };
          }
          // Setelah batch batu pertama tersedia, baru siapkan peti dan pintu.
          // Ini menjaga akses gudang menjadi prioritas nyata dan mencegah scan
          // kategori kayu menghalangi material yang membuka antrean builder.
          const chestBefore = adapter.getItemCount('chest');
          await supplyStorageMaterial({ bot, adapter, name: 'chest', required: 16, log, withLock: withLogisticsLock, fallbackSearch: false, withdrawExisting: false });
          cycleProduced += Math.max(0, adapter.getItemCount('chest') - chestBefore);
          const doorBefore = adapter.getItemCount('oak_door');
          await supplyStorageMaterial({ bot, adapter, name: 'oak_door', required: 2, log, withLock: withLogisticsLock, fallbackSearch: false, withdrawExisting: false });
          cycleProduced += Math.max(0, adapter.getItemCount('oak_door') - doorBefore);
          const entryUtility = await depositAcrossStorage(['chest', 'oak_door'], item => item.name === 'chest' || item.name === 'oak_door');
          cycleDeposited += entryUtility.deposited || 0;
          const torchBefore = adapter.getItemCount('torch');
          await supplyStorageMaterial({ bot, adapter, name: 'torch', required: 32, log, withLock: withLogisticsLock, fallbackSearch: false });
          cycleProduced += Math.max(0, adapter.getItemCount('torch') - torchBefore);
          const building = await depositAcrossStorage(['stone_bricks'], item => item.name === 'stone_bricks');
          const utility = await depositAcrossStorage(['chest', 'torch', 'oak_door'], item => item.name === 'chest' || item.name === 'torch' || item.name === 'oak_door');
          const stone = await depositAcrossStorage(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'], item => ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'].includes(item.name));
          cycleDeposited += (building.deposited || 0) + (utility.deposited || 0) + (stone.deposited || 0);
          log(`MATERIALS_CYCLE ${JSON.stringify({ cycle: cycles, brickSupply, produced: cycleProduced, deposited: cycleDeposited })}`);
          return { produced: cycleProduced, deposited: cycleDeposited };
        })();
        produced += cycle.produced;
        deposited += cycle.deposited;
        if (cycle.produced === 0 && cycle.deposited === 0) {
          report('WAITING_MATERIAL', { reason: 'MATERIAL_SOURCE_UNCHANGED', cycles });
          await sleep(Math.min(15000, cycleDelayMs * 2));
        } else {
          await sleep(cycleDelayMs);
        }
      }
      report('PAUSED', { reason: 'TIME_LIMIT', produced, deposited });
      finish(0);
    } catch (error) {
      if (!finished) { log(`STOP materials: ${error.stack || error.message}`); report('BLOCKED', { reason: error.message }); finish(2); }
    }
  });
  bot.on('error', error => log(`ERROR materials: ${error.message}`));
  bot.on('kicked', reason => log(`DIKICK materials: ${JSON.stringify(reason)}`));
  bot.on('end', () => { if (!finished) { log('Koneksi materials berakhir sebelum proses selesai.'); finish(2); } });
  return bot;
}

module.exports = { startStorageRoomMaterials, positionFor, parsePosition };

if (require.main === module) {
  try { startStorageRoomMaterials(); } catch (error) { console.error(`GAGAL memulai materials worker: ${error.message}`); process.exitCode = 2; }
}
