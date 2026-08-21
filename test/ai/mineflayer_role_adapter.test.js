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

  it('kalau klik bed di malam hari BENAR-BENAR membuat bot tidur (bot.isSleeping jadi true), harus LANGSUNG bangun lagi - klik bed di sini cuma untuk set titik spawn, BUKAN untuk benar-benar tidur (bisa membuat bot terjebak diam di ranjang tanpa batas waktu). Harus tulis paket entity_action LANGSUNG dengan actionId:0 ("leave_bed") - ditemukan dari bug nyata: bot.wake() bawaan mineflayer masih kirim actionId:2, padahal di skema protokol server ini actionId:2 artinya "stop_sprinting", BUKAN "leave_bed" (yang benar actionId:0) - bot yang terlanjur tidur tidak akan pernah bangun lagi kalau pakai bot.wake() bawaan', async () => {
    const writeCalls = [];
    const bedPos = { x: 5, y: 64, z: 5 };
    const bot = {
      entity: { id: 99, position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      findBlock: () => ({ position: bedPos, name: 'red_bed' }),
      blockAt: () => ({ name: 'red_bed', position: bedPos }),
      activateBlock: async () => { bot.isSleeping = true; }, // server memutuskan bot jadi tidur (malam hari)
      isSleeping: false,
      wake: () => { throw new Error('bot.wake() bawaan TIDAK BOLEH dipanggil - actionId-nya salah di protokol ini'); },
      _client: { write: (name, data) => writeCalls.push({ name, data }) }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    await adapter.setSpawnAtNearestBed();

    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0].name, 'entity_action');
    assert.equal(writeCalls[0].data.entityId, 99);
    assert.equal(writeCalls[0].data.actionId, 0, 'actionId 0 = leave_bed di protokol ini, BUKAN 2');
  });

  it('kalau klik bed TIDAK membuat bot tidur (siang hari, wajar - hanya set titik spawn), TIDAK BOLEH menulis paket entity_action sama sekali', async () => {
    const writeCalls = [];
    const bedPos = { x: 5, y: 64, z: 5 };
    const bot = {
      entity: { id: 99, position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      findBlock: () => ({ position: bedPos, name: 'red_bed' }),
      blockAt: () => ({ name: 'red_bed', position: bedPos }),
      activateBlock: async () => {}, // tidak ada perubahan isSleeping
      isSleeping: false,
      _client: { write: (name, data) => writeCalls.push({ name, data }) }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    await adapter.setSpawnAtNearestBed();

    assert.equal(writeCalls.length, 0);
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

describe('MineflayerRoleAdapter.depositToChest - dukung batas maksimum per jenis item (sisakan cadangan)', () => {
  function fakeChestForDeposit() {
    const depositCalls = [];
    return {
      window: {
        containerItems: () => [],
        deposit: async (type, metadata, count) => { depositCalls.push({ type, metadata, count }); },
        close: () => {}
      },
      depositCalls
    };
  }

  it('tanpa maxPerItem, harus menyetor SELURUH jumlah stack seperti biasa (kompatibel mundur)', async () => {
    const { window, depositCalls } = fakeChestForDeposit();
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      blockAt: () => ({ name: 'chest', position: { x: 1, y: 64, z: 1 } }),
      openChest: async () => window,
      inventory: { items: () => [{ name: 'wheat', type: 5, count: 10 }] }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.depositToChest({ x: 1, y: 64, z: 1 }, () => true);

    assert.equal(depositCalls[0].count, 10);
    assert.equal(result.deposited, 10);
  });

  it('dengan maxPerItem diset untuk suatu nama item, HANYA setor sisa DI ATAS batas itu - sisakan cadangan di inventaris untuk ditanam lagi nanti, ditemukan dari permintaan nyata pemilik: jangan setor semua benih ke gudang sebelum kebun benar-benar selesai ditanami, nanti kehabisan benih untuk tanam berikutnya', async () => {
    const { window, depositCalls } = fakeChestForDeposit();
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      blockAt: () => ({ name: 'chest', position: { x: 1, y: 64, z: 1 } }),
      openChest: async () => window,
      inventory: { items: () => [{ name: 'carrot', type: 7, count: 20 }] }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.depositToChest({ x: 1, y: 64, z: 1 }, () => true, { carrot: 8 });

    assert.equal(depositCalls.length, 1);
    assert.equal(depositCalls[0].count, 12, 'harus setor 20-8=12, sisakan 8 sebagai cadangan benih');
    assert.equal(result.deposited, 12);
  });

  it('kalau jumlah item TIDAK melebihi cadangan di maxPerItem, TIDAK BOLEH menyetor sama sekali item itu', async () => {
    const { window, depositCalls } = fakeChestForDeposit();
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      blockAt: () => ({ name: 'chest', position: { x: 1, y: 64, z: 1 } }),
      openChest: async () => window,
      inventory: { items: () => [{ name: 'potato', type: 9, count: 5 }] }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.depositToChest({ x: 1, y: 64, z: 1 }, () => true, { potato: 8 });

    assert.equal(depositCalls.length, 0);
    assert.equal(result.deposited, 0);
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

describe('MineflayerRoleAdapter.findChestPositions - daftar mentah semua posisi chest di sekitar, tanpa filter isi - dipakai StorageManagerEngine untuk membedakan chest DI DALAM vs DI LUAR rumah (isi diperiksa belakangan oleh engine, bukan oleh adapter)', () => {
  it('harus mengembalikan semua posisi chest dalam jangkauan tanpa membuka satupun (murni geometri blok, bukan isi)', () => {
    const bot = fakeBot({
      chestBlocks: [
        { position: { x: -181, y: 73, z: -350 } },
        { position: { x: 10, y: 64, z: 10 } }
      ]
    });
    const adapter = new MineflayerRoleAdapter(bot);

    const positions = adapter.findChestPositions();

    assert.deepEqual(positions, [
      { x: -181, y: 73, z: -350 },
      { x: 10, y: 64, z: 10 }
    ]);
  });

  it('harus mengembalikan array kosong kalau tidak ada chest sama sekali', () => {
    const bot = fakeBot({ chestBlocks: [] });
    const adapter = new MineflayerRoleAdapter(bot);

    assert.deepEqual(adapter.findChestPositions(), []);
  });
});

describe('MineflayerRoleAdapter.getChestContents - buka satu chest, baca isinya, tutup lagi - dipakai StorageManagerEngine untuk audit "buka semua chest dan cek barang" saat merapikan gudang', () => {
  it('harus membuka chest, mengembalikan daftar item di dalamnya, lalu menutup chest itu lagi', async () => {
    const closeCalls = [];
    const bot = fakeBot({
      chestBlocks: [{ position: { x: -181, y: 73, z: -350 } }],
      chestContentsByKey: { '-181,73,-350': [{ name: 'iron_ingot', count: 4 }, { name: 'stone', count: 64 }] }
    });
    const originalOpenChest = bot.openChest;
    bot.openChest = async (block) => {
      const chest = await originalOpenChest(block);
      const originalClose = chest.close;
      chest.close = () => { closeCalls.push(true); originalClose(); };
      return chest;
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const items = await adapter.getChestContents({ x: -181, y: 73, z: -350 });

    assert.deepEqual(items, [{ name: 'iron_ingot', count: 4 }, { name: 'stone', count: 64 }]);
    assert.equal(closeCalls.length, 1, 'chest harus ditutup lagi setelah dibaca - jangan tinggalkan window terbuka');
  });

  it('harus mengembalikan array kosong kalau chest tidak bisa dibuka (mis. bukan blok chest di posisi itu)', async () => {
    const bot = fakeBot({ chestBlocks: [] });
    const adapter = new MineflayerRoleAdapter(bot);

    const items = await adapter.getChestContents({ x: 0, y: 64, z: 0 });

    assert.deepEqual(items, []);
  });

  it('harus AMBIL 1 item lalu TARUH lagi (round-trip nyata, bukan cuma tunggu pasif) untuk memastikan data yang dicocokkan benar-benar sudah ter-update - permintaan nyata pemilik: "dia harus mengambil mengupdate dan pastikan isinya berubah lalu menaruh lagi lalu tunggu hingga ter update" - dipakai supaya item salah tempat yang sebelumnya luput (data belum sinkron) sekarang benar-benar terdeteksi', async () => {
    let liveItems = [{ name: 'ink_sac', type: 77, metadata: null, count: 3 }, { name: 'wheat_seeds', type: 12, metadata: null, count: 5 }];
    const calls = [];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      inventory: { items: () => [{ name: 'stone', count: 1 }] }, // 1 slot terpakai, banyak slot kosong
      blockAt: () => ({ name: 'chest', position: { x: 5, y: 64, z: 5 } }),
      openChest: async () => ({
        containerItems: () => liveItems,
        withdraw: async (type, metadata, count) => {
          calls.push({ action: 'withdraw', type, metadata, count });
          liveItems = liveItems.map((it) => (it.type === type ? { ...it, count: it.count - count } : it)).filter((it) => it.count > 0);
        },
        deposit: async (type, metadata, count) => {
          calls.push({ action: 'deposit', type, metadata, count });
          const existing = liveItems.find((it) => it.type === type);
          if (existing) existing.count += count;
          else liveItems.push({ name: 'ink_sac', type, metadata, count });
        },
        close: () => {}
      })
    };
    const logMessages = [];
    const adapter = new MineflayerRoleAdapter(bot, { chestSettleMs: 5, log: (msg) => logMessages.push(msg) });

    const items = await adapter.getChestContents({ x: 5, y: 64, z: 5 });

    assert.equal(calls.length, 2, 'harus persis 1x withdraw lalu 1x deposit sebagai verifikasi round-trip');
    assert.equal(calls[0].action, 'withdraw');
    assert.equal(calls[0].count, 1, 'cuma ambil 1 biji sebagai probe, bukan seluruh stack');
    assert.equal(calls[1].action, 'deposit');
    assert.equal(calls[1].count, 1, 'harus ditaruh KEMBALI persis sejumlah yang diambil - jangan sampai malah mengurangi isi chest asli');
    assert.equal(calls[1].type, calls[0].type, 'item yang ditaruh kembali harus jenis yang SAMA dengan yang diambil');
    assert.deepEqual(items, [{ name: 'ink_sac', type: 77, metadata: null, count: 3 }, { name: 'wheat_seeds', type: 12, metadata: null, count: 5 }], 'isi akhir yang dilaporkan harus utuh sama seperti semula (barang sudah dikembalikan)');
    assert.ok(logMessages.some((m) => m.includes('ink_sac')), 'harus melaporkan lewat log() bahwa probe verifikasi ini SUNGGUHAN terjadi (bukan cuma lolos diam-diam di tes) - supaya pemilik bisa lihat buktinya di feed dashboard');
  });

  it('kalau slot inventaris bot TIDAK cukup longgar (kurang dari 2 slot bebas), JANGAN coba probe ambil-taruh - permintaan nyata pemilik: sisakan 2 slot untuk melakukan verifikasi ini, jangan sampai malah bikin inventaris kepenuhan gara-gara probe', async () => {
    const calls = [];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      inventory: { items: () => new Array(35).fill(0).map((_, i) => ({ name: `filler_${i}`, count: 1 })) }, // nyaris penuh
      blockAt: () => ({ name: 'chest', position: { x: 5, y: 64, z: 5 } }),
      openChest: async () => ({
        containerItems: () => [{ name: 'ink_sac', type: 77, metadata: null, count: 3 }],
        withdraw: async (type, metadata, count) => { calls.push({ action: 'withdraw', type, metadata, count }); },
        deposit: async (type, metadata, count) => { calls.push({ action: 'deposit', type, metadata, count }); },
        close: () => {}
      })
    };
    const adapter = new MineflayerRoleAdapter(bot, { chestSettleMs: 5 });

    await adapter.getChestContents({ x: 5, y: 64, z: 5 });

    assert.equal(calls.length, 0, 'tidak boleh mencoba probe kalau slot bebas kurang dari cadangan yang diminta pemilik (2 slot)');
  });

  it('getChestContents(pos, { verify: false }) HARUS lewati probe ambil-taruh - ditemukan dari keluhan nyata pemilik: "worker nya membuka chest itu tapi sepertinya tidak melihat isinya" - root cause-nya resolveChestForItem di storageManagerEngine.js cuma "mengintip" isi BANYAK chest sekaligus (cari yang sudah cocok/kosong) memakai getChestContents yang sama dengan yang dipakai audit gudang, jadi probe ambil-taruh (mahal, tiap chest butuh beberapa ratus ms) ikut jalan di SETIAP chest yang diintip, bukan cuma sekali saat benar-benar mengaudit - membuat resolveChestForItem lambat sekali dan terlihat seperti macet. verify:false dipakai untuk intipan cepat semacam itu; default (tanpa opsi) tetap verify:true untuk audit sungguhan', async () => {
    const calls = [];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      inventory: { items: () => [] },
      blockAt: () => ({ name: 'chest', position: { x: 5, y: 64, z: 5 } }),
      openChest: async () => ({
        containerItems: () => [{ name: 'ink_sac', type: 77, metadata: null, count: 3 }],
        withdraw: async (type, metadata, count) => { calls.push({ action: 'withdraw', type, metadata, count }); },
        deposit: async (type, metadata, count) => { calls.push({ action: 'deposit', type, metadata, count }); },
        close: () => {}
      })
    };
    const adapter = new MineflayerRoleAdapter(bot, { chestSettleMs: 5 });

    const items = await adapter.getChestContents({ x: 5, y: 64, z: 5 }, { verify: false });

    assert.equal(calls.length, 0, 'verify:false harus benar-benar lewati probe ambil-taruh, walau chest ada isinya dan slot bebas cukup');
    assert.deepEqual(items, [{ name: 'ink_sac', type: 77, metadata: null, count: 3 }], 'isi tetap harus dikembalikan dengan benar, cuma tanpa probe tambahan');
  });
});

describe('MineflayerRoleAdapter.withdrawAllFromChest - ambil SEMUA isi chest apapun jenisnya - dipakai StorageManagerEngine untuk "kumpulkan semua chest di luar rumah", beda dari withdrawFromChest yang butuh filter nama item spesifik', () => {
  it('harus menarik setiap stack item di chest ke inventaris, mengembalikan total jenis dan jumlah barang yang diambil', async () => {
    const withdrawCalls = [];
    const bot = fakeBot({
      chestBlocks: [{ position: { x: 5, y: 64, z: 5 } }],
      chestContentsByKey: { '5,64,5': [{ name: 'iron_ingot', type: 1, metadata: null, count: 4 }, { name: 'stone', type: 2, metadata: null, count: 64 }] }
    });
    const originalOpenChest = bot.openChest;
    bot.openChest = async (block) => {
      const chest = await originalOpenChest(block);
      chest.withdraw = async (type, metadata, count) => { withdrawCalls.push({ type, metadata, count }); };
      return chest;
    };
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.withdrawAllFromChest({ x: 5, y: 64, z: 5 });

    assert.equal(result.itemsWithdrawn, 2, 'harus menghitung 2 JENIS item yang ditarik');
    assert.equal(result.totalCount, 68, 'harus menjumlahkan total barang (4+64) dari semua jenis');
    assert.equal(withdrawCalls.length, 2);
    assert.deepEqual(withdrawCalls[0], { type: 1, metadata: null, count: 4 });
    assert.deepEqual(withdrawCalls[1], { type: 2, metadata: null, count: 64 });
  });

  it('harus mengembalikan nol kalau chest kosong atau tidak bisa dibuka', async () => {
    const bot = fakeBot({ chestBlocks: [{ position: { x: 5, y: 64, z: 5 } }] });
    const adapter = new MineflayerRoleAdapter(bot);

    const result = await adapter.withdrawAllFromChest({ x: 5, y: 64, z: 5 });

    assert.equal(result.itemsWithdrawn, 0);
    assert.equal(result.totalCount, 0);
  });
});

describe('MineflayerRoleAdapter.navigateNear - harus PUNYA BATAS WAKTU, jangan pernah menggantung selamanya - ditemukan dari bug live nyata: StorageWorker berhenti total (diam di tempat, tidak ada tick/error/log SAMA SEKALI selama menit-menitan) karena bot.pathfinder.goto() ke chest yang TIDAK TERJANGKAU tidak pernah resolve maupun reject - satu chest tak terjangkau membekukan SELURUH worker permanen, bukan cuma gagal aman untuk chest itu', () => {
  it('kalau pathfinder.goto() menggantung (tidak pernah resolve), navigateNear harus tetap resolve ke false setelah navigateTimeoutMs, bukan menggantung ikut-ikutan selamanya', async () => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      // Simulasikan chest tak terjangkau: goto() dipanggil tapi promise-nya TIDAK PERNAH resolve
      // ataupun reject - persis seperti pathfinder yang terus mencoba tanpa pernah menyerah.
      pathfinder: { goto: () => new Promise(() => {}) }
    };
    const adapter = new MineflayerRoleAdapter(bot, { navigateTimeoutMs: 50 });

    const result = await adapter.navigateNear({ x: 10, y: 64, z: 10 }, 3);

    assert.equal(result, false, 'harus menyerah dan lanjut (false), bukan menggantung selamanya menunggu goto() yang tidak pernah selesai');
  });

  it('kalau pathfinder.goto() berhasil sebelum batas waktu, tetap harus mengembalikan true seperti biasa', async () => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} }
    };
    const adapter = new MineflayerRoleAdapter(bot, { navigateTimeoutMs: 50 });

    const result = await adapter.navigateNear({ x: 10, y: 64, z: 10 }, 3);

    assert.equal(result, true);
  });
});

describe('MineflayerRoleAdapter.findChestPositions / findMatchingChest - juga harus mencocokkan blok "barrel", bukan cuma "chest" - permintaan nyata pemilik: barel di antara chest gudang juga boleh dipakai untuk menyimpan', () => {
  it('findChestPositions harus mencocokkan blok chest MAUPUN barrel, tapi bukan blok lain (mis. furnace)', () => {
    let capturedMatcher;
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      findBlocks: (opts) => { capturedMatcher = opts.matching; return []; }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    adapter.findChestPositions();

    assert.equal(typeof capturedMatcher, 'function');
    assert.equal(capturedMatcher({ name: 'chest' }), true);
    assert.equal(capturedMatcher({ name: 'barrel' }), true);
    assert.equal(capturedMatcher({ name: 'furnace' }), false);
  });

  it('findMatchingChest harus mencocokkan blok chest MAUPUN barrel juga', async () => {
    let capturedMatcher;
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      findBlocks: (opts) => { capturedMatcher = opts.matching; return []; }
    };
    const adapter = new MineflayerRoleAdapter(bot);

    await adapter.findMatchingChest(['iron_ingot']);

    assert.equal(typeof capturedMatcher, 'function');
    assert.equal(capturedMatcher({ name: 'chest' }), true);
    assert.equal(capturedMatcher({ name: 'barrel' }), true);
    assert.equal(capturedMatcher({ name: 'furnace' }), false);
  });
});

describe('MineflayerRoleAdapter.openChestAt - harus beri jeda singkat setelah windowOpen sebelum dipakai, supaya slot benar-benar tersinkron', () => {
  it('harus menunggu MINIMAL chestSettleMs sesudah bot.openChest() selesai sebelum mengembalikan window - ditemukan dari bug live nyata: deposit gagal dengan "destination full" padahal chest sungguhan (dicek langsung di game) MASIH banyak slot kosong - windowOpen event terpicu SEBELUM paket isi slot (window_items) benar-benar diproses, jadi window.slots lokal bot bisa saja belum lengkap/akurat tepat setelah open, membuat pengecekan "ada slot kosong?" salah menyimpulkan chest penuh', async () => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      blockAt: () => ({ name: 'chest', position: { x: 5, y: 64, z: 5 } }),
      openChest: async () => ({ containerItems: () => [], close: () => {} })
    };
    const adapter = new MineflayerRoleAdapter(bot, { chestSettleMs: 30 });

    const start = Date.now();
    await adapter.openChestAt({ x: 5, y: 64, z: 5 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 30, `harus menunggu minimal chestSettleMs (30ms) sesudah open, tapi cuma ${elapsed}ms`);
  });

  it('harus TERUS membaca ulang isi chest sampai dua bacaan berturut-turut SAMA (bukan cuma tunggu sekali lalu percaya) - kalau lag server lebih lama dari chestSettleMs, satu jeda tunggal saja bisa masih membaca data lama/belum lengkap - ditemukan dari keluhan nyata pemilik: item yang salah tempat tetap tidak diambil karena data chest yang dibaca belum ter-update saat dicocokkan dengan kategori seharusnya', async () => {
    let callCount = 0;
    const readings = [
      [{ name: 'dirt', count: 1 }], // baca pertama: masih data lama/belum lengkap
      [{ name: 'dirt', count: 1 }, { name: 'ink_sac', count: 3 }], // baca kedua: masih berubah (belum stabil)
      [{ name: 'dirt', count: 1 }, { name: 'ink_sac', count: 3 }] // baca ketiga: sama dengan sebelumnya -> stabil
    ];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { goto: async () => {} },
      blockAt: () => ({ name: 'chest', position: { x: 5, y: 64, z: 5 } }),
      openChest: async () => ({
        containerItems: () => {
          const result = readings[Math.min(callCount, readings.length - 1)];
          callCount += 1;
          return result;
        },
        close: () => {}
      })
    };
    const adapter = new MineflayerRoleAdapter(bot, { chestSettleMs: 5 });

    const items = await adapter.getChestContents({ x: 5, y: 64, z: 5 });

    assert.ok(callCount >= 3, `harus membaca ulang sampai stabil (minimal 3x baca), tapi cuma ${callCount}x`);
    assert.deepEqual(items, [{ name: 'dirt', count: 1 }, { name: 'ink_sac', count: 3 }], 'harus pakai bacaan yang SUDAH stabil, bukan bacaan pertama yang masih berubah');
  });
});
