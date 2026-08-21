/**
 * @file runFarmerWorker.js
 * @description Pekerja pertanian otonom: panen crop matang, tanam ulang benih (bergantian antar
 * jenis - lihat chooseSeedFor di farmerEngine.js), simpan hasil panen ke chest gudang yang SUDAH
 * berisi jenis item yang sama (autoMatchStorage). Peternakan (beri makan ternak) DIPISAH ke worker
 * sendiri (runRancherWorker.js) atas permintaan pemilik - supaya tidak bersaing rebutan waktu tick
 * dengan panen/tanam. Dibangun di atas mineflayer + mineflayer-pathfinder langsung (sama seperti
 * walkToBase.js), BUKAN pipeline A-star/voxel kustom yang sudah dihapus sesi ini.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
// Nama env var SENGAJA beda dari MC_VERSION generik - .env proyek ini punya MC_VERSION=1.20.1
// untuk keperluan LAIN (server dev lokal flying-squid), dan dotenv.config() di webServer.js
// membuat nilai itu diam-diam menimpa versi server nyata di sini kalau nama env-nya sama (bug
// nyata: worker yang dimulai lewat dashboard gagal konek - "you are using version 1.20.1" -
// padahal server sungguhan 26.1.2 - karena webServer.js load .env sebelum modul ini di-require).
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1.2';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { FarmerEngine, CROP_RULES } = require('./farmerEngine');
const { walkToBase } = require('./walkToBase');
// Memori sortir gudang DIBAGIKAN dari StorageWorker - permintaan nyata pemilik: "share memory
// tentang peti ke semua bot agar dapat mencari barang barang dan menaruh barang dengan tepat".
// Dulu FarmerWorker terpaksa menebak lewat pemindaian chest satu-satu (findMatchingChest) setiap
// kali mau menyimpan/mengambil barang - sekarang pakai memori yang SAMA persis dengan yang
// dipakai StorageWorker untuk merapikan gudang.
const { getSharedChestAssignments, parseChestPositionKey } = require('./storageMemory');

const TICK_INTERVAL_MS = Number(process.env.FARMER_TICK_MS) || 2000;
// Base sungguhan pemilik (dikoreksi live sesi ini - lihat commit sebelumnya, -175,71,-325 lama
// ternyata area peternakan villager, bukan base). FarmerEngine cuma menyisir dalam scanRadius dari
// posisi bot SEKARANG - kalau bot dengan identitas BARU (belum pernah login, atau logout jauh dari
// base) mulai bekerja, dia diam saja karena tidak ada apa-apa dalam jangkauan di posisi spawn/world
// spawn. Jalan ke base dulu SEBELUM mulai tick pertanian, apapun posisi awalnya.
const DEFAULT_BASE_GOAL = { x: -185, y: 71, z: -352 };
// Area peternakan villager, ditemukan live sesi ini (beds di sekitar -181..-185,64,-330..-331,
// crop di ~-190,63,-327 dan -188,64,-326) - sebagian terhalang tembok kandang, dan berada dalam
// scanRadius default dari base sehingga terus-menerus menarik bot ke sana untuk mencoba mencapai
// target yang kadang tak terjangkau. Dikecualikan sama sekali dari pertimbangan farm engine (lihat
// avoidArea) - pemilik minta bot jangan pernah ke sana lagi.
const DEFAULT_AVOID_AREA = { min: { x: -200, y: 0, z: -337 }, max: { x: -170, y: 100, z: -318 } };
// Batas lahan farming SUNGGUHAN - permintaan nyata pemilik (koordinat diberikan langsung):
// "hanya perbaiki lahan pertanian di koordinat tadi untuk farmworker set itu". Sebelumnya
// farmArea TIDAK PERNAH diset sama sekali (selalu null/tanpa batas) - FarmerWorker menganggap
// SEMUA farmland yang kebetulan ditemukan dalam scanRadius sebagai lahannya, termasuk potensi
// lahan/petak lain yang bukan bagian kebun sungguhan. Rentang Y diberi margin (55-72) di atas/
// bawah y=62 (ketinggian farmland sungguhan) untuk menampung crop/terrain sekitarnya.
const DEFAULT_FARM_AREA = { min: { x: -211, y: 55, z: -405 }, max: { x: -183, y: 72, z: -372 } };

function buildMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  // Parkour DIMATIKAN - permintaan nyata pemilik: "bot nya ngawur seperti tidak paham map
  // sekitar base". Parkour bikin pathfinder berani lompat/turun lewat rute pendek yang berisiko
  // (mis. langsung melintasi lubang ledakan creeper di lahan farming) alih-alih memutar jalan
  // aman - terbukti lewat log live: metrics.eaten melonjak drastis (17->26 dalam beberapa menit)
  // persis saat fitur perbaikan lahan sedang aktif bekerja di dekat lubang, tanda bot berulang
  // kali kena damage (regenerasi HP menguras hunger cepat) - fall damage, bukan navigasi acak.
  movements.allowParkour = false;
  movements.allowSprinting = true;
  // Batasi jatuh maksimal 3 blok (default library 4) - di Minecraft, jatuh SAMPAI 3 blok TIDAK
  // kena damage sama sekali, jatuh 4 blok pasti kena 1 damage. Defaultnya (4) berarti pathfinder
  // BOLEH memilih rute yang PASTI menyakiti bot sebagai "jalan pintas" - sering terpilih di dekat
  // tepi lubang/medan tidak rata sekitar base, persis skenario "tidak paham map sekitar base" di
  // atas. Menurunkan ke 3 membuat pathfinder cuma memilih rute turun yang benar-benar aman.
  movements.maxDropDown = 3;
  // Jangan pernah menaruh blok (mis. dirt/cobblestone) untuk membangun jalan/tower - kebun dan
  // chest gudang semuanya sudah terjangkau jalan kaki biasa, taruh blok cuma buang-buang bahan
  // dan bisa merusak tampilan base - ditemukan dari keluhan nyata pemilik ("kenapa dia selalu
  // menaruh block padahal cest bisa di jangkau") - berlaku sama seperti StorageWorker.
  movements.scafoldingBlocks = [];
  movements.allow1by1towers = false;
  return movements;
}

// Kalau stok benih di inventaris cuma satu jenis (mis. cuma wheat_seeds, sisa kebun sebelumnya
// selalu didominasi wheat) - kebun jadi seragam wheat terus walau ada carrot/potato yang mestinya
// bisa ditanam, KARENA jenis lain itu tidak pernah masuk inventaris sama sekali (crop lain harus
// dipanen dulu dari lapangan untuk dapat benihnya, dan kalau lapangannya sendiri didominasi wheat,
// bot tidak pernah kebagian benih carrot/potato). Ambil sedikit dari gudang (kalau ada stok di sana
// dari panen sebelumnya) supaya rotasi tanam benar-benar punya variasi untuk dipilih.
async function restockSeedVarietyFromStorage(adapter, log, sharedChestAssignments) {
  const seedNames = Object.values(CROP_RULES).map((rule) => rule.seed);
  for (const seedName of seedNames) {
    if (adapter.hasItem(seedName)) continue; // sudah punya, tidak perlu restock jenis ini
    // Cari lewat memori bersama DULU (posisi sudah pasti benar, tidak perlu buka chest satu-satu)
    // - permintaan nyata pemilik: "share memory tentang peti ke semua bot agar dapat mencari
    // barang barang". Cuma jatuh ke live-scan (findMatchingChest) kalau jenis benih ini belum
    // dikenal sama sekali di memori bersama.
    const sharedKey = sharedChestAssignments?.[seedName];
    const chestPos = sharedKey ? parseChestPositionKey(sharedKey) : await adapter.findMatchingChest([seedName]);
    if (!chestPos) continue; // tidak ada stok di gudang untuk jenis ini - lewati
    const result = await adapter.withdrawFromChest(chestPos, [seedName], 16);
    if (result.withdrawn > 0) log(`Ambil ${result.withdrawn}x ${seedName} dari gudang untuk variasi tanam.`);
  }
}

function startFarmerWorker({ host, port, botName, scanRadius = 32, baseGoal = DEFAULT_BASE_GOAL, avoidArea = DEFAULT_AVOID_AREA, farmArea = DEFAULT_FARM_AREA, log = (m) => console.log(m), onDisconnect = () => {} }) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'FarmerWorker',
    version: SERVER_VERSION,
    auth: 'offline',
    plugins: { time: false }
  });

  let engine = null;
  let stopped = false;
  let timer = null;
  let lastAction = 'CONNECTING';

  bot.once('spawn', async () => {
    bot.loadPlugin(pathfinder);
    bot.pathfinder.setMovements(buildMovements(bot));
    bot.pathfinder.thinkTimeout = 20000;
    log(`Spawn di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) - menunggu chunk sekitar ter-load...`);

    const walkResult = await walkToBase({ bot, goal: baseGoal, range: 4, settleMs: 5000, log });
    if (!walkResult.success) {
      log(`PERINGATAN: gagal berjalan ke base (${walkResult.reason}) - tetap mulai bekerja di posisi sekarang, mungkin tidak menemukan apa-apa.`);
    }
    // walkToBase() menimpa movements bot dengan miliknya sendiri (scaffolding aktif untuk
    // perjalanan awal dari spawn) - timpaan itu terus berlaku untuk navigasi SESUDAHNYA juga kalau
    // tidak dipulihkan di sini - ditemukan dari keluhan nyata pemilik: bot tetap berusaha memasang
    // blok padahal target (kebun/chest) sudah terjangkau jalan kaki biasa.
    bot.pathfinder.setMovements(buildMovements(bot));

    const adapter = new MineflayerRoleAdapter(bot);

    // Klik bed terdekat SEBELUM mulai kerja apapun - supaya kalau proses ini direstart/logout,
    // bot lanjut dari base pada login berikutnya, bukan jalan kaki 300+ blok ulang dari world spawn
    // setiap kali (masalah nyata yang berulang kali muncul sesi ini).
    const bedResult = await adapter.setSpawnAtNearestBed();
    log(bedResult ? 'Spawn point diset di bed dekat base.' : 'Tidak ada bed dalam jangkauan - spawn point tidak diubah.');

    const sharedChestAssignments = getSharedChestAssignments(log);
    log(`Muat memori sortir gudang bersama: ${Object.keys(sharedChestAssignments).length} jenis item sudah punya chest langganan (sama persis dengan yang dipakai StorageWorker).`);

    await restockSeedVarietyFromStorage(adapter, log, sharedChestAssignments);

    engine = new FarmerEngine({
      adapter,
      scanRadius,
      avoidArea,
      farmArea,
      autoMatchStorage: true,
      sharedChestAssignments,
      harvestBatchSize: Number(process.env.FARM_HARVEST_BATCH) || 16,
      plantBatchSize: Number(process.env.FARM_PLANT_BATCH) || 16
    });

    engine.on('harvested', ({ crop, position }) => {
      // Nama blok crop (mis. "carrots") beda dari nama item hasil panennya (mis. "carrot") - jangan
      // cek getItemCount(crop) langsung (selalu 0, salah nama), hitung total SEMUA item hasil panen
      // di inventaris supaya benar-benar memverifikasi barangnya terambil, bukan cuma tergali.
      const total = adapter.getInventoryItems()
        .filter((i) => engine.isFarmOutput(i.name))
        .reduce((s, i) => s + (i.count || 1), 0);
      log(`Panen ${crop} di (${position.x},${position.y},${position.z}) - total item hasil panen di inventaris sekarang: ${total}`);
    });
    engine.on('planted', ({ seed, position }) => log(`Tanam ${seed} di (${position.x},${position.y},${position.z})`));
    // Log EKSPLISIT untuk makan - permintaan nyata pemilik: "kenapa farming workernya tidak bisa
    // menaruh barangnya di peti" - tanpa log ini, tidak mungkin membuktikan apakah bot terjebak
    // bolak-balik makan terus (hunger tidak pernah naik cukup untuk sempat panen/tanam/setor).
    engine.on('ate', ({ foodBefore, foodAfter }) => log(`Makan (food ${foodBefore} -> ${foodAfter})`));
    // Log EKSPLISIT untuk perbaikan lahan - permintaan nyata pemilik: "it full of holes why not
    // repairing" - tanpa log ini, perbaikan yang SUNGGUH terjadi tetap tidak terlihat sama sekali
    // di dashboard/feed, jadi tidak ada cara membuktikan fitur ini benar-benar jalan atau tidak.
    engine.on('repaired', ({ position, type }) => {
      const label = type === 'fill' ? 'Isi lubang & cangkul' : 'Cangkul';
      log(`${label} lahan di (${position.x},${position.y},${position.z})`);
    });
    engine.on('repairError', ({ step, position, error }) => {
      const posLabel = position ? ` di (${position.x},${position.y},${position.z})` : '';
      log(`PERINGATAN: gagal ${step}${posLabel} untuk perbaikan lahan (${error}) - lewati, coba kandidat/tick lain.`);
    });
    // Log EKSPLISIT setiap kali SATU jenis item gagal disetor (chest tujuannya penuh dsb) -
    // ditemukan dari bug live nyata: metrics.deposited tetap 0 selama bermenit-menit walau sudah
    // panen ratusan item, karena satu jenis yang gagal dulu menjatuhkan seluruh loop setor sebelum
    // ada log apapun yang sempat tercatat.
    engine.on('depositError', ({ name, position, error }) => log(`PERINGATAN: gagal setor ${name} ke (${position.x},${position.y},${position.z}) (${error}) - lewati, coba jenis lain.`));

    log('Pekerja pertanian mulai bekerja.');
    lastAction = 'WORKING';
    async function tick() {
      if (stopped) return;
      try {
        const farmResult = await engine.tick();
        if (farmResult.action === 'deposit') log(`Simpan ${farmResult.count} item ke gudang.`);
        if (farmResult.action !== 'idle') lastAction = farmResult.action.toUpperCase();
      } catch (e) {
        log(`ERROR di tick pertanian (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
      timer = setTimeout(tick, TICK_INTERVAL_MS);
    }
    tick();
  });

  bot.on('error', (e) => log(`ERROR: ${e.message}`));
  bot.on('kicked', (r) => log(`DIKICK: ${JSON.stringify(r)}`));
  // Koneksi terputus (kick, timeout, atau server drop) - tanpa ini, handle worker tetap "hidup" di
  // Map dashboard SELAMANYA dengan data metrik basi, walau bot sungguhan sudah lama offline (bug
  // nyata: dashboard terus melaporkan "running: true" untuk bot yang sebenarnya sudah disconnect).
  // Cek `stopped` supaya TIDAK memicu onDisconnect kalau memang KITA yang menghentikannya lewat
  // stop() (event 'end' juga terpicu saat bot.quit() dipanggil sendiri).
  bot.on('end', (reason) => {
    if (stopped) return;
    log(`Koneksi terputus tak terduga (${reason || 'tidak diketahui'}) - worker berhenti.`);
    stopped = true;
    if (timer) clearTimeout(timer);
    onDisconnect();
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      bot.quit();
    },
    getMetrics() {
      if (!engine) return null;
      return { farm: engine.metrics };
    },
    // Dipakai panel "Koordinat Armada Live" di dashboard - posisi/kesehatan/aksi terakhir SUNGGUHAN
    // dari bot ini, bukan data simulasi.
    getStatus() {
      return {
        role: 'Pekerja Tani',
        position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        health: bot.health ?? null,
        status: lastAction,
        // Isi tas sungguhan bot ini SAAT INI - dipakai panel "Koordinat Armada Live" di dashboard.
        inventory: bot.inventory ? bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) : []
      };
    },
    // Baca komposisi blok dalam kotak x/z (satu ketinggian y) memakai chunk yang SUDAH termuat
    // oleh bot ini - TANPA perlu jalan kaki sama sekali, karena bot ini sudah lama bekerja persis
    // di area gudang/farming. Dipakai untuk verifikasi cepat batas area (mis. "apakah kotak
    // koordinat ini benar-benar lahan farming?") tanpa harus spawn bot baru yang jalan dari nol.
    queryBlockBox({ minX, maxX, minZ, maxZ, y }) {
      const { Vec3 } = require('vec3');
      const counts = {};
      let total = 0;
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          total++;
          const block = bot.blockAt(new Vec3(x, y, z));
          const name = block ? block.name : 'unloaded';
          counts[name] = (counts[name] || 0) + 1;
        }
      }
      return { total, counts };
    }
  };
}

module.exports = { startFarmerWorker, buildMovements };

if (require.main === module) {
  startFarmerWorker({
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    botName: process.env.MC_BOT_NAME || 'FarmerWorker',
    scanRadius: Number(process.env.FARM_SCAN_RADIUS) || 32
  });
}
