/**
 * @file runExplorerWorker.js
 * @description Pekerja penjelajah otonom: menjelajah spiral keluar dari base, menandai tempat
 * penting (peti, mob spawner, lahan farming, sungai, area villager) ke memori landmark bersama
 * (worldLandmarks.js) yang bisa dipakai bot lain. Permintaan nyata pemilik: "mari kita buat bot
 * explorer yang menandai akan mengeksplor map area area dan tempat tempat penting dengan ruang 3d
 * koordinat xyz...jika itu satu titik tulis titiknya, jika area tulis batas batasnya sebagai
 * vektor yang nantinya bisa di interpretasikan". Dibangun di atas mineflayer + mineflayer-
 * pathfinder langsung, sama seperti worker lain.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1.2';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { ExplorerEngine } = require('./explorerEngine');
const { DeepSeekClient } = require('./deepseekClient');
const { walkToBase } = require('./walkToBase');

const TICK_INTERVAL_MS = Number(process.env.EXPLORER_TICK_MS) || 3000;
const DEFAULT_BASE_GOAL = { x: -185, y: 71, z: -352 };

function buildMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  // Sama seperti perbaikan FarmerWorker (lihat commit "Stop pathfinder from routing through
  // guaranteed-damage drops") - explorer menjelajah medan yang BELUM PERNAH dilihat sama sekali,
  // jauh lebih berisiko daripada lahan farming yang sudah dikenal. Parkour dimatikan dan drop
  // maksimal dibatasi 3 blok (jatuh sampai 3 blok tidak kena damage sama sekali di Minecraft).
  movements.allowParkour = false;
  movements.allowSprinting = true;
  movements.maxDropDown = 3;
  movements.scafoldingBlocks = [];
  movements.allow1by1towers = false;
  return movements;
}

function startExplorerWorker({ host, port, botName, scanRadius = 24, spiralStepSize = 8, maxExploreRadius = 64, baseGoal = DEFAULT_BASE_GOAL, log = (m) => console.log(m), onDisconnect = () => {}, onLandmarkFound = () => {} }) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'ExplorerWorker',
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
      log(`PERINGATAN: gagal berjalan ke base (${walkResult.reason}) - mulai menjelajah dari posisi sekarang, bukan dari base.`);
    }
    bot.pathfinder.setMovements(buildMovements(bot));

    const adapter = new MineflayerRoleAdapter(bot);
    const effectiveBase = walkResult.success ? baseGoal : { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };

    // DeepSeek OPSIONAL - kalau tidak ada API key, DeepSeekClient otomatis jatuh ke mode mock
    // (nama landmark pakai template baku, bukan hasil klasifikasi AI) - tetap berfungsi penuh
    // tanpa API key, cuma nama landmarknya kurang deskriptif.
    const llmClient = new DeepSeekClient({ useMock: !process.env.DEEPSEEK_API_KEY });
    if (!process.env.DEEPSEEK_API_KEY) {
      log('PERINGATAN: DEEPSEEK_API_KEY belum diset - nama landmark pakai template baku, bukan hasil klasifikasi AI.');
    }

    engine = new ExplorerEngine({
      adapter,
      basePosition: effectiveBase,
      scanRadius,
      spiralStepSize,
      maxExploreRadius,
      llmClient,
      log
    });

    engine.on('landmarkFound', (landmark) => {
      const label = landmark.shape === 'point'
        ? `(${landmark.position.x},${landmark.position.y},${landmark.position.z})`
        : `${landmark.boundary.length} titik batas`;
      log(`[Explorer] Landmark baru: "${landmark.name}" (${landmark.category}) - ${label}`);
      onLandmarkFound(landmark);
    });

    log('Pekerja penjelajah mulai bekerja.');
    lastAction = 'WORKING';
    async function tick() {
      if (stopped) return;
      try {
        const result = await engine.tick();
        lastAction = result.action.toUpperCase();
        // Log EKSPLISIT untuk mundur/makan - ditemukan dari bug live nyata: bot sempat health
        // 0.5/20 sambil tetap terus menjelajah tanpa henti, tanpa jejak apapun kenapa.
        if (result.action === 'retreat') log(`PERINGATAN: health kritis - mundur ke base.`);
        if (result.action === 'eat') log(`Makan (darurat, food rendah).`);
      } catch (e) {
        log(`ERROR di tick eksplorasi (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
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
      return { explorer: engine.metrics };
    },
    getStatus() {
      return {
        role: 'Penjelajah',
        position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        health: bot.health ?? null,
        status: lastAction,
        inventory: bot.inventory ? bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) : []
      };
    }
  };
}

module.exports = { startExplorerWorker, buildMovements };
