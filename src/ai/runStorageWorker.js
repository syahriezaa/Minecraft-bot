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
const fs = require('fs');
const path = require('path');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { StorageManagerEngine } = require('./storageManagerEngine');
const { walkToBase } = require('./walkToBase');

const TICK_INTERVAL_MS = Number(process.env.STORAGE_TICK_MS) || 2000;
// Memori "jenis item ini pergi ke chest itu" DISIMPAN KE DISK - supaya sortir tetap konsisten
// lintas restart worker (tanpa ini, StorageManagerEngine cuma ingat assignment SELAMA proses ini
// hidup - begitu dashboard di-restart, semua memori hilang dan chest bisa dipilih beda-beda lagi
// tiap kali) - ditemukan dari keluhan nyata pemilik: "does not have any memory about storage chest".
const ASSIGNMENTS_FILE = process.env.STORAGE_ASSIGNMENTS_FILE || path.join(__dirname, '..', '..', 'data', 'storageChestAssignments.json');

function loadAssignments(log) {
  try {
    if (!fs.existsSync(ASSIGNMENTS_FILE)) return {};
    return JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, 'utf8'));
  } catch (e) {
    log(`PERINGATAN: gagal memuat memori sortir gudang dari disk (${e.message}) - mulai dari kosong.`);
    return {};
  }
}

function saveAssignments(assignments, log) {
  try {
    fs.mkdirSync(path.dirname(ASSIGNMENTS_FILE), { recursive: true });
    fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2));
  } catch (e) {
    log(`PERINGATAN: gagal menyimpan memori sortir gudang ke disk (${e.message})`);
  }
}
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
  return movements;
}

function startStorageWorker({ host, port, botName, scanRadius = 48, baseGoal = DEFAULT_BASE_GOAL, houseBounds = DEFAULT_HOUSE_BOUNDS, log = (m) => console.log(m), onDisconnect = () => {} }) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'StorageWorker',
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
      log(`PERINGATAN: gagal berjalan ke base (${walkResult.reason}) - tetap mulai bekerja di posisi sekarang.`);
    }

    const adapter = new MineflayerRoleAdapter(bot);

    const bedResult = await adapter.setSpawnAtNearestBed();
    log(bedResult ? 'Spawn point diset di bed dekat base.' : 'Tidak ada bed dalam jangkauan - spawn point tidak diubah.');

    const initialAssignments = loadAssignments(log);
    if (Object.keys(initialAssignments).length > 0) {
      log(`Muat memori sortir gudang dari sesi sebelumnya: ${Object.keys(initialAssignments).length} jenis item sudah punya chest langganan.`);
    }
    engine = new StorageManagerEngine({ adapter, scanRadius, houseBounds, initialAssignments });
    engine.on('collected', ({ position, count }) => log(`Ambil ${count} item dari chest luar di (${position.x},${position.y},${position.z})`));
    engine.on('delivered', ({ position, count, name }) => {
      log(`Antar ${count}x ${name} ke chest gudang di (${position.x},${position.y},${position.z})`);
      saveAssignments(engine.getChestAssignments(), log);
    });
    engine.on('inspected', ({ position, items }) => log(`Periksa chest gudang di (${position.x},${position.y},${position.z}) - isi: ${items.map((i) => `${i.name}x${i.count}`).join(', ') || '(kosong)'}`));
    engine.on('deliverFailed', ({ position, error, name }) => log(`Gagal antar ${name} ke chest gudang di (${position.x},${position.y},${position.z}) - ${error} - coba chest lain di tick berikutnya.`));

    log('Pekerja gudang mulai bekerja.');
    lastAction = 'WORKING';
    async function tick() {
      if (stopped) return;
      try {
        const result = await engine.tick();
        if (result.action !== 'idle') lastAction = result.action.toUpperCase();
      } catch (e) {
        log(`ERROR di tick gudang (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
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
      return { storage: engine.metrics };
    },
    getStatus() {
      return {
        role: 'Kuartermaster',
        position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        health: bot.health ?? null,
        status: lastAction
      };
    }
  };
}

module.exports = { startStorageWorker };

if (require.main === module) {
  startStorageWorker({
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    botName: process.env.MC_BOT_NAME || 'StorageWorker',
    scanRadius: Number(process.env.STORAGE_SCAN_RADIUS) || 48
  });
}
