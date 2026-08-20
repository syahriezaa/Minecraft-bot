/**
 * @file runRancherWorker.js
 * @description Pekerja peternakan otonom: beri makan hewan ternak (sapi, kambing, ayam, dst - lihat
 * ANIMAL_RULES di animalHusbandryEngine.js) supaya terus breeding, dan panen surplus indukan. Dipisah
 * dari pekerja tani (runFarmerWorker.js) atas permintaan pemilik - supaya beri makan ternak tidak
 * bersaing rebutan waktu tick dengan panen/tanam, dijalankan bot terpisah. Dibangun di atas
 * mineflayer + mineflayer-pathfinder langsung (sama seperti walkToBase.js).
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1.2';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { AnimalHusbandryEngine } = require('./animalHusbandryEngine');
const { walkToBase } = require('./walkToBase');

const TICK_INTERVAL_MS = Number(process.env.RANCHER_TICK_MS) || 2000;
const DEFAULT_BASE_GOAL = { x: -185, y: 71, z: -352 };
// Sama seperti runFarmerWorker.js/runGuardWorker.js - area peternakan villager dekat base, sebagian
// terhalang tembok, jangan pernah dijadikan target.
const DEFAULT_AVOID_AREA = { min: { x: -200, y: 0, z: -337 }, max: { x: -170, y: 100, z: -318 } };

function buildMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  return movements;
}

function startRancherWorker({ host, port, botName, scanRadius = 24, baseGoal = DEFAULT_BASE_GOAL, avoidArea = DEFAULT_AVOID_AREA, log = (m) => console.log(m), onDisconnect = () => {} }) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'RancherWorker',
    version: SERVER_VERSION,
    auth: 'offline',
    plugins: { time: false }
  });

  let animalEngine = null;
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

    animalEngine = new AnimalHusbandryEngine({ adapter, scanRadius, avoidArea });
    animalEngine.on('fed', ({ type, entity }) => log(`Beri makan ${type} (id ${entity.id})`));
    animalEngine.on('culled', ({ type, entity }) => log(`Panen surplus ${type} (id ${entity.id})`));

    log('Pekerja peternakan mulai bekerja.');
    lastAction = 'WORKING';
    async function tick() {
      if (stopped) return;
      try {
        const result = await animalEngine.tick();
        if (result.action !== 'idle') lastAction = result.action.toUpperCase();
      } catch (e) {
        log(`ERROR di tick peternakan (non-fatal, lanjut tick berikutnya): ${e.message}`);
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
      if (!animalEngine) return null;
      return { animals: animalEngine.metrics };
    },
    getStatus() {
      return {
        role: 'Peternak',
        position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        health: bot.health ?? null,
        status: lastAction
      };
    }
  };
}

module.exports = { startRancherWorker };

if (require.main === module) {
  startRancherWorker({
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    botName: process.env.MC_BOT_NAME || 'RancherWorker',
    scanRadius: Number(process.env.RANCHER_SCAN_RADIUS) || 24
  });
}
