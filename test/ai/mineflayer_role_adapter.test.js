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

describe('MineflayerRoleAdapter.getEquippedArmor - baca 4 slot armor bot sekarang', () => {
  it('harus mengembalikan nama item di tiap slot (head/torso/legs/feet), null kalau kosong - slot kosong berarti gear hilang/rusak total (di Minecraft, gear yang durabilitasnya habis LENYAP dari slot, bukan cuma "rusak sebagian") - sinyal paling andal untuk "perlu diganti"', () => {
    const bot = {
      inventory: {
        slots: [
          , , , , , // slot 0-4 tidak dipakai untuk armor
          { name: 'iron_helmet' }, // slot 5 = head
          null, // slot 6 = torso (kosong = rusak/hilang)
          { name: 'iron_leggings' }, // slot 7 = legs
          { name: 'iron_boots' } // slot 8 = feet
        ]
      }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const armor = adapter.getEquippedArmor();

    assert.deepEqual(armor, { head: 'iron_helmet', torso: null, legs: 'iron_leggings', feet: 'iron_boots' });
  });
});

describe('MineflayerRoleAdapter.withdrawFromChest - ambil item dari chest gudang ke inventaris', () => {
  it('harus membuka chest, menarik item yang cocok sejumlah count, lalu menutup chest', async () => {
    const withdrawCalls = [];
    const closeCalls = [];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      blockAt: () => ({ name: 'chest', position: { x: 5, y: 64, z: 5 } }),
      openChest: async () => ({
        containerItems: () => [{ name: 'iron_ingot', type: 42, metadata: 0, count: 20 }],
        withdraw: async (type, metadata, count) => { withdrawCalls.push({ type, metadata, count }); },
        close: () => closeCalls.push(true)
      })
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.withdrawFromChest({ x: 5, y: 64, z: 5 }, ['iron_ingot'], 8);

    assert.equal(withdrawCalls.length, 1);
    assert.equal(withdrawCalls[0].type, 42);
    assert.equal(withdrawCalls[0].count, 8);
    assert.equal(closeCalls.length, 1);
    assert.equal(result.withdrawn, 8);
  });

  it('kalau chest tidak punya item yang cocok, tidak boleh menarik apapun - hasil withdrawn:0', async () => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      blockAt: () => ({ name: 'chest', position: { x: 5, y: 64, z: 5 } }),
      openChest: async () => ({
        containerItems: () => [{ name: 'cobblestone', type: 1, metadata: 0, count: 64 }],
        withdraw: async () => { throw new Error('TIDAK BOLEH dipanggil - tidak ada item yang cocok'); },
        close: () => {}
      })
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.withdrawFromChest({ x: 5, y: 64, z: 5 }, ['iron_ingot'], 8);

    assert.equal(result.withdrawn, 0);
  });
});

describe('MineflayerRoleAdapter.craftItem - buat item lewat crafting table terdekat', () => {
  it('harus mencari crafting_table terdekat, ambil resep pertama yang tersedia, lalu craft sejumlah count', async () => {
    const craftCalls = [];
    const recipe = { result: { name: 'iron_helmet' } };
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      findBlock: () => ({ position: { x: 3, y: 64, z: 3 } }),
      blockAt: () => ({ name: 'crafting_table', position: { x: 3, y: 64, z: 3 } }),
      recipesFor: () => [recipe],
      craft: async (r, count, table) => { craftCalls.push({ recipe: r, count, table }); }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.craftItem('iron_helmet', 1);

    assert.equal(craftCalls.length, 1);
    assert.equal(craftCalls[0].recipe, recipe);
    assert.equal(craftCalls[0].count, 1);
    assert.equal(result, true);
  });

  it('kalau tidak ada crafting_table dalam jangkauan, harus mengembalikan false tanpa error - lebih baik gagal jelas daripada crash', async () => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      findBlock: () => null
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.craftItem('iron_helmet', 1);

    assert.equal(result, false);
  });

  it('kalau tidak ada resep yang bisa dibuat (bahan kurang), harus mengembalikan false tanpa error', async () => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      findBlock: () => ({ position: { x: 3, y: 64, z: 3 } }),
      blockAt: () => ({ name: 'crafting_table', position: { x: 3, y: 64, z: 3 } }),
      recipesFor: () => []
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.craftItem('iron_helmet', 1);

    assert.equal(result, false);
  });
});

describe('MineflayerRoleAdapter.setSpawnAtNearestBed - klik bed terdekat untuk set spawn point sebelum mulai bekerja', () => {
  it('harus mencari bed terdekat, mendekat, lalu klik (activateBlock) - ditemukan dari permintaan nyata pemilik: worker harus klik bed dulu sebelum mulai apapun, supaya kalau proses direstart/logout, bot lanjut dari base (bukan world spawn) - menghindari jalan kaki 300+ blok ulang tiap kali', async () => {
    const activateCalls = [];
    const gotoCalls = [];
    const bedPos = { x: 5, y: 64, z: 5 };
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async (goal) => { gotoCalls.push(goal); } },
      findBlock: ({ matching }) => (matching({ name: 'red_bed' }) ? { position: bedPos, name: 'red_bed' } : null),
      blockAt: () => ({ name: 'red_bed', position: bedPos }),
      activateBlock: async (block) => { activateCalls.push(block); }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.setSpawnAtNearestBed();

    assert.equal(result, true);
    assert.equal(activateCalls.length, 1);
    assert.equal(gotoCalls.length, 1, 'harus mendekat ke bed dulu sebelum klik');
  });

  it('kalau tidak ada bed dalam jangkauan, harus mengembalikan false tanpa error - jangan macet menunggu bed yang tidak ada', async () => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      findBlock: () => null
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.setSpawnAtNearestBed();

    assert.equal(result, false);
  });
});

describe('MineflayerRoleAdapter.attack - harus tulis paket attack LANGSUNG, bukan lewat bot.attack() bawaan yang masih pakai use_entity usang', () => {
  it('harus menulis paket "attack" dengan field entityId, dan tetap mengayun tangan (swingArm) - ditemukan dari crash live nyata: bot.attack() bawaan mineflayer masih memanggil useEntity() internal yang menulis paket use_entity skema LAMA (field "mouse", tanpa "location") - server ini (protokol 775) sebenarnya sudah punya paket "attack" khusus terpisah (cuma field entityId) untuk serangan, use_entity cuma dipakai untuk interact/pakai. Crash ini yang bikin AnimalHusbandryEngine.cull() (dipanggil pekerja tani, bukan cuma penjaga) merusak koneksi dan bot ter-disconnect diam-diam', async () => {
    const writeCalls = [];
    const swingCalls = [];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      lookAt: async () => {},
      attack: () => { throw new Error('bot.attack() bawaan TIDAK BOLEH dipanggil - masih pakai use_entity skema usang'); },
      swingArm: () => { swingCalls.push(true); },
      _client: { write: (name, data) => writeCalls.push({ name, data }) }
    };
    const adapter = new MineflayerRoleAdapter(bot);
    const zombie = { id: 42, position: { x: 2, y: 64, z: 2 } };

    await adapter.attack(zombie);

    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0].name, 'attack');
    assert.equal(writeCalls[0].data.entityId, 42);
    assert.equal(swingCalls.length, 1, 'harus tetap mengayun tangan untuk animasi visual');
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
