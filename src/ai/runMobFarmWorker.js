/**
 * @file runMobFarmWorker.js
 * @description Pekerja pemburu spawner: jalan ke lokasi mob spawner (default zombie), bertarung
 * lawan mob yang muncul untuk rotten_flesh (pakai MobFarmEngine yang sudah ada), lalu jarah chest
 * di sekitar spawner dan antar barang yang sudah dikenal (lewat memori sortir bersama - lihat
 * storageMemory.js) pulang ke gudang. Permintaan nyata pemilik: "buat bot lagi untuk farming
 * rotenflesh di spawner zombie dan disana ada banyak peti barang barang jelek nya bisa kamu
 * hancurkan aku telah menaruh diamond sword ter enchant untuk itu di barel tools di gudang".
 *
 * Sebelum berangkat, ambil diamond_sword (pedang ter-enchant yang pemilik taruh) dari TOOLS_CHEST
 * di gudang - MobFarmEngine SUDAH mengutamakan diamond_sword duluan (lihat weaponNames default di
 * mobFarmEngine.js), jadi begitu pedang ini ada di tas, otomatis dipakai tanpa perlu logika baru.
 *
 * CATATAN JUJUR: "peti jelek nya bisa kamu hancurkan" (pemilik memilih: ambil isinya, buang yang
 * jelek ke lava) - bagian "buang ke lava" BELUM diimplementasikan di sesi ini (butuh kemampuan baru
 * sama sekali: mendeteksi blok lava sungguhan & mendekat dengan aman, belum ada di codebase manapun
 * sampai saat ini). Untuk sekarang, item yang punya rumah DIKENAL (lewat memori sortir bersama)
 * dibawa pulang ke gudang seperti biasa; item yang SAMA SEKALI tidak dikenal dibiarkan di tas
 * (tidak dibuang sembarangan) supaya tidak ada barang hilang tanpa sepengetahuan pemilik.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1.2';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { MobFarmEngine } = require('./mobFarmEngine');
const { walkToBase } = require('./walkToBase');
const { getSharedChestAssignments, parseChestPositionKey, TOOLS_CHEST } = require('./storageMemory');

const TICK_INTERVAL_MS = Number(process.env.MOBFARM_TICK_MS) || 2000;
const DEFAULT_BASE_GOAL = { x: -185, y: 71, z: -352 };
// Koordinat spawner diberikan langsung oleh pemilik ("kamu bisa pukul di -256 , -20, -432 kurang
// lebih di situ") - kata "kurang lebih" ditangani lewat patrolWaypoints kecil di sekitar titik ini
// (bukan diam persis di satu blok) supaya tetap menjangkau ruangan spawner walau koordinat pastinya
// meleset beberapa blok.
const DEFAULT_SPAWNER_GOAL = { x: -256, y: -20, z: -432 };
const DEFAULT_LOOT_SCAN_RADIUS = 16;

function buildMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  movements.scafoldingBlocks = [];
  movements.allow1by1towers = false;
  return movements;
}

function startMobFarmWorker({
  host, port, botName,
  scanRadius = 16,
  baseGoal = DEFAULT_BASE_GOAL,
  spawnerGoal = DEFAULT_SPAWNER_GOAL,
  lootScanRadius = DEFAULT_LOOT_SCAN_RADIUS,
  log = (m) => console.log(m),
  onDisconnect = () => {}
}) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'MobFarmWorker',
    version: SERVER_VERSION,
    auth: 'offline',
    plugins: { time: false }
  });

  let combatEngine = null;
  let adapter = null;
  let sharedChestAssignments = null;
  let stopped = false;
  let timer = null;
  let lastAction = 'CONNECTING';

  bot.once('spawn', async () => {
    bot.loadPlugin(pathfinder);
    bot.pathfinder.setMovements(buildMovements(bot));
    bot.pathfinder.thinkTimeout = 20000;
    log(`Spawn di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) - menunggu chunk sekitar ter-load...`);

    const walkToBaseResult = await walkToBase({ bot, goal: baseGoal, range: 4, settleMs: 5000, log });
    if (!walkToBaseResult.success) {
      log(`PERINGATAN: gagal berjalan ke base (${walkToBaseResult.reason}) - lanjut coba ambil pedang & berangkat ke spawner dari posisi sekarang.`);
    }
    bot.pathfinder.setMovements(buildMovements(bot));

    adapter = new MineflayerRoleAdapter(bot);
    sharedChestAssignments = getSharedChestAssignments(log);

    // Ambil diamond_sword ter-enchant dari TOOLS_CHEST SEBELUM berangkat - permintaan nyata
    // pemilik: "aku telah menaruh diamond sword ter enchant untuk itu di barel tools di gudang".
    if (!adapter.hasItem('diamond_sword')) {
      const toolsPos = parseChestPositionKey(TOOLS_CHEST);
      const result = await adapter.withdrawFromChest(toolsPos, ['diamond_sword'], 1);
      if (result.withdrawn > 0) {
        log('Ambil diamond_sword ter-enchant dari TOOLS_CHEST gudang.');
      } else {
        log('PERINGATAN: diamond_sword tidak ditemukan di TOOLS_CHEST - lanjut dengan senjata seadanya di tas.');
      }
    }

    log(`Berjalan ke spawner (${spawnerGoal.x}, ${spawnerGoal.y}, ${spawnerGoal.z})...`);
    const walkToSpawnerResult = await walkToBase({ bot, goal: spawnerGoal, range: 4, settleMs: 3000, log });
    if (!walkToSpawnerResult.success) {
      log(`PERINGATAN: gagal berjalan ke spawner (${walkToSpawnerResult.reason}) - tetap mulai berburu dari posisi sekarang, mungkin belum sampai.`);
    }
    bot.pathfinder.setMovements(buildMovements(bot));

    // Patroli kecil di sekitar titik spawner (bukan diam di satu blok persis) - koordinat dari
    // pemilik "kurang lebih" pas, patroli ini menjangkau ruangan spawner walau meleset beberapa blok.
    const patrolWaypoints = [
      { x: spawnerGoal.x + 4, y: spawnerGoal.y, z: spawnerGoal.z },
      { x: spawnerGoal.x, y: spawnerGoal.y, z: spawnerGoal.z + 4 },
      { x: spawnerGoal.x - 4, y: spawnerGoal.y, z: spawnerGoal.z },
      { x: spawnerGoal.x, y: spawnerGoal.y, z: spawnerGoal.z - 4 }
    ];

    combatEngine = new MobFarmEngine({
      adapter,
      scanRadius,
      patrolWaypoints,
      // Mundur ke TITIK SPAWNER ITU SENDIRI (bukan base yang 300+ blok jauhnya, tidak realistis
      // untuk mundur darurat) - cukup aman sebagai jeda sesaat sebelum lanjut bertarung lagi.
      retreatPosition: spawnerGoal
    });
    combatEngine.on('attacked', ({ target }) => log(`Menyerang ${target.name || target.type}`));

    log('Pekerja pemburu spawner mulai berburu.');
    lastAction = 'HUNTING';
    let lastLootAttempt = 0;

    async function lootNearbyChests() {
      const chestPositions = adapter.findChestPositions(lootScanRadius);
      let anyLooted = false;
      for (const pos of chestPositions) {
        try {
          const result = await adapter.withdrawAllFromChest(pos);
          if (result.totalCount > 0) {
            anyLooted = true;
            log(`Jarah ${result.totalCount} item dari chest (${pos.x},${pos.y},${pos.z}) dekat spawner.`);
          }
        } catch (e) {
          log(`PERINGATAN: gagal membuka chest (${pos.x},${pos.y},${pos.z}) untuk dijarah (${e.message}) - lewati.`);
        }
      }
      return anyLooted;
    }

    // Antar barang yang SUDAH DIKENAL (lewat memori sortir bersama) pulang ke gudang - item yang
    // TIDAK dikenal SENGAJA dibiarkan di tas (lihat catatan jujur di komentar atas file: fitur
    // "buang ke lava" belum dibangun sesi ini, jadi TIDAK dibuang sembarangan tanpa sepengetahuan
    // pemilik).
    async function deliverKnownItemsHome() {
      const items = adapter.getInventoryItems();
      const distinctNames = [...new Set(items.map((i) => i.name))].filter((n) => n !== 'diamond_sword');
      let delivered = 0;
      for (const name of distinctNames) {
        const sharedKey = sharedChestAssignments?.[name];
        const chestPos = sharedKey ? parseChestPositionKey(sharedKey) : await adapter.findMatchingChest([name]);
        if (!chestPos) continue;
        try {
          const result = await adapter.depositToChest(chestPos, (item) => item.name === name);
          delivered += result.deposited || 0;
        } catch (e) {
          log(`PERINGATAN: gagal antar ${name} pulang ke gudang (${e.message}) - lewati, coba jenis lain.`);
        }
      }
      return delivered;
    }

    async function tick() {
      if (stopped) return;
      try {
        const combatResult = await combatEngine.tick();
        lastAction = combatResult.action.toUpperCase();
        if (!['idle', 'standby'].includes(combatResult.action)) {
          timer = setTimeout(tick, TICK_INTERVAL_MS);
          return;
        }
      } catch (e) {
        log(`ERROR di tick pertarungan (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }

      // Cuma jarah/antar kalau memang sedang idle (tidak ada ancaman) - jangan buang waktu
      // membuka chest saat mob sedang mendekat.
      try {
        const now = Date.now();
        if (now - lastLootAttempt > 15000) {
          lastLootAttempt = now;
          const looted = await lootNearbyChests();
          if (looted) lastAction = 'LOOTING';
        }
        const delivered = await deliverKnownItemsHome();
        if (delivered > 0) {
          log(`Antar ${delivered} item yang sudah dikenal pulang ke gudang.`);
          lastAction = 'DELIVER';
        }
      } catch (e) {
        log(`ERROR di tick jarah/antar (non-fatal, lanjut tick berikutnya): ${e.message}`);
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
      if (!combatEngine) return null;
      return { combat: combatEngine.metrics };
    },
    getStatus() {
      return {
        role: 'Pemburu Spawner',
        position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        health: bot.health ?? null,
        status: lastAction,
        inventory: bot.inventory ? bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) : []
      };
    }
  };
}

module.exports = { startMobFarmWorker, buildMovements };

if (require.main === module) {
  startMobFarmWorker({
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    botName: process.env.MC_BOT_NAME || 'MobFarmWorker'
  });
}
