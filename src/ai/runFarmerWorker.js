/**
 * @file runFarmerWorker.js
 * @description Pekerja pertanian+peternakan otonom: panen crop matang, tanam ulang benih, simpan
 * hasil panen ke chest gudang yang SUDAH berisi jenis item yang sama (lihat autoMatchStorage di
 * farmerEngine.js), dan beri makan hewan ternak (sapi, kambing, ayam, dst - lihat ANIMAL_RULES di
 * animalHusbandryEngine.js) supaya terus breeding. Dibangun di atas mineflayer + mineflayer-
 * pathfinder langsung (sama seperti walkToBase.js), BUKAN pipeline A-star/voxel kustom yang sudah
 * dihapus sesi ini.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
const SERVER_VERSION = process.env.MC_VERSION || '26.1.2';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { FarmerEngine } = require('./farmerEngine');
const { AnimalHusbandryEngine } = require('./animalHusbandryEngine');
const { walkToBase } = require('./walkToBase');

const TICK_INTERVAL_MS = Number(process.env.FARMER_TICK_MS) || 2000;
// Base sungguhan pemilik (dikoreksi live sesi ini - lihat commit sebelumnya, -175,71,-325 lama
// ternyata area peternakan villager, bukan base). FarmerEngine cuma menyisir dalam scanRadius dari
// posisi bot SEKARANG - kalau bot dengan identitas BARU (belum pernah login, atau logout jauh dari
// base) mulai bekerja, dia diam saja karena tidak ada apa-apa dalam jangkauan di posisi spawn/world
// spawn. Jalan ke base dulu SEBELUM mulai tick pertanian/peternakan, apapun posisi awalnya.
const DEFAULT_BASE_GOAL = { x: -185, y: 71, z: -352 };

function buildMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  return movements;
}

function startFarmerWorker({ host, port, botName, scanRadius = 32, baseGoal = DEFAULT_BASE_GOAL, log = (m) => console.log(m) }) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'FarmerWorker',
    version: SERVER_VERSION,
    auth: 'offline',
    plugins: { time: false }
  });

  let engine = null;
  let animalEngine = null;
  let stopped = false;
  let timer = null;

  bot.once('spawn', async () => {
    bot.loadPlugin(pathfinder);
    bot.pathfinder.setMovements(buildMovements(bot));
    bot.pathfinder.thinkTimeout = 20000;
    log(`Spawn di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) - menunggu chunk sekitar ter-load...`);

    // Jalan ke base DULU sebelum mulai bekerja - identitas bot baru (belum pernah login) atau yang
    // logout jauh dari base akan diam saja kalau langsung mulai tick (tidak ada crop/hewan dalam
    // jangkauan scanRadius di posisi spawn). Kalau sudah berada dekat base (mis. logout terakhir di
    // sana), walkToBase akan langsung selesai cepat (goal sudah tercapai).
    const walkResult = await walkToBase({ bot, goal: baseGoal, range: 4, settleMs: 5000, log });
    if (!walkResult.success) {
      log(`PERINGATAN: gagal berjalan ke base (${walkResult.reason}) - tetap mulai bekerja di posisi sekarang, mungkin tidak menemukan apa-apa.`);
    }

    const adapter = new MineflayerRoleAdapter(bot);
    engine = new FarmerEngine({
      adapter,
      scanRadius,
      autoMatchStorage: true,
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

    animalEngine = new AnimalHusbandryEngine({ adapter, scanRadius });
    animalEngine.on('fed', ({ type, entity }) => log(`Beri makan ${type} (id ${entity.id})`));
    animalEngine.on('culled', ({ type, entity }) => log(`Panen surplus ${type} (id ${entity.id})`));

    log('Pekerja pertanian & peternakan mulai bekerja.');
    async function tick() {
      if (stopped) return;
      try {
        const farmResult = await engine.tick();
        if (farmResult.action === 'deposit') log(`Simpan ${farmResult.count} item ke gudang.`);
      } catch (e) {
        log(`ERROR di tick pertanian (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
      try {
        await animalEngine.tick();
      } catch (e) {
        log(`ERROR di tick peternakan (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
      timer = setTimeout(tick, TICK_INTERVAL_MS);
    }
    tick();
  });

  bot.on('error', (e) => log(`ERROR: ${e.message}`));
  bot.on('kicked', (r) => log(`DIKICK: ${JSON.stringify(r)}`));

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      bot.quit();
    },
    getMetrics() {
      if (!engine) return null;
      return { farm: engine.metrics, animals: animalEngine ? animalEngine.metrics : null };
    }
  };
}

module.exports = { startFarmerWorker };

if (require.main === module) {
  startFarmerWorker({
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    botName: process.env.MC_BOT_NAME || 'FarmerWorker',
    scanRadius: Number(process.env.FARM_SCAN_RADIUS) || 32
  });
}
