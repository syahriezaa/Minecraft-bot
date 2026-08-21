/**
 * @file survival_role_engines.test.js
 * @description Unit test engine survival role: farmer, peternakan, mob farm, dan coordinator.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FarmerEngine } = require('../../src/ai/farmerEngine');
const { AnimalHusbandryEngine } = require('../../src/ai/animalHusbandryEngine');
const { MobFarmEngine } = require('../../src/ai/mobFarmEngine');
const { SurvivalRoleCoordinator, ROLE_STATES } = require('../../src/ai/survivalRoleCoordinator');

class FakeRoleAdapter {
  constructor(options = {}) {
    this.position = options.position || { x: 0, y: 64, z: 0 };
    this.health = options.health ?? 20;
    this.food = options.food ?? 20;
    this.items = new Map(Object.entries(options.items || {}));
    this.blocks = options.blocks || [];
    this.entities = options.entities || [];
    this.actions = [];
  }

  getPosition() { return this.position; }
  getHealth() { return this.health; }
  getFood() { return this.food; }
  getEntities() { return this.entities; }
  hasItem(names) {
    const list = Array.isArray(names) ? names : [names];
    return list.some(name => (this.items.get(name) || 0) > 0);
  }
  findBlocksByNames(names) {
    const wanted = new Set(names);
    return this.blocks.filter(block => wanted.has(block.name));
  }
  blockAt(pos) {
    return this.blocks.find(block =>
      block.position.x === pos.x &&
      block.position.y === pos.y &&
      block.position.z === pos.z
    ) || { name: 'air', position: pos };
  }
  async dig(block) {
    this.actions.push({ type: 'dig', name: block.name, position: block.position });
  }
  async placeSeed(block, seed) {
    this.actions.push({ type: 'placeSeed', seed, position: block.position });
    return true;
  }
  async equipItem(names, destination = 'hand') {
    this.actions.push({ type: 'equip', names, destination });
    return this.hasItem(names);
  }
  async useOn(entity) {
    this.actions.push({ type: 'useOn', entity: entity.name || entity.type, id: entity.id });
    return true;
  }
  async attack(entity) {
    this.actions.push({ type: 'attack', entity: entity.name || entity.type, id: entity.id });
    return true;
  }
  async navigateNear(pos, range) {
    this.actions.push({ type: 'navigate', position: pos, range });
    return true;
  }
  async eatBestFood() {
    this.actions.push({ type: 'eat' });
    this.food = 20;
    return this.hasItem(['bread', 'cooked_beef', 'steak', 'apple', 'carrot']);
  }
  activateShield() {
    this.actions.push({ type: 'shield' });
    return true;
  }
  async depositToChest(pos, predicate = () => true, maxPerItem = {}) {
    const matched = this.getInventoryItems().filter(predicate);
    this.actions.push({ type: 'deposit', position: pos, items: matched.map((i) => i.name), maxPerItem });
    let deposited = 0;
    for (const item of matched) {
      const reserve = maxPerItem[item.name];
      const amount = reserve !== undefined ? Math.max(0, (item.count || 1) - reserve) : (item.count || 1);
      deposited += amount;
    }
    return { deposited };
  }
  getInventoryItems() {
    return Array.from(this.items.entries()).map(([name, count]) => ({ name, count }));
  }
  async findMatchingChest(itemNames) {
    this.actions.push({ type: 'findMatchingChest', itemNames });
    const match = (this.chests || []).find((c) => c.contents.some((n) => itemNames.includes(n)));
    return match ? match.position : null;
  }
  async withdrawFromChest(pos, itemNames, count) {
    this.actions.push({ type: 'withdrawFromChest', position: pos, itemNames, count });
    // Meniru perilaku mineflayer sungguhan: chest.withdraw() MELEMPAR error kalau inventaris
    // bot benar-benar penuh, bukan mengembalikan {withdrawn:0} dengan tenang - dipakai untuk
    // membuktikan tick() tidak boleh macet/crash kalau ini terjadi di tengah proses perbaikan.
    if (this.freeSlots !== undefined && this.freeSlots <= 0) {
      throw new Error('Unable to withdraw, Bot inventory is full');
    }
    const matchedName = itemNames.find((name) => (this.withdrawStock?.[name] || 0) > 0);
    const take = matchedName ? this.withdrawStock[matchedName] : 0;
    if (take > 0) this.items.set(matchedName, (this.items.get(matchedName) || 0) + take);
    return { withdrawn: take };
  }
  getInventoryFreeSlotCount() {
    return this.freeSlots ?? Infinity;
  }
  async tillFarmland(pos) {
    this.actions.push({ type: 'tillFarmland', position: pos });
    return true;
  }
  async placeDirtAt(pos) {
    this.actions.push({ type: 'placeDirtAt', position: pos });
    return true;
  }
}

describe('FarmerEngine', () => {
  it('harus memanen crop matang dan mengabaikan crop muda', async () => {
    const adapter = new FakeRoleAdapter({
      blocks: [
        { name: 'wheat', properties: { age: 7 }, position: { x: 1, y: 64, z: 0 } },
        { name: 'carrots', properties: { age: 2 }, position: { x: 2, y: 64, z: 0 } }
      ]
    });
    const engine = new FarmerEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'harvest');
    assert.deepEqual(adapter.actions, [
      { type: 'dig', name: 'wheat', position: { x: 1, y: 64, z: 0 } }
    ]);
    assert.equal(engine.metrics.harvested, 1);
  });

  it('dengan avoidArea diset, crop matang DI DALAM area itu harus diabaikan sama sekali - ditemukan dari permintaan nyata pemilik: bot terus kembali ke area peternakan villager (dekat base) yang bukan bagian dari kebun sungguhan dan sebagian terhalang tembok, mencoba mencapainya berulang-ulang sia-sia', async () => {
    const adapter = new FakeRoleAdapter({
      blocks: [
        { name: 'wheat', properties: { age: 7 }, position: { x: -190, y: 63, z: -327 } }, // di dalam area peternakan villager - HARUS diabaikan
        { name: 'wheat', properties: { age: 7 }, position: { x: -190, y: 63, z: -390 } } // di kebun sungguhan - HARUS tetap dipanen
      ]
    });
    const avoidArea = { min: { x: -200, y: 0, z: -337 }, max: { x: -170, y: 100, z: -318 } };
    const engine = new FarmerEngine({ adapter, avoidArea });

    const result = await engine.tick();

    assert.equal(result.action, 'harvest');
    assert.deepEqual(adapter.actions, [
      { type: 'dig', name: 'wheat', position: { x: -190, y: 63, z: -390 } }
    ]);
  });

  it('harus menanam seed pada farmland kosong', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat_seeds: 4 },
      blocks: [
        { name: 'farmland', position: { x: 3, y: 63, z: 0 } }
      ]
    });
    const engine = new FarmerEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'plant');
    assert.equal(result.seed, 'wheat_seeds');
    assert.equal(adapter.actions[0].type, 'placeSeed');
  });

  it('kalau punya wheat_seeds, carrot, DAN potato sekaligus, harus BERGANTIAN menanam ketiganya ANTAR BARIS (satu jenis benih per baris memanjang, bukan campur-campur di dalam satu baris) - permintaan nyata pemilik: "tanam dengan variasi per baris memanjang". SATU baris = spot-spot dengan koordinat TETAP yang sama di sumbu yang lebih pendek (di sini z tetap, x memanjang)', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat_seeds: 10, carrot: 10, potato: 10 },
      blocks: [
        { name: 'farmland', position: { x: 1, y: 63, z: 0 } },
        { name: 'farmland', position: { x: 2, y: 63, z: 0 } },
        { name: 'farmland', position: { x: 3, y: 63, z: 0 } },
        { name: 'farmland', position: { x: 1, y: 63, z: 1 } },
        { name: 'farmland', position: { x: 2, y: 63, z: 1 } },
        { name: 'farmland', position: { x: 3, y: 63, z: 1 } },
        { name: 'farmland', position: { x: 1, y: 63, z: 2 } },
        { name: 'farmland', position: { x: 2, y: 63, z: 2 } },
        { name: 'farmland', position: { x: 3, y: 63, z: 2 } }
      ]
    });
    const engine = new FarmerEngine({ adapter, plantBatchSize: 9 });

    await engine.tick();

    const planted = adapter.actions.filter(a => a.type === 'placeSeed');
    assert.equal(planted.length, 9);
    const seedByRow = (z) => new Set(planted.filter(a => a.position.z === z).map(a => a.seed));
    assert.equal(seedByRow(0).size, 1, 'seluruh baris z=0 harus satu jenis benih yang sama');
    assert.equal(seedByRow(1).size, 1, 'seluruh baris z=1 harus satu jenis benih yang sama');
    assert.equal(seedByRow(2).size, 1, 'seluruh baris z=2 harus satu jenis benih yang sama');
    const allSeedsUsed = new Set(planted.map(a => a.seed));
    assert.deepEqual(allSeedsUsed, new Set(['wheat_seeds', 'carrot', 'potato']), 'ketiga jenis tetap harus terpakai semua, variasinya ANTAR baris');
  });

  it('SATU baris (spot-spot sebaris memanjang) TIDAK BOLEH dicampur beberapa jenis benih - ditemukan dari perilaku lama yang keliru: tiap spot individual bergantian benih walau sebenarnya sebaris fisik yang sama, membuat satu baris terlihat campur-campur bukannya rapi per jenis', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat_seeds: 10, carrot: 10, potato: 10 },
      blocks: [
        { name: 'farmland', position: { x: 1, y: 63, z: 0 } },
        { name: 'farmland', position: { x: 2, y: 63, z: 0 } },
        { name: 'farmland', position: { x: 3, y: 63, z: 0 } }
      ]
    });
    const engine = new FarmerEngine({ adapter, plantBatchSize: 3 });

    await engine.tick();

    const seedsPlanted = adapter.actions.filter(a => a.type === 'placeSeed').map(a => a.seed);
    assert.equal(seedsPlanted.length, 3);
    assert.equal(new Set(seedsPlanted).size, 1, 'ketiga spot dalam satu baris yang sama harus dapat SATU jenis benih yang sama, bukan campur');
  });

  it('dengan autoMatchStorage aktif, harus menyimpan tiap jenis hasil panen ke chest yang SUDAH berisi jenis yang sama (bukan satu chest tunggal) - ditemukan dari gudang nyata pemilik: wheat dan carrot disimpan terpisah di chest masing-masing, bukan digabung sembarangan', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat: 5, carrot: 3 }
    });
    adapter.chests = [
      { position: { x: -181, y: 73, z: -350 }, contents: ['wheat'] },
      { position: { x: -181, y: 73, z: -349 }, contents: ['carrot'] }
    ];
    const engine = new FarmerEngine({ adapter, autoMatchStorage: true });

    const result = await engine.tick();

    assert.equal(result.action, 'deposit');
    const deposits = adapter.actions.filter((a) => a.type === 'deposit');
    assert.equal(deposits.length, 2, 'harus deposit ke DUA chest berbeda, satu per jenis item');
    const wheatDeposit = deposits.find((d) => d.position.z === -350);
    const carrotDeposit = deposits.find((d) => d.position.z === -349);
    assert.deepEqual(wheatDeposit.items, ['wheat']);
    assert.deepEqual(carrotDeposit.items, ['carrot']);
  });

  it('dengan autoMatchStorage aktif DAN sharedChestAssignments diberikan (memori sortir gudang yang sama dengan StorageWorker), harus LANGSUNG antar ke posisi yang sudah diketahui - TANPA memindai chest satu-satu lewat findMatchingChest - permintaan nyata pemilik: "share memory tentang peti ke semua bot agar dapat mencari barang barang dan menaruh barang dengan tepat"', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat: 5 }
    });
    // SENGAJA tidak diisi chest apapun (adapter.chests kosong) - kalau engine masih jatuh ke
    // findMatchingChest, deposit ini akan GAGAL (tidak ketemu apa-apa), membuktikan jalur memori
    // bersama-lah yang benar-benar dipakai, bukan cuma kebetulan lolos lewat live-scan.
    const engine = new FarmerEngine({
      adapter,
      autoMatchStorage: true,
      sharedChestAssignments: { wheat: '-181,73,-350' }
    });

    const result = await engine.tick();

    assert.equal(result.action, 'deposit');
    const deposits = adapter.actions.filter((a) => a.type === 'deposit');
    assert.equal(deposits.length, 1);
    assert.deepEqual(deposits[0].position, { x: -181, y: 73, z: -350 }, 'harus antar persis ke posisi dari memori bersama');
    assert.ok(!adapter.actions.some((a) => a.type === 'findMatchingChest'), 'TIDAK BOLEH memindai chest satu-satu kalau posisinya sudah diketahui lewat memori bersama - lebih lambat dan bisa salah pilih');
  });

  it('dengan autoMatchStorage aktif, item yang TIDAK ADA di sharedChestAssignments harus tetap jatuh ke findMatchingChest (live-scan) seperti biasa - memori bersama HANYA jalur pintas untuk item yang sudah dikenal, bukan pengganti mutlak', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat: 5 }
    });
    adapter.chests = [{ position: { x: -181, y: 73, z: -350 }, contents: ['wheat'] }];
    const engine = new FarmerEngine({
      adapter,
      autoMatchStorage: true,
      sharedChestAssignments: {} // kosong - wheat belum dikenal sama sekali di memori bersama
    });

    const result = await engine.tick();

    assert.equal(result.action, 'deposit');
    assert.ok(adapter.actions.some((a) => a.type === 'findMatchingChest'), 'item yang tidak dikenal memori bersama harus tetap dicari lewat live-scan seperti biasa');
  });

  it('dengan autoMatchStorage aktif tapi TIDAK ADA chest yang cocok untuk suatu item, item itu TIDAK BOLEH dibuang ke chest sembarangan - biarkan di inventaris sampai chest yang cocok ditemukan', async () => {
    const adapter = new FakeRoleAdapter({ items: { potato: 2 } });
    adapter.chests = [{ position: { x: 0, y: 64, z: 0 }, contents: ['wheat'] }];
    const engine = new FarmerEngine({ adapter, autoMatchStorage: true });

    const result = await engine.tick();

    const deposits = adapter.actions.filter((a) => a.type === 'deposit');
    assert.equal(deposits.length, 0, 'tidak boleh ada deposit sama sekali kalau tidak ada chest yang cocok');
    assert.equal(result.action, 'idle');
  });

  it('dengan autoMatchStorage aktif, item yang JUGA dipakai sebagai benih (carrot/potato/wheat_seeds dst) harus disetor dengan cadangan tersisa (seedReserve) - JANGAN disetor habis sebelum kebun selesai ditanami, ditemukan dari permintaan nyata pemilik: jangan sampai kehabisan benih untuk tanam berikutnya karena sudah disetor semua ke gudang', async () => {
    const adapter = new FakeRoleAdapter({ items: { carrot: 20, wheat: 15 } }); // wheat BUKAN benih (benihnya wheat_seeds, beda item) - bebas disetor penuh
    adapter.chests = [
      { position: { x: 0, y: 64, z: 0 }, contents: ['carrot'] },
      { position: { x: 1, y: 64, z: 0 }, contents: ['wheat'] }
    ];
    const engine = new FarmerEngine({ adapter, autoMatchStorage: true, seedReserve: 8 });

    await engine.tick();

    const carrotDeposit = adapter.actions.find((a) => a.type === 'deposit' && a.items.includes('carrot'));
    const wheatDeposit = adapter.actions.find((a) => a.type === 'deposit' && a.items.includes('wheat'));
    assert.deepEqual(carrotDeposit.maxPerItem, { carrot: 8 }, 'carrot adalah benih (juga jadi bibit sendiri) - harus dibatasi cadangan');
    assert.deepEqual(wheatDeposit.maxPerItem, {}, 'wheat bukan benih (benihnya wheat_seeds, item beda) - bebas disetor penuh tanpa batas');
  });

  describe('perbaikan lahan farming (repair) - permintaan nyata pemilik: "farming bot harus bisa memperbaiki tempat farming jadi bawa dirt dan hoe dari gudang"', () => {
    // 3 sisi tetangga farmland(0,63,0) yang SENGAJA diisi stone (bukan dirt/grass, bukan kosong) -
    // supaya tiap tes cuma punya SATU kandidat perbaikan yang benar-benar diuji (sisi x=1), bukan
    // ikut menghitung 3 sisi lain yang (kalau dibiarkan tak terdaftar) akan dianggap "lubang"
    // kosong juga oleh FakeRoleAdapter.blockAt (defaultnya 'air' untuk posisi manapun yang tidak
    // eksplisit didaftarkan).
    const otherThreeSidesBlocked = [
      { name: 'stone', position: { x: -1, y: 63, z: 0 } },
      { name: 'stone', position: { x: 0, y: 63, z: 1 } },
      { name: 'stone', position: { x: 0, y: 63, z: -1 } }
    ];

    it('kalau ada dirt/grass yang BERSEBELAHAN LANGSUNG dengan farmland yang sudah ada (belum dicangkul) DAN bot sudah membawa cangkul, harus mencangkulnya jadi farmland - lahan tidak ada lagi yang bisa dipanen/ditanam jadi ini satu-satunya langkah produktif yang tersisa', async () => {
      const adapter = new FakeRoleAdapter({
        items: { iron_hoe: 1 },
        blocks: [
          { name: 'farmland', position: { x: 0, y: 63, z: 0 } },
          { name: 'dirt', position: { x: 1, y: 63, z: 0 } },
          ...otherThreeSidesBlocked
        ]
      });
      const engine = new FarmerEngine({ adapter });

      const result = await engine.tick();

      assert.equal(result.action, 'repair');
      const tilled = adapter.actions.filter((a) => a.type === 'tillFarmland');
      assert.equal(tilled.length, 1);
      assert.deepEqual(tilled[0].position, { x: 1, y: 63, z: 0 });
      assert.equal(engine.metrics.repaired, 1);
    });

    it('kalau kandidat perbaikan berupa LUBANG (bukan dirt/grass, cuma kosong) DAN bot punya dirt+cangkul, harus taruh dirt DULU baru dicangkul', async () => {
      const adapter = new FakeRoleAdapter({
        items: { iron_hoe: 1, dirt: 8 },
        blocks: [
          { name: 'farmland', position: { x: 0, y: 63, z: 0 } },
          // (1,63,0) SENGAJA tidak didaftarkan sama sekali - blockAt bawaan FakeRoleAdapter
          // mengembalikan 'air' untuk posisi manapun yang tidak eksplisit didaftarkan, persis
          // meniru lubang kosong di lahan sungguhan.
          ...otherThreeSidesBlocked
        ]
      });
      const engine = new FarmerEngine({ adapter });

      const result = await engine.tick();

      assert.equal(result.action, 'repair');
      const filled = adapter.actions.filter((a) => a.type === 'placeDirtAt');
      const tilled = adapter.actions.filter((a) => a.type === 'tillFarmland');
      assert.equal(filled.length, 1);
      assert.equal(tilled.length, 1);
      assert.deepEqual(filled[0].position, { x: 1, y: 63, z: 0 });
      assert.ok(adapter.actions.indexOf(filled[0]) < adapter.actions.indexOf(tilled[0]), 'dirt harus ditaruh SEBELUM dicangkul, bukan sesudahnya');
    });

    it('kalau bot BELUM punya cangkul tapi memori bersama (sharedChestAssignments) sudah tahu chest perkakas - harus ambil cangkul dari gudang DULU sebelum mencangkul - permintaan nyata pemilik: "bawa dirt dan hoe dari gudang"', async () => {
      const adapter = new FakeRoleAdapter({
        blocks: [
          { name: 'farmland', position: { x: 0, y: 63, z: 0 } },
          { name: 'dirt', position: { x: 1, y: 63, z: 0 } },
          ...otherThreeSidesBlocked
        ]
      });
      adapter.withdrawStock = { iron_hoe: 1 };
      const engine = new FarmerEngine({
        adapter,
        sharedChestAssignments: { iron_hoe: '-181,71,-348' }
      });

      const result = await engine.tick();

      assert.equal(result.action, 'repair');
      const withdrawal = adapter.actions.find((a) => a.type === 'withdrawFromChest');
      assert.ok(withdrawal, 'harus mengambil cangkul dari gudang dulu');
      assert.deepEqual(withdrawal.position, { x: -181, y: 71, z: -348 });
      assert.ok(adapter.actions.some((a) => a.type === 'tillFarmland'), 'setelah dapat cangkul, harus lanjut mencangkul');
    });

    it('kalau tidak ada cangkul sama sekali DAN memori bersama juga tidak tahu di mana cangkulnya, JANGAN macet - lewati perbaikan dan lanjut ke langkah lain (bukan gagal diam-diam tanpa progres)', async () => {
      const adapter = new FakeRoleAdapter({
        blocks: [
          { name: 'farmland', position: { x: 0, y: 63, z: 0 } },
          { name: 'dirt', position: { x: 1, y: 63, z: 0 } }
        ]
      });
      const engine = new FarmerEngine({ adapter }); // tidak ada sharedChestAssignments sama sekali

      const result = await engine.tick();

      assert.ok(!adapter.actions.some((a) => a.type === 'tillFarmland'), 'tidak boleh mencangkul tanpa cangkul di tangan');
      assert.equal(result.action, 'idle', 'harus tetap lanjut (idle), bukan macet/crash');
    });

    it('kalau repairEnabled: false, JANGAN pernah mencoba memperbaiki apapun walau ada kandidat dan perkakas lengkap - opsi eksplisit untuk mematikan fitur ini', async () => {
      const adapter = new FakeRoleAdapter({
        items: { iron_hoe: 1 },
        blocks: [
          { name: 'farmland', position: { x: 0, y: 63, z: 0 } },
          { name: 'dirt', position: { x: 1, y: 63, z: 0 } }
        ]
      });
      const engine = new FarmerEngine({ adapter, repairEnabled: false });

      const result = await engine.tick();

      assert.ok(!adapter.actions.some((a) => a.type === 'tillFarmland'));
      assert.notEqual(result.action, 'repair');
    });

    it('perbaikan TIDAK BOLEH menyentuh blok yang jelas BUKAN bagian lahan (mis. water - kanal irigasi yang sengaja dibiarkan) walau bersebelahan langsung dengan farmland - kandidat perbaikan cuma dirt/grass polos (belum dicangkul) atau benar-benar kosong (lubang)', async () => {
      const adapter = new FakeRoleAdapter({
        items: { iron_hoe: 1, dirt: 8 },
        blocks: [
          { name: 'farmland', position: { x: 0, y: 63, z: 0 } },
          { name: 'water', position: { x: 1, y: 63, z: 0 } },
          ...otherThreeSidesBlocked
        ]
      });
      const engine = new FarmerEngine({ adapter });

      const candidates = engine.findRepairCandidates();

      assert.equal(candidates.length, 0, 'water TIDAK BOLEH pernah dianggap kandidat perbaikan');
    });

    it('kalau inventaris bot BENAR-BENAR PENUH (tidak ada slot bebas sama sekali) dan repair butuh mengambil cangkul/dirt dari gudang, JANGAN coba mengambil apapun (chest.withdraw sungguhan MELEMPAR error "inventory is full", bukan gagal dengan tenang) - ditemukan dari bug live nyata: "farmer worker nya tidak click apa apa" - setiap tick attemptRepair melempar exception SEBELUM sempat sampai ke langkah deposit, jadi tick() selalu gagal total dan bot macet total, tidak pernah menaruh apapun ke gudang walau itu justru yang seharusnya terjadi duluan', async () => {
      const adapter = new FakeRoleAdapter({
        blocks: [
          { name: 'farmland', position: { x: 0, y: 63, z: 0 } },
          { name: 'dirt', position: { x: 1, y: 63, z: 0 } },
          { name: 'stone', position: { x: -1, y: 63, z: 0 } },
          { name: 'stone', position: { x: 0, y: 63, z: 1 } },
          { name: 'stone', position: { x: 0, y: 63, z: -1 } }
        ]
      });
      adapter.freeSlots = 0; // inventaris benar-benar penuh - persis situasi bug live nyata
      const engine = new FarmerEngine({
        adapter,
        sharedChestAssignments: { iron_hoe: '-181,71,-348' }
      });

      await assert.doesNotReject(() => engine.tick(), 'tick() TIDAK BOLEH melempar/crash walau inventaris penuh saat repair butuh mengambil sesuatu');
      assert.ok(!adapter.actions.some((a) => a.type === 'withdrawFromChest'), 'tidak boleh bahkan MENCOBA mengambil apapun kalau jelas-jelas tidak ada tempat untuk menaruhnya');
    });
  });
});

describe('AnimalHusbandryEngine', () => {
  it('harus memberi makan dua adult dan tidak memilih bayi', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat: 8 },
      entities: [
        { id: 1, name: 'cow', isBaby: false, position: { x: 1, y: 64, z: 0 } },
        { id: 2, name: 'cow', isBaby: false, position: { x: 2, y: 64, z: 0 } },
        { id: 3, name: 'cow', isBaby: true, position: { x: 3, y: 64, z: 0 } }
      ]
    });
    const engine = new AnimalHusbandryEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'feed');
    assert.deepEqual(adapter.actions.filter(a => a.type === 'useOn').map(a => a.id), [1, 2]);
  });

  it('dengan avoidArea diset, hewan DI DALAM area itu harus diabaikan sama sekali - ditemukan dari permintaan nyata pemilik: jangan kembali ke area peternakan villager dekat base', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat: 8 },
      entities: [
        { id: 1, name: 'cow', isBaby: false, position: { x: 0, y: 64, z: 0 } }, // di dalam area terlarang
        { id: 2, name: 'cow', isBaby: false, position: { x: 15, y: 64, z: 0 } }, // di luar area terlarang
        { id: 3, name: 'cow', isBaby: false, position: { x: -15, y: 64, z: 0 } } // di luar area terlarang
      ]
    });
    const avoidArea = { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 100, z: 10 } };
    const engine = new AnimalHusbandryEngine({ adapter, avoidArea });

    const result = await engine.tick();

    assert.equal(result.action, 'feed');
    assert.deepEqual(adapter.actions.filter(a => a.type === 'useOn').map(a => a.id), [2, 3]);
  });

  it('harus memberi makan goat dengan wheat - ditemukan dari permintaan nyata pemilik: sapi, kambing (goat), ayam butuh diberi makan, tapi goat sebelumnya tidak ada di ANIMAL_RULES sama sekali', async () => {
    const adapter = new FakeRoleAdapter({
      items: { wheat: 8 },
      entities: [
        { id: 1, name: 'goat', isBaby: false, position: { x: 1, y: 64, z: 0 } },
        { id: 2, name: 'goat', isBaby: false, position: { x: 2, y: 64, z: 0 } }
      ]
    });
    const engine = new AnimalHusbandryEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'feed');
    assert.deepEqual(adapter.actions.filter(a => a.type === 'useOn').map(a => a.id), [1, 2]);
  });

  it('harus membunuh surplus adult sambil menyisakan indukan minimum', async () => {
    const entities = Array.from({ length: 6 }, (_, idx) => ({
      id: idx + 1,
      name: 'cow',
      isBaby: false,
      position: { x: idx + 1, y: 64, z: 0 }
    }));
    const adapter = new FakeRoleAdapter({ entities, items: { iron_sword: 1 } });
    const engine = new AnimalHusbandryEngine({
      adapter,
      rules: { cow: { feed: 'wheat', preserveAdults: 2, maxAdults: 4 } },
      maxCullPerTick: 2
    });

    const result = await engine.tick();

    assert.equal(result.action, 'cull');
    assert.deepEqual(adapter.actions.filter(a => a.type === 'attack').map(a => a.id), [5, 6]);
  });
});

describe('MobFarmEngine', () => {
  it('harus memakai shield saat target skeleton dan menyerang sesuai cooldown', async () => {
    const adapter = new FakeRoleAdapter({
      items: { shield: 1, iron_sword: 1 },
      entities: [
        { id: 10, name: 'skeleton', position: { x: 2, y: 64, z: 0 } }
      ]
    });
    const engine = new MobFarmEngine({ adapter, attackCooldownMs: 0 });

    const result = await engine.tick();

    assert.equal(result.action, 'attack');
    assert.ok(adapter.actions.some(a => a.type === 'equip' && a.destination === 'off-hand'));
    assert.ok(adapter.actions.some(a => a.type === 'shield'));
    assert.ok(adapter.actions.some(a => a.type === 'attack' && a.id === 10));
  });

  it('harus makan atau retreat saat health rendah sebelum menyerang', async () => {
    const adapter = new FakeRoleAdapter({
      health: 5,
      items: { bread: 1, iron_sword: 1 },
      entities: [
        { id: 11, name: 'zombie', position: { x: 2, y: 64, z: 0 } }
      ]
    });
    const engine = new MobFarmEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'eat');
    assert.equal(adapter.actions[0].type, 'eat');
    assert.equal(adapter.actions.some(a => a.type === 'attack'), false);
  });

  it('dengan patrolWaypoints diset dan tidak ada ancaman, harus berjalan ke waypoint SEKARANG, lalu pindah ke waypoint berikutnya begitu tiba - ditemukan dari keluhan nyata pemilik: penjaga cuma diam di satu titik ("standby") jadi jarang ketemu mob sama sekali, bukan benar-benar berpatroli', async () => {
    const adapter = new FakeRoleAdapter({ position: { x: 0, y: 64, z: 0 } });
    const waypoints = [{ x: 10, y: 64, z: 0 }, { x: -10, y: 64, z: 0 }];
    const engine = new MobFarmEngine({ adapter, patrolWaypoints: waypoints, waypointReachRadius: 2 });

    const result = await engine.tick();

    assert.equal(result.action, 'patrol');
    assert.equal(adapter.actions[0].type, 'navigate');
    assert.deepEqual(adapter.actions[0].position, waypoints[0]);
  });

  it('begitu sudah dekat waypoint SEKARANG (dalam waypointReachRadius), tick berikutnya harus menuju waypoint BERIKUTNYA, bukan waypoint yang sama terus - supaya benar-benar berkeliling, bukan berhenti di satu titik lagi', async () => {
    const adapter = new FakeRoleAdapter({ position: { x: 9.5, y: 64, z: 0 } }); // sudah dekat waypoint[0] di (10,64,0)
    const waypoints = [{ x: 10, y: 64, z: 0 }, { x: -10, y: 64, z: 0 }];
    const engine = new MobFarmEngine({ adapter, patrolWaypoints: waypoints, waypointReachRadius: 2 });

    const result = await engine.tick();

    assert.equal(result.action, 'patrol');
    assert.deepEqual(adapter.actions[0].position, waypoints[1], 'harus lanjut ke waypoint kedua karena sudah dekat dengan waypoint pertama');
  });

  it('kalau ada ancaman, patrol harus berhenti sementara dan tetap melawan - patroli bukan alasan mengabaikan mob yang mendekat', async () => {
    const adapter = new FakeRoleAdapter({
      position: { x: 0, y: 64, z: 0 },
      items: { iron_sword: 1 },
      entities: [{ id: 20, name: 'zombie', position: { x: 1, y: 64, z: 0 } }]
    });
    const waypoints = [{ x: 10, y: 64, z: 0 }];
    const engine = new MobFarmEngine({ adapter, patrolWaypoints: waypoints, attackCooldownMs: 0 });

    const result = await engine.tick();

    assert.equal(result.action, 'attack');
  });
});

describe('SurvivalRoleCoordinator', () => {
  it('harus memprioritaskan mob farm ketika hostile ada di area', async () => {
    const adapter = new FakeRoleAdapter({
      items: { iron_sword: 1 },
      blocks: [
        { name: 'wheat', properties: { age: 7 }, position: { x: 1, y: 64, z: 0 } }
      ],
      entities: [
        { id: 20, name: 'zombie', position: { x: 2, y: 64, z: 0 } }
      ]
    });
    const coordinator = new SurvivalRoleCoordinator({
      adapter,
      mobFarmOptions: { attackCooldownMs: 0 }
    });

    const result = await coordinator.tick();

    assert.equal(result.role, 'mob_farm');
    assert.equal(result.action, 'attack');
    assert.equal(coordinator.state, ROLE_STATES.MOB_FARMING);
  });
});
