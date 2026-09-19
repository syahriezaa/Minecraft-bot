/**
 * @file runGuardWorker.js
 * @description Pekerja penjaga otonom: patroli/jaga base, lawan mob hostile yang mendekat (pakai
 * MobFarmEngine yang sudah ada), dan perbaiki gear yang hilang/rusak dengan craft besi baru dari
 * iron di gudang (GearRepairEngine, lihat komentar di sana) - slot armor kosong berarti gear
 * lenyap/rusak total, bukan sekadar tergores. Dibangun di atas mineflayer + mineflayer-pathfinder
 * langsung (sama seperti walkToBase.js dan runFarmerWorker.js).
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
// Nama env var SENGAJA beda dari MC_VERSION generik - lihat komentar identik di runFarmerWorker.js
// (bug nyata: .env proyek ini punya MC_VERSION=1.20.1 untuk server dev lokal lain, diam-diam
// menimpa versi server nyata di sini kalau nama env-nya sama).
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1.2';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { MobFarmEngine } = require('./mobFarmEngine');
const { GearRepairEngine } = require('./gearRepairEngine');
const { walkToBase, SAFE_TRAVEL_TERRAIN_NAMES } = require('./walkToBase');
const { createEngineTaskHandlers, createCooperativeAgent } = require('./cooperativeAgent');

const TICK_INTERVAL_MS = Number(process.env.GUARD_TICK_MS) || 2000;
const DEFAULT_BASE_GOAL = { x: -185, y: 71, z: -352 };
// Sama seperti runFarmerWorker.js - area peternakan villager dekat base, sebagian terhalang tembok,
// jangan pernah dijadikan target patroli/kejar mob ke sana.
const DEFAULT_AVOID_AREA = { min: { x: -200, y: 0, z: -337 }, max: { x: -170, y: 100, z: -318 } };

function buildMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  // Jangan pernah menaruh blok untuk membangun jalan/tower - ditemukan dari keluhan nyata pemilik
  // ("kenapa dia selalu menaruh block padahal cest bisa di jangkau") - berlaku sama di semua worker.
  movements.scafoldingBlocks = [];
  movements.allow1by1towers = false;
  return movements;
}

function startGuardWorker({ host, port, botName, scanRadius = 16, baseGoal = DEFAULT_BASE_GOAL, avoidArea = DEFAULT_AVOID_AREA, log = (m) => console.log(m), onDisconnect = () => {} }) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'GuardWorker',
    version: SERVER_VERSION,
    auth: 'offline',
    plugins: { time: false }
  });

  let combatEngine = null;
  let repairEngine = null;
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
      log(`PERINGATAN: gagal berjalan ke base (${walkResult.reason}) - tetap mulai berjaga di posisi sekarang.`);
    }
    // walkToBase() menimpa movements bot dengan miliknya sendiri (scaffolding aktif untuk
    // perjalanan awal dari spawn) - pulihkan lagi supaya patroli/pertarungan sesudahnya tidak ikut
    // memasang blok yang tidak perlu.
    bot.pathfinder.setMovements(buildMovements(bot));

    const adapter = new MineflayerRoleAdapter(bot, { spatialSampling: false, occupancyIntervalMs: 1500,
      capabilities: ['combat', 'patrol', 'survey'] });

    // Klik bed terdekat SEBELUM mulai berjaga - sama seperti runFarmerWorker.js, supaya restart
    // berikutnya lanjut dari base, bukan jalan kaki ulang dari world spawn.
    const bedResult = await adapter.setSpawnAtNearestBed();
    log(bedResult ? 'Spawn point diset di bed dekat base.' : 'Tidak ada bed dalam jangkauan - spawn point tidak diubah.');

    // Patroli keliling base (bukan diam di satu titik) - keluhan nyata: penjaga yang cuma
    // "standby" di satu koordinat jarang sekali ketemu mob, karena hanya bereaksi kalau mob
    // kebetulan masuk ke bubble scanRadius di titik ITU SAJA. Radius 10 blok dari base tetap jauh
    // dari avoidArea (area peternakan villager, ~34 blok dari base ke arah utara).
    const patrolWaypoints = [
      { x: baseGoal.x + 10, y: baseGoal.y, z: baseGoal.z },
      { x: baseGoal.x, y: baseGoal.y, z: baseGoal.z + 10 },
      { x: baseGoal.x - 10, y: baseGoal.y, z: baseGoal.z },
      { x: baseGoal.x, y: baseGoal.y, z: baseGoal.z - 10 }
    ];

    combatEngine = new MobFarmEngine({
      adapter,
      scanRadius,
      patrolWaypoints,
      retreatPosition: baseGoal
    });
    combatEngine.on('attacked', ({ target }) => log(`Menyerang ${target.name || target.type}`));

    repairEngine = new GearRepairEngine({ adapter });
    repairEngine.on('repaired', ({ piece }) => log(`Perbaiki gear: ${piece} dipasang.`));
    repairEngine.on('gathered', ({ item, count }) => log(`Ambil ${count}x ${item} dari gudang untuk craft gear.`));
    cooperativeRuntime = createCooperativeAgent(adapter, {
      capabilities: ['combat', 'patrol', 'survey'],
      metadata: { role: 'guard' },
      handlers: createEngineTaskHandlers(combatEngine, {
        SURVEY_THREATS: { execute: async () => ({ action: 'survey', threats: combatEngine.getThreats().length }) },
        PATROL_AREA: { actions: ['patrol', 'standby'], idleCompletes: true },
        ENGAGE_THREATS: { actions: ['attack', 'approach', 'cooldown'], idleCompletes: true }
      })
    });

    log('Pekerja penjaga mulai berjaga.');
    lastAction = 'GUARDING';
    async function tick() {
      if (stopped) return;
      try {
        const combatResult = cooperativeRuntime
          ? await cooperativeRuntime.runAutonomous(() => combatEngine.tick(), { name: 'REACTIVE_COMBAT', survival: true, stallTimeoutMs: 45000 })
          : await combatEngine.tick();
        if (combatResult?.status) {
          lastAction = `KERNEL_${combatResult.status}`;
          timer = setTimeout(tick, TICK_INTERVAL_MS);
          return;
        }
        lastAction = combatResult.action.toUpperCase();
        // Kalau ada ancaman nyata (bukan cuma standby/idle), tangani itu dulu - jangan buang
        // waktu tick ini untuk crafting saat mob sedang mendekat.
        if (!['idle', 'standby'].includes(combatResult.action)) {
          timer = setTimeout(tick, TICK_INTERVAL_MS);
          return;
        }
        const cooperative = await cooperativeRuntime?.runOnce();
        if (cooperative && cooperative.status !== 'IDLE') {
          lastAction = `TASK_${cooperative.status}`;
          timer = setTimeout(tick, TICK_INTERVAL_MS);
          return;
        }
      } catch (e) {
        log(`ERROR di tick pertahanan (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
      try {
        const repairResult = cooperativeRuntime
          ? await cooperativeRuntime.runAutonomous(() => repairEngine.tick(), { name: 'GEAR_REPAIR' })
          : await repairEngine.tick();
        if (repairResult?.status) {
          lastAction = `KERNEL_${repairResult.status}`;
          timer = setTimeout(tick, TICK_INTERVAL_MS);
          return;
        }
        if (repairResult.action !== 'idle') {
          log(`Tick perbaikan: ${repairResult.action}`);
          lastAction = repairResult.action.toUpperCase();
        }
      } catch (e) {
        log(`ERROR di tick perbaikan gear (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
      timer = setTimeout(tick, TICK_INTERVAL_MS);
    }
    tick();
  });

  bot.on('error', (e) => log(`ERROR: ${e.message}`));
  bot.on('kicked', (r) => log(`DIKICK: ${JSON.stringify(r)}`));
  // Sama seperti runFarmerWorker.js - tanpa ini, handle worker tetap "hidup" di Map dashboard
  // SELAMANYA dengan data basi walau koneksi sungguhan sudah lama putus.
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
      if (!combatEngine) return null;
      return { combat: combatEngine.metrics, repair: repairEngine ? repairEngine.metrics : null };
    },
    getStatus() {
      return {
        role: 'Penjaga',
        position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        health: bot.health ?? null,
        status: lastAction,
        inventory: bot.inventory ? bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) : []
      };
    }
  };
}

module.exports = { startGuardWorker };

if (require.main === module) {
  startGuardWorker({
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    botName: process.env.MC_BOT_NAME || 'GuardWorker',
    scanRadius: Number(process.env.GUARD_SCAN_RADIUS) || 16
  });
}
