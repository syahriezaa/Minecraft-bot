const { describe, it } = require('node:test');
const assert = require('node:assert');
const { walkToBase } = require('../../src/ai/walkToBase');

function fakeBot({ gotoImpl } = {}) {
  const setMovementsCalls = [];
  const gotoCalls = [];
  return {
    version: '1.21.1',
    // mineflayer isi bot.registry otomatis saat spawn - Movements butuh registry NYATA (bukan mock),
    // jadi pakai minecraft-data langsung, sama seperti yang sungguhan dipakai mineflayer di balik layar.
    registry: require('minecraft-data')('1.21.1'),
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
});
