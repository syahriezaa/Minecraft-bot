/**
 * @file walkToBase.js
 * @description Navigasi spawn->base memakai mineflayer-pathfinder LANGSUNG - gantinya untuk
 * pipeline lama (runWalkToBaseBot.js: physicsController + A* voxel kustom + connectivityGraph +
 * wall-follow/escape heuristics, 700+ baris). Pipeline lama sudah ditambal berkali-kali sepanjang
 * proyek ini (freefall recovery, stall detection, escape search, frontier push, chunk-refresh
 * reconnect) dan TETAP tidak bisa diandalkan menyelesaikan rute spawn->base - tanda arsitektur yang
 * salah, bukan sekadar bug yang perlu ditambal lagi. mineflayer-pathfinder sudah teruji luas untuk
 * tepat masalah ini (A* di atas dunia yang sudah dimuat bot, lengkap dengan dig/parkour/sprint),
 * jadi tidak perlu membangun ulang A* sendiri di atasnya.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { goals: { GoalNear, GoalNearXZ } } = require('mineflayer-pathfinder');

// Jarak maksimal per lompatan sebelum perjalanan dipecah bertahap - ditemukan dari bug live
// nyata: ExplorerWorker (bot BARU, belum punya bed tersimpan) diam TOTAL tidak bergerak sama
// sekali selama 4+ menit mencoba jalan 387 blok sekaligus dari world spawn ke base. Pathfinder
// tidak bisa menghitung rute lewat chunk yang belum termuat, dan chunk BARU termuat kalau bot
// mendekat - keduanya saling menunggu selamanya (deadlock). Bot yang SUDAH punya bed tersimpan
// dekat base (Farmer/StorageWorker setelah sesi pertama) tidak pernah kena ini karena jaraknya
// sudah pendek dari awal.
const STAGE_DISTANCE = 64;

// Dipakai hanya untuk bootstrap/evakuasi perjalanan jauh. Blok bangunan, container,
// workstation, kaca, dan mekanisme redstone sengaja tidak masuk daftar sehingga bot tidak
// mengubah base ketika harus menggali keluar dari spawn yang berada di bawah tanah.
const SAFE_TRAVEL_TERRAIN_NAMES = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'sand', 'red_sand', 'gravel', 'clay', 'mud', 'snow', 'snow_block',
  'stone', 'cobblestone', 'deepslate', 'tuff', 'granite', 'diorite', 'andesite',
  'calcite', 'dripstone_block', 'pointed_dripstone', 'netherrack', 'soul_sand',
  'soul_soil', 'basalt', 'blackstone'
]);

function distanceXZ(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function buildMovements(bot, { allowTerrainWork = false, allow1by1Towers = true, allowParkour = true, allowSprinting = true, scaffoldingBlocks = [], maxDropDown = 4, terrainBreakAllowlist = null } = {}) {
  // mineflayer-pathfinder@2.x baca registry blok LANGSUNG dari bot.registry (diisi otomatis oleh
  // mineflayer sendiri saat spawn) - Movements cuma butuh satu argumen `bot`, bukan `(bot, mcData)`
  // terpisah seperti versi lama.
  const Movements = require('mineflayer-pathfinder').Movements;
  const movements = new Movements(bot);
  // Uji coba live nyata (spawn->base, 350+ blok): base sungguhan berpintu, canOpenDoors DEFAULT
  // mineflayer-pathfinder adalah false - kalau canDig tetap menyala, pathfinder menganggap MENGGALI
  // TEMBUS DINDING sebagai alternatif yang valid ke pintu tertutup, meledakkan ruang pencarian
  // (144 ribu simpul dikunjungi sampai timeout) tepat di depan base padahal rutenya cuma lewat
  // pintu+tangga biasa. Base yang sah tidak butuh digali untuk dimasuki - matikan dig, nyalakan
  // buka pintu.
  movements.canDig = allowTerrainWork;
  movements.canOpenDoors = true;
  movements.allow1by1towers = allow1by1Towers;
  movements.scafoldingBlocks = scaffoldingBlocks;
  movements.allowSprinting = allowSprinting;
  movements.allowParkour = allowParkour;
  movements.maxDropDown = maxDropDown;
  if (allowTerrainWork && terrainBreakAllowlist) {
    const allowed = terrainBreakAllowlist instanceof Set ? terrainBreakAllowlist : new Set(terrainBreakAllowlist);
    movements.exclusionAreasBreak.push(block => allowed.has(block?.name) ? 0 : 100);
  }
  return movements;
}

/**
 * @param {object} options
 * @param {object} options.bot - Instance mineflayer bot dengan plugin pathfinder sudah dimuat.
 * @param {{x:number,y:number,z:number}} options.goal
 * @param {number} [options.range=2]
 * @param {number} [options.settleMs=0] - Jeda sebelum mulai goto - dibutuhkan tepat setelah
 *   spawn/reconnect, sebelum chunk sekitar sempat ter-load penuh (lihat komentar bug di test).
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{success:boolean, reason?:string}>}
 */
// Batas waktu KERAS untuk SATU panggilan goto() - ditemukan dari bug live nyata: "mob farming not
// hitting". Bot masuk ruangan mob spawner penuh zombie, tiap kena knockback pathfinder menghitung
// ULANG rute dari posisi barunya TANPA HENTI (path_reset berulang-ulang) - goto() jadi tidak pernah
// resolve MAUPUN reject, CPU webServer.js terkunci ~100% dan SELURUH server (termasuk tick semua
// bot lain) berhenti merespons menit-menitan, sementara MobFarmEngine.tick() sendiri belum sempat
// mulai sama sekali karena masih terjebak di walkToBase() ini. bot.pathfinder.thinkTimeout cuma
// membatasi SATU kali pencarian A*, bukan jumlah total pengulangan pencarian - perlu batas terpisah
// di luar goto() itu sendiri.
const DEFAULT_MAX_GOTO_MS = 45000;

async function walkToBase({ bot, goal, range = 2, settleMs = 0, maxGotoMs = DEFAULT_MAX_GOTO_MS, thinkTimeoutMs = 30000, minimumY = null, allowTerrainWork = false, allow1by1Towers = true, allowParkour = true, allowSprinting = true, scaffoldingBlocks = [], maxDropDown = 4, terrainBreakAllowlist = null, fallbackGoalYOffsets = [], stageDistance = STAGE_DISTANCE, goalXZOnly = false, sharedRoute = false, shouldStop = () => false, log = () => {} }) {
  if (!bot?.pathfinder) {
    throw new Error('Bot belum punya plugin pathfinder dimuat - panggil bot.loadPlugin(pathfinder) dulu.');
  }
  async function gotoWithTimeout(goalObj) {
    if (shouldStop()) throw new Error('Perjalanan dibatalkan karena worker dihentikan');
    if (bot._client?.ended || bot._client?.socket?.destroyed) throw new Error('Koneksi Minecraft sudah terputus');
    let timeoutHandle;
    let navigation;
    let timedOut = false;
    const previousSharedRoute = bot.pathfinder.allowSharedRoute;
    if (sharedRoute) bot.pathfinder.allowSharedRoute = true;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error(`goto timeout setelah ${maxGotoMs}ms - kemungkinan rute terus di-reset (mis. knockback berulang dari mob)`));
      }, maxGotoMs);
    });
    try {
      navigation = bot.pathfinder.goto(goalObj);
      await Promise.race([navigation, timeout]);
      const position = bot.entity?.position;
      if (position && Number.isFinite(goalObj.rangeSq)) {
        const dx = position.x - goalObj.x;
        const dz = position.z - goalObj.z;
        const dy = typeof goalObj.y === 'number' ? position.y - goalObj.y : 0;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        // Entity berada di tengah blok, sedangkan GoalNear menghitung radius terhadap posisi
        // navigasi blok. Beri toleransi satu blok agar kedatangan di tepi radius tidak salah
        // dianggap false-success (mis. jarak aktual 4.54 untuk goal radius 4), tetapi tetap
        // menolak goto() yang benar-benar selesai tanpa memindahkan bot.
        const acceptedDistance = Math.sqrt(goalObj.rangeSq) + 1;
        if (distanceSq > acceptedDistance * acceptedDistance) {
          throw new Error(`pathfinder melaporkan selesai tetapi posisi belum dekat tujuan (jarak2=${distanceSq.toFixed(1)}, batas2=${goalObj.rangeSq})`);
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      // Promise.race tidak menghentikan goto() yang masih menghitung ulang rute.
      // Jika langsung memulai target berikutnya, promise lama dapat memanggil
      // setGoal(null) terlambat dan membatalkan target baru ("goal was changed").
      if (timedOut && navigation) {
        bot.pathfinder.setGoal?.(null);
        await Promise.race([
          Promise.resolve(navigation).catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
      }
      bot.pathfinder.setGoal?.(null);
      bot.pathfinder.allowSharedRoute = previousSharedRoute;
    }
  }
  async function gotoWithRetry(goalObj, attempts = 4) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (shouldStop()) throw new Error('Perjalanan dibatalkan karena worker dihentikan');
      try { return await gotoWithTimeout(goalObj); }
      catch (error) {
        const queued = /RESOURCE_RESERVED|DEADLOCK_REPLAN/.test(error.message || '');
        if (!queued || attempt === attempts) throw error;
        log(`Jalur sedang dipakai bot lain; antre ${attempt}/${attempts - 1} sebelum hitung ulang...`);
        await new Promise(resolve => setTimeout(resolve, 750 * attempt));
      }
    }
  }
  if (settleMs > 0) {
    if (shouldStop()) return { success: false, reason: 'worker dihentikan sebelum perjalanan dimulai' };
    log(`Menunggu ${settleMs}ms supaya chunk sekitar sempat ter-load penuh sebelum mencari rute...`);
    await new Promise((r) => setTimeout(r, settleMs));
    if (shouldStop()) return { success: false, reason: 'worker dihentikan saat menunggu chunk' };
  }
  const movements = buildMovements(bot, { allowTerrainWork, allow1by1Towers, allowParkour, allowSprinting, scaffoldingBlocks, maxDropDown, terrainBreakAllowlist });
  if (Number.isFinite(minimumY)) {
    movements.exclusionAreasStep.push(block => block?.position && block.position.y < minimumY ? 100 : 0);
    movements.allow1by1towers = false;
  }
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = Math.max(1000, Number(thinkTimeoutMs) || 30000);

  // Perjalanan JAUH dipecah jadi beberapa lompatan bertahap MENUJU tujuan dulu (lihat komentar
  // STAGE_DISTANCE) - pakai GoalNearXZ (abaikan Y persis, biar pathfinder cari ketinggian tanah
  // sendiri di titik antara, yang belum tentu sama dengan Y tujuan akhir). Kalau posisi bot
  // sekarang tidak diketahui (mis. caller lama yang belum menyediakan bot.entity.position), tidak
  // mungkin menghitung lompatan - langsung ke goto() akhir seperti perilaku lama.
  const currentPos = bot.entity?.position;
  if (currentPos && typeof currentPos.x === 'number') {
    let cursor = { x: currentPos.x, y: currentPos.y, z: currentPos.z };
    const hopDistance = Number.isFinite(stageDistance) && stageDistance > 0 ? stageDistance : STAGE_DISTANCE;
    const initialDistance = distanceXZ(cursor, goal);
    let stage = 0;
    let stalledStages = 0;
    let lastActual = { x: cursor.x, z: cursor.z };
    while (distanceXZ(cursor, goal) > hopDistance) {
      if (shouldStop()) return { success: false, reason: 'worker dihentikan saat perjalanan bertahap' };
      stage += 1;
      const remaining = distanceXZ(cursor, goal);
      const ratio = hopDistance / remaining;
      const hopX = cursor.x + (goal.x - cursor.x) * ratio;
      const hopZ = cursor.z + (goal.z - cursor.z) * ratio;
      log(`Menuju titik antara (${hopX.toFixed(0)}, ~, ${hopZ.toFixed(0)}) - tahap ${stage} (sisa awal ${initialDistance.toFixed(0)} blok)...`);
      try {
        await gotoWithRetry(new GoalNearXZ(hopX, hopZ, 8));
      } catch (e) {
        log(`Tahap ${stage} gagal (${e.message}) - lanjut coba tahap berikutnya.`);
      }
      const actual = bot.entity?.position;
      const hasActual = actual && Number.isFinite(actual.x) && Number.isFinite(actual.z);
      const moved = hasActual ? distanceXZ(lastActual, actual) : 0;
      const remainingAfter = hasActual ? distanceXZ(actual, goal) : Infinity;
      const remainingBefore = distanceXZ(cursor, goal);
      // Jangan memajukan cursor ke titik rencana ketika server tidak pernah memindahkan
      // entity. Itu hanya membuat worker mengulang rute palsu tanpa batas dan mengunci CPU.
      // Tiga kegagalan berturut-turut masih memberi kesempatan chunk/pathfinder pulih, setelah
      // itu caller mendapat alasan yang bisa ditangani (retry/reconnect), bukan loop panas.
      if (!hasActual || moved < 1 || remainingAfter >= remainingBefore - 1) {
        stalledStages += 1;
        cursor = hasActual ? { x: actual.x, y: actual.y, z: actual.z } : cursor;
        if (stalledStages >= 3) {
          const reason = `NAVIGATION_STALLED setelah ${stalledStages} tahap tanpa kemajuan posisi`;
          log(`Perjalanan dihentikan: ${reason}.`);
          return { success: false, reason };
        }
      } else {
        stalledStages = 0;
        cursor = { x: actual.x, y: actual.y, z: actual.z };
      }
      if (hasActual) lastActual = { x: actual.x, z: actual.z };
    }
  }

  log(`Berjalan ke base (${goal.x}, ${goal.y}, ${goal.z})...`);
  try {
    await gotoWithRetry(goalXZOnly ? new GoalNearXZ(goal.x, goal.z, range) : new GoalNear(goal.x, goal.y, goal.z, range));
    log('Sampai di base.');
    return { success: true };
  } catch (e) {
    const offsets = [...new Set((Array.isArray(fallbackGoalYOffsets) ? fallbackGoalYOffsets : [])
      .filter(offset => Number.isInteger(offset) && offset !== 0))];
    for (const offset of offsets) {
      if (shouldStop()) return { success: false, reason: 'worker dihentikan sebelum landing cadangan' };
      const fallbackY = goal.y + offset;
      if (!Number.isFinite(fallbackY)) continue;
      try {
        log(`Rute presisi gagal; mencoba landing level base Y${fallbackY} (${offset > 0 ? '+' : ''}${offset})...`);
        await gotoWithRetry(new GoalNear(goal.x, fallbackY, goal.z, range));
        const position = bot.entity?.position;
        const dx = (position?.x ?? Infinity) - goal.x;
        const dy = (position?.y ?? Infinity) - goal.y;
        const dz = (position?.z ?? Infinity) - goal.z;
        const acceptedDistance = range + 1;
        if (Math.hypot(dx, dy, dz) <= acceptedDistance) {
          log(`Sampai di landing level aman dekat base (jarak ${Math.hypot(dx, dy, dz).toFixed(1)}).`);
          return { success: true, fallback: true, landingY: Math.floor(position.y) };
        }
      } catch (fallbackError) {
        log(`Landing level Y${fallbackY} gagal: ${fallbackError.message}`);
      }
    }
    log(`Gagal mencapai base: ${e.message}`);
    return { success: false, reason: e.message };
  }
}

module.exports = { walkToBase, buildMovements, SAFE_TRAVEL_TERRAIN_NAMES };

if (require.main === module) {
  // HARUS di-require sebelum 'mineflayer' - lihat mineflayerVersionPatch.js untuk alasan lengkap
  // (server nyata proyek ini di versi 26.1.2, lebih baru dari whitelist internal mineflayer 4.37.1).
  const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
  const SERVER_VERSION = process.env.MC_VERSION || '26.1.2';
  patchMineflayerVersionGate(SERVER_VERSION);

  const mineflayer = require('mineflayer');
  const { pathfinder } = require('mineflayer-pathfinder');

  const goalArg = process.argv[2];
  // -175,71,-325 (default lama) ternyata mengarah ke area peternakan villager, BUKAN base
  // sungguhan - base/bed pemain yang benar ada di -185,71,-352 (dikoreksi langsung oleh pemilik).
  const [gx, gy, gz] = (goalArg || '-185,71,-352').split(',').map(Number);

  const bot = mineflayer.createBot({
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    username: process.env.MC_BOT_NAME || 'AutoCompanionBot',
    version: SERVER_VERSION,
    auth: 'offline',
    // Plugin 'time' bawaan mineflayer crash di server ini - format paket update_time berubah di
    // protokol 775 (field long yang diharapkan array [hi,lo] datang undefined). Tidak esensial untuk
    // navigasi/companion bot, jadi dimatikan saja daripada menambal internal paket protodef.
    plugins: { time: false }
  });

  // Pantau pergerakan tiap tick (throttle biar tidak membanjiri terminal) - dipakai memverifikasi
  // LANGSUNG bahwa bot benar-benar bergerak posisi per posisi menuju base, bukan cuma "goto()
  // dipanggil lalu diam".
  let lastMoveLogAt = 0;
  bot.on('move', () => {
    const now = Date.now();
    if (now - lastMoveLogAt < 1000) return;
    lastMoveLogAt = now;
    const p = bot.entity.position;
    console.log(`  [posisi] (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) | health=${bot.health} food=${bot.food}`);
  });

  bot.once('spawn', async () => {
    bot.loadPlugin(pathfinder);
    console.log(`Versi server terdeteksi: ${bot.version}`);
    console.log(`Spawn di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);

    bot.on('path_update', (r) => {
      console.log(`  [pathfinder] status=${r.status} visitedNodes=${r.visitedNodes} generatedNodes=${r.generatedNodes} panjangJalur=${r.path.length}`);
    });
    bot.on('goal_reached', () => console.log('  [pathfinder] goal_reached'));
    bot.on('path_reset', (reason) => console.log(`  [pathfinder] path_reset: ${reason}`));

    const result = await walkToBase({
      bot,
      goal: { x: gx, y: gy, z: gz },
      settleMs: 5000,
      log: (msg) => console.log(msg)
    });
    console.log(result.success ? 'BERHASIL sampai base.' : `GAGAL: ${result.reason}`);
    bot.quit();
    process.exit(result.success ? 0 : 1);
  });

  bot.on('error', (e) => console.error('ERROR:', e.message));
  bot.on('kicked', (reason) => console.error('DIKICK:', reason));
}
