const { describe, it } = require('node:test');
const assert = require('node:assert');
const { walkToBase } = require('../../src/ai/walkToBase');

function fakeBot({ gotoImpl, position } = {}) {
  const setMovementsCalls = [];
  const gotoCalls = [];
  return {
    version: '1.21.1',
    // mineflayer isi bot.registry otomatis saat spawn - Movements butuh registry NYATA (bukan mock),
    // jadi pakai minecraft-data langsung, sama seperti yang sungguhan dipakai mineflayer di balik layar.
    registry: require('minecraft-data')('1.21.1'),
    entity: position ? { position } : undefined,
    pathfinder: {
      setMovements: (m) => setMovementsCalls.push(m),
      goto: async (goal) => {
        gotoCalls.push(goal);
        if (gotoImpl) return gotoImpl(goal);
      },
      thinkTimeout: 5000
    },
    _setMovementsCalls: setMovementsCalls,
    _gotoCalls: gotoCalls
  };
}

describe('walkToBase - navigasi spawn->base memakai mineflayer-pathfinder langsung', () => {
  it('harus memanggil bot.pathfinder.goto dengan GoalNear persis di koordinat & radius base yang diminta', async () => {
    const bot = fakeBot();
    const result = await walkToBase({ bot, goal: { x: -175, y: 71, z: -325 }, range: 2 });
    assert.equal(bot._gotoCalls.length, 1, 'goto harus dipanggil tepat sekali');
    const goal = bot._gotoCalls[0];
    assert.equal(goal.x, -175);
    assert.equal(goal.y, 71);
    assert.equal(goal.z, -325);
    assert.equal(result.success, true, 'harus melaporkan sukses saat goto selesai tanpa error');
  });

  it('harus mengaktifkan movements dengan parkour+sprint+buka pintu diaktifkan, TAPI gali (dig) DIMATIKAN - ditemukan dari uji coba live nyata: base sungguhan berpintu, dan canOpenDoors default mineflayer-pathfinder adalah FALSE, jadi kalau canDig=true tetap menyala, pathfinder mencoba MENGGALI TEMBUS DINDING sebagai alternatif alih-alih membuka pintu - meledakkan ruang pencarian (144 ribu simpul dikunjungi) sampai timeout tepat di depan base, padahal rutenya sebenarnya cuma lewat pintu+tangga biasa', async () => {
    const bot = fakeBot();
    await walkToBase({ bot, goal: { x: 0, y: 64, z: 0 } });
    assert.equal(bot._setMovementsCalls.length, 1, 'setMovements harus dipanggil sekali sebelum goto');
    const movements = bot._setMovementsCalls[0];
    assert.equal(movements.canDig, false);
    assert.equal(movements.canOpenDoors, true);
    assert.equal(movements.allowParkour, true);
    assert.equal(movements.allowSprinting, true);
  });

  it('kalau bot.pathfinder.goto gagal (rute tidak ditemukan/terputus), harus melaporkan gagal dengan alasan - BUKAN melempar exception tak tertangani yang mematikan proses bot', async () => {
    const bot = fakeBot({ gotoImpl: () => { throw new Error('No path to the goal'); } });
    const result = await walkToBase({ bot, goal: { x: 100, y: 64, z: 100 } });
    assert.equal(result.success, false);
    assert.match(result.reason, /No path to the goal/);
  });

  it('harus menolak dengan pesan jelas kalau bot belum punya plugin pathfinder dimuat - lebih baik gagal cepat & jelas daripada crash cryptic di tengah navigasi', async () => {
    const bot = { version: '1.21.1' };
    await assert.rejects(
      () => walkToBase({ bot, goal: { x: 0, y: 64, z: 0 } }),
      /pathfinder/i
    );
  });

  it('harus menunggu settleMs SEBELUM memanggil goto - ditemukan dari bug live nyata: goto dipanggil persis saat spawn/reconnect, sebelum chunk sekitar sempat ter-load penuh, sehingga pathfinder cuma melihat 16 simpul (dunia nyaris kosong dari sudut pandangnya) dan langsung noPath - padahal beberapa saat kemudian chunk_loaded tiba dan dunianya sebenarnya utuh. settleMs kasih waktu chunk streaming menyusul sebelum pencarian rute dimulai', async () => {
    const bot = fakeBot();
    const start = Date.now();
    await walkToBase({ bot, goal: { x: 0, y: 64, z: 0 }, settleMs: 50 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 50, `harus menunggu minimal 50ms sebelum goto, cuma ${elapsed}ms`);
  });

  it('settleMs default HARUS 0 (tidak menunggu) - supaya caller yang sudah tahu dunianya siap (mis. bot yang sudah lama tersambung) tidak dipaksa menunggu tanpa alasan', async () => {
    const bot = fakeBot();
    const start = Date.now();
    await walkToBase({ bot, goal: { x: 0, y: 64, z: 0 } });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `tidak seharusnya menunggu tanpa settleMs eksplisit, malah ${elapsed}ms`);
  });

  it('perjalanan JAUH (bot baru, belum punya bed tersimpan) harus dipecah jadi beberapa lompatan bertahap MENUJU tujuan sebelum goto() akhir - ditemukan dari bug live nyata: ExplorerWorker diam TOTAL 4+ menit mencoba jalan 387 blok sekaligus dari world spawn - pathfinder tidak bisa hitung rute lewat chunk yang belum termuat, dan chunk baru termuat kalau bot mendekat, jadi saling menunggu selamanya (deadlock)', async () => {
    const bot = fakeBot({ position: { x: 0, y: 64, z: 0 } });
    await walkToBase({ bot, goal: { x: 300, y: 71, z: 0 }, range: 2 });

    assert.ok(bot._gotoCalls.length > 1, 'perjalanan 300 blok harus dipecah jadi beberapa lompatan, bukan satu goto raksasa');
    // Lompatan ANTARA (semua kecuali yang terakhir) harus GoalNearXZ - abaikan Y persis, biar
    // pathfinder cari ketinggian tanah sendiri (Y tujuan akhir belum tentu sama dengan Y di
    // tengah perjalanan).
    const intermediateGoals = bot._gotoCalls.slice(0, -1);
    for (const g of intermediateGoals) {
      assert.equal(g.constructor.name, 'GoalNearXZ', 'lompatan antara harus GoalNearXZ, bukan GoalNear (Y di tengah jalan belum tentu sama dengan Y tujuan akhir)');
    }
    // Lompatan TERAKHIR harus tetap GoalNear presisi persis di koordinat tujuan akhir - perilaku
    // lama tidak boleh berubah untuk kedatangan akhirnya.
    const finalGoal = bot._gotoCalls[bot._gotoCalls.length - 1];
    assert.equal(finalGoal.constructor.name, 'GoalNear');
    assert.equal(finalGoal.x, 300);
    assert.equal(finalGoal.z, 0);
  });

  it('perjalanan DEKAT (di bawah ambang lompatan bertahap) TIDAK BOLEH dipecah - langsung satu goto() seperti biasa, sama seperti bot yang sudah punya bed tersimpan dekat base', async () => {
    const bot = fakeBot({ position: { x: 0, y: 64, z: 0 } });
    await walkToBase({ bot, goal: { x: 10, y: 64, z: 10 }, range: 2 });

    assert.equal(bot._gotoCalls.length, 1, 'perjalanan dekat tidak perlu lompatan bertahap sama sekali');
  });

  it('kalau SATU lompatan antara gagal, tetap harus lanjut ke lompatan berikutnya (bukan menyerah total) - jangan biarkan satu rintangan di tengah jalan membatalkan seluruh perjalanan', async () => {
    let callCount = 0;
    const bot = fakeBot({
      position: { x: 0, y: 64, z: 0 },
      gotoImpl: () => {
        callCount++;
        if (callCount === 1) throw new Error('No path to the goal'); // lompatan pertama gagal
      }
    });

    const result = await walkToBase({ bot, goal: { x: 300, y: 71, z: 0 }, range: 2 });

    assert.ok(bot._gotoCalls.length > 1, 'harus tetap mencoba lompatan-lompatan berikutnya walau satu gagal');
    assert.equal(result.success, true, 'kedatangan akhir tetap harus dilaporkan sukses kalau goto() TERAKHIR (tujuan sesungguhnya) berhasil');
  });

  it('goto() yang TIDAK PERNAH resolve/reject (mis. rute terus di-reset berulang-ulang oleh knockback mob, ditemukan dari bug live nyata: "mob farming not hitting" - bot masuk ruangan spawner penuh mob, tiap kena knockback pathfinder menghitung ulang rute dari posisi baru TANPA HENTI, CPU webServer.js terkunci ~100% dan SELURUH server berhenti merespons menit-menitan, MobFarmEngine.tick() bahkan belum sempat mulai karena masih terjebak di walkToBase()) HARUS tetap dibatasi waktu - jangan menggantung selamanya', async () => {
    const neverResolves = () => new Promise(() => {}); // goto() yang menggantung selamanya
    const bot = fakeBot({ gotoImpl: neverResolves });

    const result = await walkToBase({ bot, goal: { x: 0, y: 64, z: 0 }, maxGotoMs: 50 });

    assert.equal(result.success, false, 'harus tetap melaporkan gagal (bukan menggantung) begitu batas waktu terlampaui');
    assert.match(result.reason, /timeout/i);
  });

  it('bot yang belum punya bot.entity.position sama sekali (mis. tes lama/fake sederhana) harus JATUH KE PERILAKU LAMA (satu goto langsung) - jangan sampai fitur baru ini membuat kode yang belum tahu posisi bot menjadi crash', async () => {
    const bot = fakeBot(); // TANPA position sama sekali
    await walkToBase({ bot, goal: { x: 300, y: 71, z: 0 }, range: 2 });

    assert.equal(bot._gotoCalls.length, 1, 'tanpa tahu posisi sekarang, tidak mungkin menghitung lompatan bertahap - langsung satu goto seperti perilaku lama');
  });
});
