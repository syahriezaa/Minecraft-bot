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

function distanceXZ(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function buildMovements(bot) {
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
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allow1by1towers = true;
  movements.allowSprinting = true;
  movements.allowParkour = true;
  movements.maxDropDown = 4;
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
async function walkToBase({ bot, goal, range = 2, settleMs = 0, log = () => {} }) {
  if (!bot?.pathfinder) {
    throw new Error('Bot belum punya plugin pathfinder dimuat - panggil bot.loadPlugin(pathfinder) dulu.');
  }
  if (settleMs > 0) {
    log(`Menunggu ${settleMs}ms supaya chunk sekitar sempat ter-load penuh sebelum mencari rute...`);
    await new Promise((r) => setTimeout(r, settleMs));
  }
  bot.pathfinder.setMovements(buildMovements(bot));
  bot.pathfinder.thinkTimeout = 30000; // server lambat butuh waktu berpikir lebih lama dari default 5 detik

  // Perjalanan JAUH dipecah jadi beberapa lompatan bertahap MENUJU tujuan dulu (lihat komentar
  // STAGE_DISTANCE) - pakai GoalNearXZ (abaikan Y persis, biar pathfinder cari ketinggian tanah
  // sendiri di titik antara, yang belum tentu sama dengan Y tujuan akhir). Kalau posisi bot
  // sekarang tidak diketahui (mis. caller lama yang belum menyediakan bot.entity.position), tidak
  // mungkin menghitung lompatan - langsung ke goto() akhir seperti perilaku lama.
  const currentPos = bot.entity?.position;
  if (currentPos && typeof currentPos.x === 'number') {
    const totalDist = distanceXZ(currentPos, goal);
    if (totalDist > STAGE_DISTANCE) {
      const stageCount = Math.ceil(totalDist / STAGE_DISTANCE);
      for (let i = 1; i < stageCount; i++) {
        const t = i / stageCount;
        const hopX = currentPos.x + (goal.x - currentPos.x) * t;
        const hopZ = currentPos.z + (goal.z - currentPos.z) * t;
        log(`Menuju titik antara (${hopX.toFixed(0)}, ~, ${hopZ.toFixed(0)}) - tahap ${i}/${stageCount - 1} sebelum ke base...`);
        try {
          await bot.pathfinder.goto(new GoalNearXZ(hopX, hopZ, 8));
        } catch (e) {
          log(`Tahap ${i} gagal (${e.message}) - lanjut coba tahap berikutnya.`);
        }
      }
    }
  }

  log(`Berjalan ke base (${goal.x}, ${goal.y}, ${goal.z})...`);
  try {
    await bot.pathfinder.goto(new GoalNear(goal.x, goal.y, goal.z, range));
    log('Sampai di base.');
    return { success: true };
  } catch (e) {
    log(`Gagal mencapai base: ${e.message}`);
    return { success: false, reason: e.message };
  }
}

module.exports = { walkToBase, buildMovements };

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
