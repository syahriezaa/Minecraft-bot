/**
 * @file runStorageWorker.js
 * @description Pekerja gudang ("kuartermaster") otonom: kumpulkan isi semua chest DI LUAR rumah
 * dan bawa masuk ke chest gudang DI DALAM ruang penyimpanan rumah, lalu rapikan gudang dengan
 * membuka tiap chest di dalamnya untuk memeriksa isinya. Permintaan nyata pemilik: "give me one
 * worker for managing storage so it collect all the chest outside the hose and bring it to the
 * house storage room and tidy up storage room by opening all the chest and check the item".
 * Dibangun di atas mineflayer + mineflayer-pathfinder langsung (sama seperti worker lain).
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1.2';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { StorageManagerEngine } = require('./storageManagerEngine');
const { walkToBase, SAFE_TRAVEL_TERRAIN_NAMES } = require('./walkToBase');
const { createEngineTaskHandlers, createCooperativeAgent, runCooperativeCycle } = require('./cooperativeAgent');
// Memori sortir gudang (rumah baku ore/ingot/gear, memori yang dipelajari dari disk, nama
// kategori, cadangan darurat) DIPINDAHKAN ke storageMemory.js - permintaan nyata pemilik: "share
// memory tentang peti ke semua bot agar dapat mencari barang barang dan menaruh barang dengan
// tepat". Modul ini sekarang cuma MEMAKAI memori itu (bukan satu-satunya pemiliknya lagi), sama
// seperti worker lain yang juga membacanya lewat storageMemory.js.
const {
  loadLearnedAssignments,
  saveLearnedAssignments,
  CANONICAL_ORE_INGOT_ASSIGNMENTS,
  CANONICAL_GEAR_ASSIGNMENTS,
  OVERFLOW_CHESTS,
  CHEST_CATEGORY_LABELS
} = require('./storageMemory');

const TICK_INTERVAL_MS = Number(process.env.STORAGE_TICK_MS) || 2000;

const DEFAULT_BASE_GOAL = { x: -185, y: 71, z: -352 };
// Ruang penyimpanan di dalam rumah - dipakai StorageManagerEngine untuk membedakan chest gudang
// (tujuan pengantaran/rapi-rapi) dari chest lain di luar rumah (sumber koleksi). Perkiraan awal di
// sekitar base (-185,71,-352). Pemilik mengonfirmasi live: SEMUA chest pada RENTANG KETINGGIAN
// (y) ini adalah gudang, apapun posisi x/z-nya - bukan kotak x/z sempit seperti dugaan awal (yang
// justru salah mengira sebagian chest gudang sungguhan sebagai chest "di luar rumah", membuat
// isinya diambil & dipindah - bug nyata yang dilaporkan pemilik). x/z sengaja DIBIARKAN SANGAT
// LEBAR (praktis tak terbatas) - cuma y yang benar-benar membedakan gudang dari chest luar.
const DEFAULT_HOUSE_BOUNDS = {
  min: { x: Number(process.env.STORAGE_HOUSE_MIN_X) || -1000000, y: Number(process.env.STORAGE_HOUSE_MIN_Y) || 70, z: Number(process.env.STORAGE_HOUSE_MIN_Z) || -1000000 },
  max: { x: Number(process.env.STORAGE_HOUSE_MAX_X) || 1000000, y: Number(process.env.STORAGE_HOUSE_MAX_Y) || 76, z: Number(process.env.STORAGE_HOUSE_MAX_Z) || 1000000 }
};

function buildMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  // Pemilik mengonfirmasi live: setiap chest gudang bisa dijangkau jalan kaki biasa, TANPA perlu
  // menaruh blok tambahan (mis. bikin tower 1x1 buat naik). Matikan kemampuan menaruh blok sama
  // sekali - kalau pathfinder sampai butuh menaruh blok untuk mencapai suatu chest, itu tandanya
  // ada masalah lain (posisi/jalur salah), bukan sesuatu yang memang perlu "dipecahkan" dengan
  // membangun - jangan buang-buang blok inventaris atau membangun struktur yang tidak diminta.
  movements.scafoldingBlocks = [];
  movements.allow1by1towers = false;
  return movements;
}

function canonicalContainerPosition(adapter, position) {
  const current = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const hereType = adapter.getChestHalfType(current);
  if (!hereType || hereType === 'single') return current;
  const opposite = hereType === 'left' ? 'right' : 'left';
  const neighbours = [
    { x: current.x - 1, y: current.y, z: current.z },
    { x: current.x + 1, y: current.y, z: current.z },
    { x: current.x, y: current.y, z: current.z - 1 },
    { x: current.x, y: current.y, z: current.z + 1 }
  ];
  const pair = neighbours.find(candidate => adapter.getChestHalfType(candidate) === opposite);
  if (!pair) return current;
  return [current, pair].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z)[0];
}

function startStorageWorker({ host, port, botName, scanRadius = 48, baseGoal = DEFAULT_BASE_GOAL, houseBounds = DEFAULT_HOUSE_BOUNDS, log = (m) => console.log(m), onDisconnect = () => {}, onMisplaced = () => {}, onChestSnapshot = () => {}, onAssignmentsChanged = () => {}, storageRepository = null, storageContext = null }) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'StorageWorker',
    version: SERVER_VERSION,
    auth: 'offline',
    plugins: { time: false }
  });

  let engine = null;
  let cooperativeRuntime = null;
  let stopped = false;
  let timer = null;
  let lastAction = 'CONNECTING';

  bot.once('spawn', async () => {
    bot.loadPlugin(pathfinder);
    bot.pathfinder.setMovements(buildMovements(bot));
    bot.pathfinder.thinkTimeout = 20000;
    log(`Spawn di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) - menunggu chunk sekitar ter-load...`);

    const walkResult = await walkToBase({ bot, goal: baseGoal, range: 4, settleMs: 5000, maxGotoMs: 12000, thinkTimeoutMs: 12000, stageDistance: 32, allowTerrainWork: true, allow1by1Towers: false, maxDropDown: 3, terrainBreakAllowlist: SAFE_TRAVEL_TERRAIN_NAMES, log });
    if (!walkResult.success) {
      log(`PERINGATAN: gagal berjalan ke base (${walkResult.reason}) - tetap mulai bekerja di posisi sekarang.`);
    }
    // walkToBase() MENIMPA movements bot dengan miliknya sendiri (allow1by1towers:true, scaffolding
    // dirt/cobblestone default - sengaja, supaya perjalanan awal 350+ blok dari spawn bisa membangun
    // jalan kalau benar-benar buntu) - tapi timpaan itu TERUS BERLAKU untuk semua navigasi
    // SESUDAHNYA juga (termasuk ke chest gudang yang sebenarnya sudah terjangkau jalan kaki biasa)
    // kalau tidak dipulihkan di sini. Pasang lagi movements TANPA taruh blok milik worker ini -
    // ditemukan dari keluhan nyata pemilik: "storage worker tetap berusaha memasang block padahal
    // cest terjangkau" - root cause-nya persis ini, bukan buildMovements() yang salah.
    bot.pathfinder.setMovements(buildMovements(bot));

    // Kuartermaster memakai storageRepository dan lock logistik tersendiri;
    // snapshot 3D periodik tidak boleh menahan dashboard saat gudang ramai.
    const adapter = new MineflayerRoleAdapter(bot, { log, sharedWorld: false, capabilities: ['storage', 'haul', 'audit'] });

    const bedResult = await adapter.setSpawnAtNearestBed();
    log(bedResult ? 'Spawn point diset di bed dekat base.' : 'Tidak ada bed dalam jangkauan - spawn point tidak diubah.');

    const initialAssignments = { ...loadLearnedAssignments(log), ...CANONICAL_ORE_INGOT_ASSIGNMENTS, ...CANONICAL_GEAR_ASSIGNMENTS };
    if (Object.keys(initialAssignments).length > 0) {
      log(`Muat memori sortir gudang: ${Object.keys(initialAssignments).length} jenis item sudah punya chest langganan (termasuk rumah baku ore/ingot dan gear/makanan/buku).`);
    }
    engine = new StorageManagerEngine({ adapter, scanRadius, houseBounds, initialAssignments, overflowChests: OVERFLOW_CHESTS });
    cooperativeRuntime = createCooperativeAgent(adapter, {
      capabilities: ['storage', 'haul', 'audit'],
      metadata: { role: 'storage' },
      handlers: createEngineTaskHandlers(engine, {
        AUDIT_STORAGE: { actions: ['inspect', 'reorganize', 'collect'], idleCompletes: true },
        SORT_ITEMS: { actions: ['reorganize', 'collect', 'deliver', 'deliver_failed'], mutatesWorld: true, idleCompletes: true },
        VERIFY_STORAGE: { actions: ['inspect'], idleCompletes: true },
        HAUL_RESOURCES: { actions: ['deliver', 'collect'], idleCompletes: true },
        DEPOSIT_CROPS: { actions: ['deliver'], idleCompletes: true },
        DEPOSIT_ANIMAL_PRODUCTS: { actions: ['deliver'], idleCompletes: true }
      })
    });
    engine.on('collected', ({ position, count }) => log(`Ambil ${count} item dari chest luar di (${position.x},${position.y},${position.z})`));
    engine.on('delivered', ({ position, count, name }) => {
      log(`Antar ${count}x ${name} ke chest gudang di (${position.x},${position.y},${position.z})`);
      const assignments = engine.getChestAssignments();
      saveLearnedAssignments(assignments, log);
      storageRepository?.upsertAssignments(storageContext, assignments, botName || 'StorageWorker');
      // Dorong lewat WS LANGSUNG (bukan cuma disk) - permintaan nyata pemilik: "use ws to update
      // memory ui to memory is dynamic not just in every restart" - panel "Memori Sortir Worker"
      // di dashboard harus ikut berubah SAAT ITU JUGA kalau ada item baru yang belajar rumahnya
      // (lewat resolveChestForItem), bukan cuma ter-refresh pas restart atau nebeng event lain.
      onAssignmentsChanged(assignments);
    });
    engine.on('inspected', ({ position, items }) => log(`Periksa chest gudang di (${position.x},${position.y},${position.z}) - isi: ${items.map((i) => `${i.name}x${i.count}`).join(', ') || '(kosong)'}`));
    engine.on('deliverFailed', ({ position, error, name }) => log(`Gagal antar ${name} ke chest gudang di (${position.x},${position.y},${position.z}) - ${error} - coba chest lain di tick berikutnya.`));
    engine.on('chestError', ({ position, error }) => log(`Chest di (${position.x},${position.y},${position.z}) gagal dibuka (${error}) - dilewati, lanjut ke chest lain.`));
    engine.on('misplaced', ({ position, item, count, correctPosition }) => {
      log(`Item SALAH TEMPAT: ${count}x ${item} di (${position.x},${position.y},${position.z}) - diambil, akan diantar ke (${correctPosition.x},${correctPosition.y},${correctPosition.z})`);
      // Dipakai panel "Kepatuhan Kategori Gudang" di dashboard - permintaan nyata pemilik: chest
      // yang belum sesuai aturan kategori harus tercatat, supaya terlihat tanpa perlu scan manual.
      const entry = { botName: botName || 'StorageWorker', position, item, count, correctPosition, timestamp: Date.now() };
      storageRepository?.recordCompliance(storageContext, entry);
      onMisplaced(entry);
    });
    engine.on('chestSnapshot', ({ position, items, misplaced }) => {
      // Dipakai panel peta gudang di dashboard - permintaan nyata pemilik: "di ui web tampilkan
      // isi semua peti...dan bagaimana bot akan memindahkannya di tandai dengan panah panah".
      const snapshot = {
        position,
        containerPosition: canonicalContainerPosition(adapter, position),
        items,
        misplaced,
        timestamp: Date.now()
      };
      storageRepository?.saveChestSnapshot(storageContext, snapshot, botName || 'StorageWorker');
      onChestSnapshot(snapshot);
    });

    log('Pekerja gudang mulai bekerja.');
    lastAction = 'WORKING';
    async function tick() {
      if (stopped) return;
      try {
        const result = await runCooperativeCycle(cooperativeRuntime, () => engine.tick());
        if (result.action !== 'idle') lastAction = result.action.toUpperCase();
      } catch (e) {
        log(`ERROR di tick gudang (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
      // Cek lagi SESUDAH await (bukan cuma di awal fungsi) - koneksi bisa saja terputus SAAT
      // engine.tick() sedang menunggu (mis. chest open yang macet 20 detik lalu timeout tepat
      // ketika bot disconnect) - tanpa ini, satu tick tambahan tetap terjadwal walau worker
      // sebenarnya sudah berhenti.
      if (stopped) return;
      timer = setTimeout(tick, TICK_INTERVAL_MS);
    }
    tick();
  });

  bot.on('error', (e) => log(`ERROR: ${e.message}`));
  bot.on('kicked', (r) => log(`DIKICK: ${JSON.stringify(r)}`));
  bot.on('end', (reason) => {
    if (stopped) return;
    log(`Koneksi terputus tak terduga (${reason || 'tidak diketahui'}) - worker berhenti.`);
    stopped = true;
    if (timer) clearTimeout(timer);
    cooperativeRuntime?.stop();
    onDisconnect();
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      cooperativeRuntime?.stop();
      bot.quit();
    },
    getMetrics() {
      if (!engine) return null;
      return { storage: engine.metrics };
    },
    // Memori sortir MENTAH, verbatim dari engine.getChestAssignments() - permintaan nyata
    // pemilik: "harusnya yang tampil di web itu sama persis dengan memory worker nya". Dipakai
    // dashboard supaya yang ditampilkan bukan turunan/olahan, tapi persis objek yang sama yang
    // engine pakai sendiri untuk memutuskan ke mana tiap jenis item pergi.
    getAssignments() {
      if (!engine) return null;
      return engine.getChestAssignments();
    },
    getStatus() {
      return {
        role: 'Kuartermaster',
        position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        health: bot.health ?? null,
        status: lastAction,
        inventory: bot.inventory ? bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) : []
      };
    }
  };
}

module.exports = { startStorageWorker, CHEST_CATEGORY_LABELS, canonicalContainerPosition };

if (require.main === module) {
  const { SharedWorldMemory } = require('./sharedWorldMemory');
  const { StorageRepository } = require('./storageRepository');
  const host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg';
  const port = Number(process.env.MC_PORT) || 25565;
  const memory = new SharedWorldMemory();
  const storageRepository = new StorageRepository(memory);
  startStorageWorker({
    host,
    port,
    botName: process.env.MC_BOT_NAME || 'StorageWorker',
    scanRadius: Number(process.env.STORAGE_SCAN_RADIUS) || 48,
    storageRepository,
    storageContext: {
      world: process.env.MC_WORLD_ID || `${host}:${port}`,
      dimension: process.env.MC_DIMENSION_ID || 'overworld'
    },
    onDisconnect: () => memory.close()
  });
}
