const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MineflayerRoleAdapter } = require('../../src/ai/mineflayerRoleAdapter');

function fakeChestWindow(items) {
  return {
    containerItems: () => items,
    close: () => {}
  };
}

function fakeBot({ chestBlocks = [], chestContentsByKey = {} } = {}) {
  const gotoCalls = [];
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: { goto: async (goal) => { gotoCalls.push(goal); } },
    findBlocks: () => chestBlocks.map((c) => c.position),
    blockAt: (pos) => {
      const found = chestBlocks.find((c) => c.position.x === pos.x && c.position.y === pos.y && c.position.z === pos.z);
      return found ? { name: 'chest', position: found.position } : null;
    },
    openChest: async (block) => {
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      return fakeChestWindow(chestContentsByKey[key] || []);
    },
    _gotoCalls: gotoCalls
  };
}

describe('MineflayerRoleAdapter.findMatchingChest - cari chest gudang yang SUDAH berisi jenis item yang sama', () => {
  it('harus mengembalikan posisi chest pertama yang isinya cocok dengan salah satu itemNames', async () => {
    const bot = fakeBot({
      chestBlocks: [
        { position: { x: -181, y: 73, z: -350 } },
        { position: { x: -181, y: 73, z: -349 } }
      ],
      chestContentsByKey: {
        '-181,73,-350': [{ name: 'wheat', count: 10 }],
        '-181,73,-349': [{ name: 'carrot', count: 5 }]
      }
    });
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.findMatchingChest(['carrot']);

    assert.deepEqual(result, { x: -181, y: 73, z: -349 });
  });

  it('harus mengembalikan null kalau tidak ada chest manapun yang isinya cocok', async () => {
    const bot = fakeBot({
      chestBlocks: [{ position: { x: 0, y: 64, z: 0 } }],
      chestContentsByKey: { '0,64,0': [{ name: 'stone', count: 64 }] }
    });
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.findMatchingChest(['potato']);

    assert.equal(result, null);
  });

  it('harus mengembalikan null kalau tidak ada chest sama sekali di sekitar', async () => {
    const bot = fakeBot({ chestBlocks: [] });
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.findMatchingChest(['wheat']);

    assert.equal(result, null);
  });
});

describe('MineflayerRoleAdapter.useOn - harus tulis paket use_entity LANGSUNG dengan skema BARU (field location wajib), bukan lewat fungsi bawaan mineflayer yang belum diperbarui', () => {
  it('harus menulis paket use_entity dengan field target, hand, location (objek x/y/z, BUKAN undefined), dan sneaking - ditemukan dari crash live nyata: skema protokol server ini (775, versi Mojang terbaru) mengganti field lama "mouse" jadi field "location" WAJIB bertipe lpVec3 (objek {x,y,z}, bukan opsional) - baik bot.activateEntity() maupun bot.activateEntityAt() bawaan mineflayer masih kirim skema lama tanpa field location sama sekali, membuat serialisasi gagal ("Cannot read properties of undefined (reading \'x\')") dengan cara yang merusak koneksi sampai bot di-kick server (disconnect.timeout)', async () => {
    const writeCalls = [];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      lookAt: async () => {},
      activateEntity: () => { throw new Error('activateEntity TIDAK BOLEH dipanggil - skema paketnya sudah usang di server ini'); },
      activateEntityAt: () => { throw new Error('activateEntityAt TIDAK BOLEH dipanggil - skema paketnya juga sudah usang di server ini'); },
      _client: { write: (name, data) => writeCalls.push({ name, data }) }
    };
    const adapter = new MineflayerRoleAdapter(bot);
    const cow = { id: 1, position: { x: 5, y: 64, z: 5 } };

    await adapter.useOn(cow);

    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0].name, 'use_entity');
    assert.equal(writeCalls[0].data.target, cow.id);
    assert.ok(writeCalls[0].data.location, 'field location harus berupa objek, bukan undefined - itu penyebab crash aslinya');
    assert.equal(typeof writeCalls[0].data.location.x, 'number');
    assert.equal(typeof writeCalls[0].data.location.y, 'number');
    assert.equal(typeof writeCalls[0].data.location.z, 'number');
    assert.equal(typeof writeCalls[0].data.sneaking, 'boolean');
  });
});

describe('MineflayerRoleAdapter.dig - harus mengambil barang yang jatuh, bukan cuma menggali', () => {
  it('setelah menggali, harus mendekat SAMPAI BENAR-BENAR MENGINJAK posisi blok (range 0) supaya item yang jatuh ke tanah ikut terambil - ditemukan dari kekhawatiran nyata: menggali dari jarak 3 blok (cukup untuk gali) TIDAK cukup dekat untuk memicu pickup otomatis, item bisa tertinggal di tanah', async () => {
    const gotoCalls = [];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async (goal) => { gotoCalls.push(goal); } },
      dig: async () => {}
    };
    const adapter = new MineflayerRoleAdapter(bot);
    const block = { name: 'wheat', position: { x: 5, y: 64, z: 5 } };

    await adapter.dig(block);

    // Panggilan navigasi pertama: mendekat cukup untuk menggali (range longgar).
    // Panggilan navigasi KEDUA (setelah gali): range SANGAT ketat (0) - benar-benar menginjak
    // posisi itemnya supaya pickup otomatis Minecraft terpicu, bukan ditinggalkan di tanah.
    assert.equal(gotoCalls.length, 2, 'harus navigasi dua kali: sebelum gali (jangkauan gali) dan sesudah gali (memungut barang)');
    const pickupGoal = gotoCalls[1];
    assert.equal(pickupGoal.x, 5);
    assert.equal(pickupGoal.z, 5);
  });
});
