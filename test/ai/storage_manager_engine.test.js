/**
 * @file storage_manager_engine.test.js
 * @description Unit test StorageManagerEngine - kumpulkan isi chest DI LUAR rumah, bawa masuk ke
 * chest gudang DI DALAM rumah, dan rapikan gudang dengan membuka+memeriksa tiap chest di dalamnya.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { StorageManagerEngine } = require('../../src/ai/storageManagerEngine');

const HOUSE_BOUNDS = { min: { x: -190, y: 70, z: -355 }, max: { x: -180, y: 76, z: -348 } };

class FakeStorageAdapter {
  constructor({ chests = {}, inventory = {} } = {}) {
    // chests: { "x,y,z": { position: {x,y,z}, items: [{name,count,type,metadata}] } }
    this.chests = chests;
    this.inventory = new Map(Object.entries(inventory));
    this.actions = [];
  }

  getInventoryItems() {
    return Array.from(this.inventory.entries()).map(([name, count]) => ({ name, count, type: name, metadata: null }));
  }

  findChestPositions() {
    return Object.values(this.chests).map((c) => c.position);
  }

  async getChestContents(pos) {
    const chest = this.chests[`${pos.x},${pos.y},${pos.z}`];
    return chest ? chest.items : [];
  }

  async withdrawAllFromChest(pos) {
    const chest = this.chests[`${pos.x},${pos.y},${pos.z}`];
    this.actions.push({ type: 'withdrawAll', position: pos });
    if (!chest) return { itemsWithdrawn: 0, totalCount: 0 };
    const totalCount = chest.items.reduce((s, i) => s + (i.count || 1), 0);
    for (const item of chest.items) {
      this.inventory.set(item.name, (this.inventory.get(item.name) || 0) + item.count);
    }
    const itemsWithdrawn = chest.items.length;
    chest.items = [];
    return { itemsWithdrawn, totalCount };
  }

  async depositToChest(pos, predicate = () => true) {
    const chest = this.chests[`${pos.x},${pos.y},${pos.z}`];
    this.actions.push({ type: 'deposit', position: pos });
    let deposited = 0;
    for (const [name, count] of Array.from(this.inventory.entries())) {
      if (!predicate({ name, count })) continue;
      if (chest) chest.items.push({ name, count });
      deposited += count;
      this.inventory.delete(name);
    }
    return { deposited };
  }

  async navigateNear(pos) {
    this.actions.push({ type: 'navigate', position: pos });
    return true;
  }

  async withdrawFromChest(pos, itemNames, count) {
    const chest = this.chests[`${pos.x},${pos.y},${pos.z}`];
    this.actions.push({ type: 'withdrawFrom', position: pos, itemNames, count });
    if (!chest) return { withdrawn: 0 };
    const match = chest.items.find((it) => itemNames.includes(it.name));
    if (!match) return { withdrawn: 0 };
    const take = Math.min(count, match.count);
    this.inventory.set(match.name, (this.inventory.get(match.name) || 0) + take);
    match.count -= take;
    chest.items = chest.items.filter((it) => it.count > 0);
    return { withdrawn: take };
  }

  // blockType per posisi chest (default 'chest') - dipakai canonicalKeyFor untuk membedakan chest
  // (bisa gabung jadi double-chest) dari barrel (SELALU wadah tunggal, tidak pernah gabung).
  blockAt(pos) {
    const chest = this.chests[`${pos.x},${pos.y},${pos.z}`];
    if (!chest) return null;
    return { name: chest.blockType || 'chest' };
  }
}

describe('StorageManagerEngine', () => {
  it('harus mengumpulkan (withdrawAll) dari chest DI LUAR rumah kalau tangan kosong dan belum ada yang dikumpulkan', async () => {
    const adapter = new FakeStorageAdapter({
      chests: {
        '-200,64,-360': { position: { x: -200, y: 64, z: -360 }, items: [{ name: 'oak_log', count: 12 }] }
      }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const result = await engine.tick();

    assert.equal(result.action, 'collect');
    assert.equal(result.count, 12);
    assert.equal(engine.metrics.collected, 1);
    assert.equal(engine.metrics.itemsCollected, 12);
    assert.deepEqual(adapter.inventory.get('oak_log'), 12);
  });

  it('chest DI DALAM houseBounds TIDAK BOLEH dianggap sebagai target koleksi (itu justru tujuan pengantaran, bukan sumber)', async () => {
    const adapter = new FakeStorageAdapter({
      chests: {
        '-185,72,-352': { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'stone', count: 5 }] }
      }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const result = await engine.tick();

    assert.notEqual(result.action, 'collect');
  });

  it('kalau tangan sudah membawa barang, harus mengantarkannya (deposit) ke chest gudang DI DALAM rumah, bukan mengumpulkan lagi', async () => {
    const adapter = new FakeStorageAdapter({
      chests: {
        '-185,72,-352': { position: { x: -185, y: 72, z: -352 }, items: [] },
        '-200,64,-360': { position: { x: -200, y: 64, z: -360 }, items: [{ name: 'oak_log', count: 12 }] }
      },
      inventory: { cobblestone: 20 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const result = await engine.tick();

    assert.equal(result.action, 'deliver');
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0].position.x, -185);
    assert.equal(result.count, 20);
    assert.equal(engine.metrics.delivered, 20);
  });

  it('saat mengantar, harus MEMILIH chest dalam rumah yang isinya SUDAH cocok dengan barang terbawa, bukan chest dalam pertama sembarangan', async () => {
    const adapter = new FakeStorageAdapter({
      chests: {
        '-189,72,-352': { position: { x: -189, y: 72, z: -352 }, items: [{ name: 'dirt', count: 1 }] },
        '-185,72,-352': { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 3 }] }
      },
      inventory: { iron_ingot: 5 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const result = await engine.tick();

    assert.equal(result.action, 'deliver');
    assert.equal(result.deliveries[0].position.x, -185, 'harus pilih chest yang SUDAH berisi iron_ingot, bukan chest dirt yang ditemukan lebih dulu');
  });

  it('kalau membawa BEBERAPA jenis item sekaligus, tiap jenis harus diantar ke chest MASING-MASING yang cocok - bukan semua jenis ditumpuk ke SATU chest berdasarkan jenis item PERTAMA saja - ditemukan dari keluhan nyata pemilik: "did not short the item well"', async () => {
    const ironChest = { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 2 }] };
    const dirtChest = { position: { x: -186, y: 72, z: -352 }, items: [{ name: 'dirt', count: 1 }] };
    const adapter = new FakeStorageAdapter({
      chests: {
        '-185,72,-352': ironChest,
        '-186,72,-352': dirtChest
      },
      inventory: { iron_ingot: 3, dirt: 5 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const result = await engine.tick();

    assert.equal(result.action, 'deliver');
    assert.equal(result.deliveries.length, 2, 'harus ada DUA pengantaran terpisah, satu per jenis item');
    const ironDelivery = result.deliveries.find((d) => d.name === 'iron_ingot');
    const dirtDelivery = result.deliveries.find((d) => d.name === 'dirt');
    assert.equal(ironDelivery.position.x, -185, 'iron_ingot harus ke chest iron, bukan ikut ke chest dirt');
    assert.equal(ironDelivery.count, 3);
    assert.equal(dirtDelivery.position.x, -186, 'dirt harus ke chest dirt, bukan ikut tercampur ke chest iron');
    assert.equal(dirtDelivery.count, 5);
    // Isi chest masing-masing TIDAK BOLEH tercampur jenis lain.
    assert.ok(!ironChest.items.some((i) => i.name === 'dirt'), 'chest iron tidak boleh kemasukan dirt');
    assert.ok(!dirtChest.items.some((i) => i.name === 'iron_ingot'), 'chest dirt tidak boleh kemasukan iron_ingot');
  });

  it('harus MENGINGAT chest mana yang ditugaskan untuk suatu jenis item (bukan pilih sembarangan tiap kali) - dipakai supaya sortir konsisten walau chest tujuan kebetulan sedang kosong saat dicek - ditemukan dari keluhan nyata pemilik: kuartermaster "does not have any memory about storage chest"', async () => {
    const chestA = { position: { x: -185, y: 72, z: -352 }, items: [] };
    const chestB = { position: { x: -186, y: 72, z: -352 }, items: [] };
    const adapter = new FakeStorageAdapter({
      chests: { '-185,72,-352': chestA, '-186,72,-352': chestB },
      inventory: { stone: 4 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const first = await engine.tick();
    const assignedPos = first.deliveries[0].position;

    // Simulasikan pemain mengosongkan chest itu secara manual - isi chest sekarang KOSONG lagi,
    // jadi pencarian "chest yang sudah berisi jenis ini" tidak akan menemukan apa-apa. Tanpa
    // memori eksplisit, tick berikutnya bisa saja memilih chest LAIN secara sembarangan.
    adapter.chests[`${assignedPos.x},${assignedPos.y},${assignedPos.z}`].items = [];
    adapter.inventory.set('stone', 6);

    const second = await engine.tick();

    assert.equal(second.deliveries[0].position.x, assignedPos.x, 'jenis item yang sama harus tetap ke chest yang SAMA (dari memori), bukan chest lain yang kebetulan juga kosong');
  });

  it('harus menerima assignment awal (initialAssignments) supaya memori sortir bertahan lintas restart worker, dan mengekspos getChestAssignments() untuk disimpan lagi', async () => {
    const chestA = { position: { x: -185, y: 72, z: -352 }, items: [] };
    const chestB = { position: { x: -186, y: 72, z: -352 }, items: [] };
    const adapter = new FakeStorageAdapter({
      chests: { '-185,72,-352': chestA, '-186,72,-352': chestB },
      inventory: { stone: 4 }
    });
    const engine = new StorageManagerEngine({
      adapter,
      houseBounds: HOUSE_BOUNDS,
      initialAssignments: { stone: '-186,72,-352' }
    });

    const result = await engine.tick();

    assert.equal(result.deliveries[0].position.x, -186, 'harus ikuti assignment yang sudah dimuat dari sesi sebelumnya, bukan pilih chest pertama yang ditemukan');
    assert.deepEqual(engine.getChestAssignments(), { stone: '-186,72,-352' });
  });

  it('setelah semua chest luar dikumpulkan dan tangan kosong, harus memeriksa (inspect) chest DI DALAM rumah satu per satu', async () => {
    const adapter = new FakeStorageAdapter({
      chests: {
        '-185,72,-352': { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 3 }] }
      }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const result = await engine.tick();

    assert.equal(result.action, 'inspect');
    assert.equal(result.position.x, -185);
    assert.deepEqual(result.items, [{ name: 'iron_ingot', count: 3 }]);
    assert.equal(engine.metrics.inspected, 1);
  });

  it('chest dalam rumah yang sudah diperiksa TIDAK BOLEH diperiksa lagi di tick berikutnya (harus lanjut ke chest dalam berikutnya)', async () => {
    const adapter = new FakeStorageAdapter({
      chests: {
        '-185,72,-352': { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 3 }] },
        '-186,72,-352': { position: { x: -186, y: 72, z: -352 }, items: [{ name: 'gold_ingot', count: 1 }] }
      }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const first = await engine.tick();
    const second = await engine.tick();

    assert.equal(first.action, 'inspect');
    assert.equal(second.action, 'inspect');
    assert.notDeepEqual(first.position, second.position);
  });

  it('kalau tidak ada chest luar untuk dikumpulkan dan semua chest dalam sudah diperiksa, harus idle', async () => {
    const adapter = new FakeStorageAdapter({ chests: {} });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const result = await engine.tick();

    assert.equal(result.action, 'idle');
  });

  it('kalau chest tujuan pengantaran PENUH (depositToChest gagal/menolak), harus mengingat chest itu penuh dan coba chest gudang LAIN di tick berikutnya, bukan mengulang chest penuh yang sama selamanya - ditemukan dari bug live nyata: StorageWorker terjebak log "destination full" berulang-ulang tanpa progres karena selalu memilih chest penuh yang sama', async () => {
    const fullChest = { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 64 }] };
    const otherChest = { position: { x: -186, y: 72, z: -352 }, items: [] };
    const adapter = new FakeStorageAdapter({
      chests: {
        '-185,72,-352': fullChest,
        '-186,72,-352': otherChest
      },
      inventory: { iron_ingot: 5 }
    });
    // depositToChest KE chest penuh menolak (persis seperti chest.deposit() mineflayer nyata yang
    // reject dengan Error('destination full') saat slot chest habis).
    const originalDeposit = adapter.depositToChest.bind(adapter);
    adapter.depositToChest = async (pos, predicate) => {
      if (pos.x === -185) throw new Error('destination full');
      return originalDeposit(pos, predicate);
    };
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const first = await engine.tick();
    assert.equal(first.action, 'deliver_failed');

    const second = await engine.tick();
    assert.equal(second.action, 'deliver', 'tick kedua harus pilih chest LAIN (bukan chest penuh yang sama)');
    assert.equal(second.deliveries[0].position.x, -186);
    assert.equal(second.count, 5);
  });

  it('saat mengantar ke chest gudang, harus mendekat dari sisi BARAT chest itu (x lebih kecil) - permintaan nyata pemilik: sisi barat itu yang aksesnya lega, bukan mendekat dari sisi sembarangan yang pathfinder kebetulan pilih', async () => {
    const adapter = new FakeStorageAdapter({
      chests: { '-185,72,-352': { position: { x: -185, y: 72, z: -352 }, items: [] } },
      inventory: { cobblestone: 5 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    await engine.tick();

    const navigateAction = adapter.actions.find((a) => a.type === 'navigate');
    assert.ok(navigateAction, 'harus navigasi sebelum mengantar');
    assert.ok(navigateAction.position.x < -185, 'harus mendekat dari sisi BARAT (x LEBIH KECIL dari posisi chest), bukan dari x yang sama/lebih besar');
    assert.equal(navigateAction.position.y, 72);
    assert.equal(navigateAction.position.z, -352);
  });

  it('saat memeriksa (inspect) chest gudang, harus juga mendekat dari sisi BARAT chest itu', async () => {
    const adapter = new FakeStorageAdapter({
      chests: { '-185,72,-352': { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 1 }] } }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    await engine.tick();

    const navigateAction = adapter.actions.find((a) => a.type === 'navigate');
    assert.ok(navigateAction);
    assert.ok(navigateAction.position.x < -185, 'harus mendekat dari sisi BARAT juga saat memeriksa, bukan cuma saat mengantar');
  });

  it('kalau chest yang diperiksa berisi item yang assignment-nya menunjuk ke chest LAIN, harus PINDAHKAN item itu (bukan cuma catat/laporkan) - permintaan nyata pemilik: "jika ada ore atau ingot di peti yang salah silahkan di pindahkan"', async () => {
    // x -185 dan -183 SENGAJA beda 2 (bukan bersebelahan/double-chest) supaya tes ini murni
    // menguji reorganize antar chest yang BENAR-BENAR berbeda, bukan ke-trigger logika normalisasi
    // double-chest (lihat tes terpisah di bawah untuk kasus itu).
    const wrongChest = { position: { x: -183, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 8 }] };
    const oreChest = { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'dirt', count: 5 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-183,72,-352': wrongChest, '-185,72,-352': oreChest }
    });
    // Memori sortir sudah tahu iron_ingot SEHARUSNYA di oreChest (-185,...), bukan di wrongChest.
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS, initialAssignments: { iron_ingot: '-185,72,-352' } });

    const result = await engine.tick();

    assert.equal(result.action, 'reorganize');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].name, 'iron_ingot');
    assert.equal(result.items[0].count, 8);
    assert.ok(!wrongChest.items.some((i) => i.name === 'iron_ingot'), 'iron_ingot harus SUDAH DIAMBIL dari chest yang salah');

    // Tick berikutnya: item yang baru diambil sudah di tangan, harus diantar ke chest yang BENAR
    // lewat jalur deliver biasa (memakai assignment yang sama).
    const second = await engine.tick();
    assert.equal(second.action, 'deliver');
    assert.equal(second.deliveries[0].position.x, -185);
    assert.equal(second.deliveries[0].count, 8);
    assert.ok(oreChest.items.some((i) => i.name === 'iron_ingot' && i.count === 8), 'iron_ingot harus SUDAH SAMPAI di chest yang benar');
  });

  it('kalau SATU chest berisi BEBERAPA jenis item yang salah tempat sekaligus, harus ambil SEMUANYA dalam SATU kali kunjungan (bukan satu jenis per kunjungan) - ditemukan dari keluhan nyata pemilik ("banyak yang tidak sesuai"): dengan cuma satu item per kunjungan, membersihkan chest yang berisi puluhan barang salah tempat butuh puluhan tick bolak-balik (kalah prioritas sama deliver/collect tiap kali), jadi progresnya sangat lambat', async () => {
    const messyChest = {
      position: { x: -183, y: 71, z: -350 },
      items: [
        { name: 'enchanted_book', count: 3 },
        { name: 'iron_ingot', count: 8 },
        { name: 'dirt', count: 20 },
        { name: 'cobblestone', count: 10 }
      ]
    };
    const bookChest = { position: { x: -185, y: 71, z: -350 }, items: [] };
    const oreChest = { position: { x: -187, y: 71, z: -350 }, items: [] };
    const dirtChest = { position: { x: -189, y: 71, z: -350 }, items: [] };
    const adapter = new FakeStorageAdapter({
      chests: {
        '-183,71,-350': messyChest,
        '-185,71,-350': bookChest,
        '-187,71,-350': oreChest,
        '-189,71,-350': dirtChest
      }
    });
    const engine = new StorageManagerEngine({
      adapter,
      houseBounds: HOUSE_BOUNDS,
      initialAssignments: {
        enchanted_book: '-185,71,-350',
        iron_ingot: '-187,71,-350',
        dirt: '-189,71,-350'
        // cobblestone SENGAJA tidak punya assignment - harus DIBIARKAN (tidak ada info rumah yang benar).
      }
    });

    const result = await engine.tick();

    assert.equal(result.action, 'reorganize');
    assert.equal(result.items.length, 3, 'harus ambil SEMUA 3 jenis yang punya assignment jelas dalam satu kunjungan (bukan cuma 1)');
    const names = result.items.map((i) => i.name).sort();
    assert.deepEqual(names, ['dirt', 'enchanted_book', 'iron_ingot']);
    assert.ok(messyChest.items.some((i) => i.name === 'cobblestone'), 'cobblestone TIDAK BOLEH ikut diambil - tidak ada assignment jelas untuk itu');
    assert.ok(!messyChest.items.some((i) => i.name === 'enchanted_book' || i.name === 'iron_ingot' || i.name === 'dirt'), 'ketiga item yang punya assignment harus SUDAH terambil semua');
  });

  it('chest yang isinya SUDAH sesuai assignment (tidak ada yang salah tempat) harus diperiksa normal (inspect), bukan dianggap perlu dipindah', async () => {
    const adapter = new FakeStorageAdapter({
      chests: { '-185,72,-352': { position: { x: -185, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 8 }] } }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS, initialAssignments: { iron_ingot: '-185,72,-352' } });

    const result = await engine.tick();

    assert.equal(result.action, 'inspect');
    assert.equal(engine.metrics.inspected, 1);
  });

  it('DOUBLE CHEST: dua blok chest yang bersebelahan (x berbeda 1, y/z sama) adalah SATU wadah fisik yang sama - item di sana TIDAK BOLEH dianggap "salah tempat" hanya karena assignment-nya mencatat koordinat blok SEBELAH (separuh chest yang lain)', async () => {
    const halfA = { position: { x: -181, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 8 }] };
    const halfB = { position: { x: -180, y: 72, z: -352 }, items: [{ name: 'iron_ingot', count: 8 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,72,-352': halfA, '-180,72,-352': halfB }
    });
    const HOUSE = { min: { x: -190, y: 70, z: -355 }, max: { x: -179, y: 76, z: -348 } };
    // Assignment mencatat separuh -181 sebagai rumah iron_ingot yang benar. Chest yang akan
    // DIPERIKSA lebih dulu (findChestPositions urutan objek) adalah separuh -181 itu sendiri -
    // TIDAK masalah karena keynya identik. Tes ini fokus ke kasus assignment BEDA separuh dari
    // yang sedang diperiksa (lihat setup di bawah, assignment pakai key separuh -180).
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE, initialAssignments: { iron_ingot: '-180,72,-352' } });

    const result = await engine.tick();

    assert.notEqual(result.action, 'reorganize', 'separuh chest yang lain BUKAN "chest lain" - itu wadah fisik yang SAMA, jangan dipindah-pindah sia-sia');
  });

  it('BARREL: barel yang bersebelahan PERSIS 1 blok dengan chest ("barel di antara chest" - permintaan nyata pemilik) TIDAK BOLEH dianggap wadah yang sama seperti double-chest - barel SELALU wadah tunggal, tidak pernah gabung fisik dengan blok lain walau posisinya bersebelahan', async () => {
    const chestPos = { x: -181, y: 71, z: -352 };
    const barrelPos = { x: -181, y: 71, z: -351 }; // persis 1 blok bersebelahan (z beda 1)
    const chest = { position: chestPos, items: [{ name: 'iron_ingot', count: 8 }], blockType: 'chest' };
    const barrel = { position: barrelPos, items: [{ name: 'iron_ingot', count: 4 }], blockType: 'barrel' };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,71,-352': chest, '-181,71,-351': barrel }
    });
    const HOUSE = { min: { x: -190, y: 70, z: -355 }, max: { x: -179, y: 76, z: -348 } };
    // Assignment mencatat chest sebagai rumah iron_ingot yang benar - barel BUKAN bagian dari
    // chest itu (walau bersebelahan persis), jadi iron_ingot di barel harus dianggap SALAH TEMPAT
    // dan dipindahkan, BUKAN dianggap "sudah di rumah yang sama" seperti kasus double-chest.
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE, initialAssignments: { iron_ingot: '-181,71,-352' } });

    // Chest sungguhan (bukan barel) diperiksa dulu (posisi pertama di object) - tidak ada yang
    // salah tempat di sana, jadi tick pertama harus 'inspect' biasa untuk chest itu.
    const first = await engine.tick();
    assert.equal(first.action, 'inspect');

    // Tick kedua memeriksa barel - iron_ingot di dalamnya HARUS terdeteksi salah tempat (barel
    // bukan bagian dari chest sebelahnya), bukan dilewati begitu saja.
    const second = await engine.tick();
    assert.equal(second.action, 'reorganize', 'barel bukan bagian dari chest sebelahnya - isinya yang salah tempat harus tetap dipindahkan');
  });

  it('kalau item SUDAH punya assignment tapi chest rumahnya kebetulan lagi PENUH, dan TIDAK ADA chest lain yang cocok isinya atau benar-benar kosong (semua chest lain sudah berisi kategori LAIN) - JANGAN paksa ke chest sembarangan, biarkan menunggu (skip tick ini), bukan MENIMPA memori sortir yang sudah benar - ditemukan dari bug live nyata: dirt yang sudah benar terdaftar ke chest dirt malah ke-timpa jadi menunjuk ke chest buku (yang BUKAN kosong, sudah berisi enchanted_book) hanya karena chest dirt-nya kebetulan lagi penuh saat itu', async () => {
    const dirtHomeChest = { position: { x: -181, y: 74, z: -352 }, items: [] };
    // Chest buku BUKAN kosong (sudah berisi kategori lain) - jalur "chest kosong aman" TIDAK
    // berlaku di sini, persis situasi nyata yang menyebabkan bug (fallback "asal-asalan" dipakai).
    const booksChest = { position: { x: -181, y: 71, z: -350 }, items: [{ name: 'enchanted_book', count: 3 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,74,-352': dirtHomeChest, '-181,71,-350': booksChest },
      inventory: { dirt: 10 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS, initialAssignments: { dirt: '-181,74,-352' } });
    // Simulasikan chest rumah dirt kebetulan lagi penuh SAAT INI (mis. gara-gara item lain gagal
    // disetor ke sana barusan) - bukan berarti dirt tidak boleh pulang ke sana lagi SELAMANYA.
    engine.fullChestPositions.add('-181,74,-352');

    const result = await engine.tick();

    // Menyerah untuk PENGANTARAN tick ini (tidak dipaksa ke chest buku) - tapi boleh (dan memang
    // harus) lanjut mengerjakan hal lain seperti inspect selama menunggu (lihat tes "TOTAL
    // PARALYSIS" di bawah), jadi actionnya BUKAN lagi mesti 'idle' persis.
    assert.notEqual(result.action, 'deliver', 'harus menyerah untuk pengantaran tick ini (bukan malah dorong ke chest buku)');
    assert.equal(engine.getChestAssignments().dirt, '-181,74,-352', 'memori sortir dirt HARUS TETAP ke chest yang benar, tidak boleh tertimpa jadi chest buku');
    assert.ok(!booksChest.items.some((i) => i.name === 'dirt'), 'dirt tidak boleh nyasar ke chest buku');
  });

  it('kalau item SUDAH punya assignment tapi rumahnya penuh, dan ADA chest lain yang genuinely kosong (bukan kategori lain) - boleh dipakai sebagai tujuan sementara (ini beda dari fallback "asal-asalan" - chest kosong aman dipakai siapapun)', async () => {
    const homeChest = { position: { x: -181, y: 74, z: -352 }, items: [] };
    const emptyChest = { position: { x: -181, y: 71, z: -350 }, items: [] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,74,-352': homeChest, '-181,71,-350': emptyChest },
      inventory: { dirt: 10 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS, initialAssignments: { dirt: '-181,74,-352' } });
    engine.fullChestPositions.add('-181,74,-352');

    const result = await engine.tick();

    assert.equal(result.action, 'deliver');
    assert.equal(result.deliveries[0].position.x, -181);
    assert.equal(result.deliveries[0].position.z, -350);
    // Chest kosong itu HANYA tujuan SEMENTARA untuk pengantaran ini - memori sortir permanen
    // (chestAssignments) TIDAK BOLEH ikut tertimpa ke sana, atau rumah asli yang benar akan
    // hilang begitu saja - ditemukan dari bug live nyata (lihat tes bouncing-loop di bawah):
    // rotten_flesh bolak-balik TANPA HENTI antara dua chest karena assignment permanennya
    // ke-timpa oleh chest kosong yang cuma dimaksudkan sebagai solusi sementara.
    assert.equal(engine.getChestAssignments().dirt, '-181,74,-352', 'rumah ASLI harus tetap tercatat, bukan tertimpa jadi chest kosong sementara itu');
  });

  it('BOUNCING LOOP: kalau rumah asli MASIH penuh, item yang baru ditaruh di chest kosong sementara TIDAK BOLEH langsung ditandai "salah tempat" lagi - ditemukan dari bug live nyata: rotten_flesh bolak-balik TANPA HENTI 2+ menit antara dua chest karena reorganize terus mencoba memindahkannya kembali ke rumah yang TERNYATA MASIH penuh, gagal, balik lagi ke sementara, dianggap salah tempat lagi... berulang selamanya', async () => {
    const homeChest = { position: { x: -181, y: 71, z: -349 }, items: [] };
    const tempEmptyChest = { position: { x: -180, y: 71, z: -344 }, items: [{ name: 'rotten_flesh', count: 13 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,71,-349': homeChest, '-180,71,-344': tempEmptyChest }
    });
    const WIDE_HOUSE = { min: { x: -190, y: 70, z: -360 }, max: { x: -179, y: 76, z: -340 } };
    const engine = new StorageManagerEngine({ adapter, houseBounds: WIDE_HOUSE, initialAssignments: { rotten_flesh: '-181,71,-349' } });
    // Rumah asli MASIH penuh (belum ada ruang) - reorganize TIDAK ADA GUNANYA mencoba memindah
    // rotten_flesh ke sana sekarang, itu cuma akan gagal dan mubazir (nanti balik lagi ke sini).
    engine.fullChestPositions.add('-181,71,-349');

    const result = await engine.tick();

    assert.notEqual(result.action, 'reorganize', 'jangan coba pindahkan ke rumah yang diketahui MASIH penuh - itu penyebab bolak-balik tanpa henti');
  });

  it('begitu rumah asli TIDAK LAGI penuh, item yang sempat ditaruh sementara BOLEH dipindah kembali (satu kali, bukan bolak-balik)', async () => {
    const homeChest = { position: { x: -181, y: 71, z: -349 }, items: [] };
    const tempEmptyChest = { position: { x: -180, y: 71, z: -344 }, items: [{ name: 'rotten_flesh', count: 13 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,71,-349': homeChest, '-180,71,-344': tempEmptyChest }
    });
    const WIDE_HOUSE = { min: { x: -190, y: 70, z: -360 }, max: { x: -179, y: 76, z: -340 } };
    const engine = new StorageManagerEngine({ adapter, houseBounds: WIDE_HOUSE, initialAssignments: { rotten_flesh: '-181,71,-349' } });
    // Rumah asli SUDAH TIDAK penuh lagi sekarang - kali ini reorganize memang harus jalan.
    // (chest rumah diperiksa dulu - kosong, tidak ada yang salah - baru chest sementara berikutnya)

    await engine.tick(); // memeriksa homeChest (kosong, tidak ada yang salah tempat)
    const result = await engine.tick(); // memeriksa tempEmptyChest - di sinilah rotten_flesh ditemukan

    assert.equal(result.action, 'reorganize');
    assert.equal(result.items[0].name, 'rotten_flesh');
  });

  it('kalau item SUDAH punya assignment tapi rumahnya penuh, JANGAN percaya chest LAIN yang KEBETULAN sudah berisi jenis yang sama (leftover salah tempat dari sesi lama) sebagai "sudah cocok" - itu jalur korupsi yang SAMA persis, cuma lewat pencocokan isi bukan fallback asal-asalan - ditemukan dari bug live nyata: leather_chestplate yang assignment-nya sudah benar ke chest armor malah diantar ke chest buku karena chest buku itu MASIH menyimpan leather_chestplate nyasar dari korupsi sebelumnya, dan pencocokan isi keliru menganggap itu tujuan yang valid', async () => {
    const armorChest = { position: { x: -181, y: 71, z: -345 }, items: [] };
    // Chest buku ini BUKAN kosong DAN kebetulan masih ada leftover leather_chestplate dari
    // korupsi lama - godaan untuk pencocokan isi menganggapnya "sudah cocok, pakai saja".
    const staleBooksChest = { position: { x: -181, y: 71, z: -350 }, items: [{ name: 'enchanted_book', count: 2 }, { name: 'leather_chestplate', count: 1 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,71,-345': armorChest, '-181,71,-350': staleBooksChest },
      inventory: { leather_chestplate: 1 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS, initialAssignments: { leather_chestplate: '-181,71,-345' } });
    engine.fullChestPositions.add('-181,71,-345');

    const result = await engine.tick();

    assert.notEqual(result.action, 'deliver', 'tidak boleh berhasil mengantar ke chest buku yang salah - harus menyerah (idle/deliver_failed) sampai chest armor tersedia lagi');
    if (result.deliveries) {
      assert.ok(!result.deliveries.some((d) => d.position.z === -350), 'leather_chestplate TIDAK BOLEH diantar ke chest buku');
    }
  });

  it('kalau membuka chest LUAR gagal total (mis. windowOpen timeout - bukan "penuh", genuinely tidak bisa dibuka), harus tandai chest itu SUDAH DICOBA dan lanjut ke chest lain - JANGAN ulangi chest yang sama selamanya - ditemukan dari bug live nyata: StorageWorker macet 5+ menit mengulang chest luar yang sama gara-gara error saat buka chest tidak pernah menandai posisi itu "selesai", jadi tick berikutnya memilih chest yang PERSIS SAMA lagi', async () => {
    const brokenPos = { x: -200, y: 64, z: -360 };
    const workingChest = { position: { x: -201, y: 64, z: -360 }, items: [{ name: 'oak_log', count: 5 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-201,64,-360': workingChest }
    });
    adapter.findChestPositions = () => [brokenPos, workingChest.position];
    const originalWithdrawAll = adapter.withdrawAllFromChest.bind(adapter);
    adapter.withdrawAllFromChest = async (pos) => {
      if (pos.x === -200) throw new Error('Event windowOpen did not fire within timeout of 20000ms');
      return originalWithdrawAll(pos);
    };
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const first = await engine.tick();
    assert.equal(first.action, 'error');
    assert.equal(first.position.x, -200);

    // Tick berikutnya HARUS pindah ke chest lain, BUKAN mencoba chest -200 yang sama lagi.
    const second = await engine.tick();
    assert.equal(second.action, 'collect');
    assert.equal(second.position.x, -201);
  });

  it('kalau membuka chest DALAM (gudang) gagal total saat inspect/reorganize, harus tandai sudah dicoba dan lanjut ke chest lain juga', async () => {
    const brokenPos = { x: -181, y: 72, z: -352 };
    const workingChest = { position: { x: -181, y: 71, z: -352 }, items: [{ name: 'stone', count: 5 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,71,-352': workingChest }
    });
    adapter.findChestPositions = () => [brokenPos, workingChest.position];
    const originalGetContents = adapter.getChestContents.bind(adapter);
    adapter.getChestContents = async (pos) => {
      if (pos.y === 72) throw new Error('Event windowOpen did not fire within timeout of 20000ms');
      return originalGetContents(pos);
    };
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const first = await engine.tick();
    assert.equal(first.action, 'error');
    assert.equal(first.position.y, 72);

    const second = await engine.tick();
    assert.notEqual(second.action, 'error');
    assert.equal(second.position.y, 71);
  });

  it('kalau chest gudang GAGAL DIBUKA saat resolveChestForItem sedang mencari tujuan pengantaran (pencocokan isi/chest kosong - BUKAN lewat jalur inspect/reorganize), harus lewati chest itu (bukan crash total) - ditemukan dari bug live nyata: worker tetap macet 5+ menit walau collect/inspect sudah dijaga, karena error yang SAMA juga bisa muncul dari dalam resolveChestForItem (dipanggil tiap kali mengantar barang, jauh lebih sering daripada collect/inspect) yang belum dijaga sama sekali', async () => {
    const brokenChest = { position: { x: -181, y: 72, z: -352 }, items: [] };
    const goodChest = { position: { x: -181, y: 71, z: -352 }, items: [] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,72,-352': brokenChest, '-181,71,-352': goodChest },
      inventory: { dirt: 5 }
    });
    const originalGetContents = adapter.getChestContents.bind(adapter);
    adapter.getChestContents = async (pos) => {
      if (pos.y === 72) throw new Error('Event windowOpen did not fire within timeout of 20000ms');
      return originalGetContents(pos);
    };
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS });

    const result = await engine.tick();

    assert.equal(result.action, 'deliver', 'harus tetap berhasil mengantar ke chest yang BAIK, bukan crash gara-gara satu chest lain gagal dibuka');
    assert.equal(result.deliveries[0].position.y, 71);
  });

  it('2-TICK OSCILLATION: kalau HANYA membawa satu jenis item dan rumahnya PENUH tanpa alternatif aman, JANGAN mengulang percobaan ke chest PERSIS SAMA setiap tick - ditemukan dari keluhan nyata pemilik: "storage worker hanya membuka-buka chest saja tidak memindahkan barang apapun" - root cause: reset fullChestPositions yang kelewat agresif (tiap kali SATU item kebetulan buntu) membuat tandai-penuh baru saja dipasang langsung terhapus lagi tick berikutnya, jadi chest yang SAMA dicoba lagi dan gagal lagi, selamanya', async () => {
    const fullHome = { position: { x: -181, y: 71, z: -352 }, items: [{ name: 'cobblestone', count: 64 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,71,-352': fullHome },
      inventory: { cobblestone: 31 }
    });
    // depositToChest ke chest ini SELALU gagal (persis "destination full" nyata) - tidak ada
    // chest lain sama sekali sebagai alternatif (skenario nyata: cuma satu chest kategori itu).
    adapter.depositToChest = async () => { throw new Error('destination full'); };
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS, initialAssignments: { cobblestone: '-181,71,-352' } });

    const first = await engine.tick(); // percobaan pertama - gagal, chest ditandai penuh
    assert.equal(first.action, 'deliver_failed');

    // Tick BERIKUTNYA (langsung sesudahnya) TIDAK BOLEH mencoba chest yang sama lagi - itu berarti
    // tandai-penuhnya ke-reset sebelum waktunya (persis bug 2-tick yang dilaporkan pemilik).
    const second = await engine.tick();
    assert.notEqual(second.action, 'deliver_failed', 'kalau ini "deliver_failed" lagi PERSIS di tick berikutnya, berarti dia mencoba chest yang sama lagi - tandai-penuh ke-reset terlalu cepat');
  });

  it('TOTAL PARALYSIS: kalau item di tangan SAMA SEKALI tidak punya tujuan (rumahnya penuh, tanpa alternatif), engine HARUS tetap lanjut collect/inspect - JANGAN diam menunggu selamanya - ditemukan dari keluhan nyata pemilik: "storage worker hanya membuka-buka chest saja tidak memindahkan barang apapun" (versi lebih parah: bot berhenti TOTAL, tidak collect atau inspect apapun, gara-gara satu item di tangan yang buntu)', async () => {
    const fullHome = { position: { x: -181, y: 71, z: -352 }, items: [{ name: 'cobblestone', count: 64 }] };
    const outsideChest = { position: { x: -200, y: 64, z: -360 }, items: [{ name: 'oak_log', count: 5 }] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,71,-352': fullHome, '-200,64,-360': outsideChest },
      inventory: { cobblestone: 31 }
    });
    adapter.depositToChest = async () => { throw new Error('destination full'); };
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS, initialAssignments: { cobblestone: '-181,71,-352' } });

    await engine.tick(); // percobaan pertama - gagal, chest ditandai penuh
    const second = await engine.tick();

    // Item di tangan MASIH ada (tidak pernah terkirim) DAN masih tidak punya tujuan - tapi bot
    // TIDAK BOLEH diam saja, harus lanjut kumpulkan chest luar yang tersedia.
    assert.equal(second.action, 'collect', 'bot harus tetap produktif (collect chest luar) walau ada satu item buntu di tangan, bukan diam total menunggu');
  });

  it('brokenPositions HARUS di-reset secara berkala (sama seperti fullChestPositions) - JANGAN memblokir chest selamanya gara-gara SATU kegagalan buka yang sifatnya sementara (lag server) - ditemukan dari keluhan nyata pemilik: diamond & iron_ingot (yang rumahnya sudah lama mapan) berhenti total terkirim setelah sesi berjalan lama, karena chest tujuannya pernah SEKALI gagal dibuka (windowOpen timeout sesaat) dan sejak itu dikecualikan PERMANEN, padahal chest itu sebenarnya baik-baik saja', async () => {
    const oreChest = { position: { x: -181, y: 74, z: -353 }, items: [] };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,74,-353': oreChest },
      inventory: { diamond: 4 }
    });
    const engine = new StorageManagerEngine({ adapter, houseBounds: HOUSE_BOUNDS, initialAssignments: { diamond: '-181,74,-353' } });
    // Simulasikan chest ini PERNAH gagal dibuka sekali (mis. lag server sesaat) - ditandai rusak.
    engine.brokenPositions.add('-181,74,-353');

    const first = await engine.tick();
    assert.notEqual(first.action, 'deliver', 'tick ini memang harus gagal dulu (chest masih ditandai rusak)');

    // Setelah SATU putaran penuh (tidak ada collect/inspect lain yang tersisa), brokenPositions
    // harus di-reset - chest yang tadinya ditandai rusak harus dicoba lagi, BUKAN dikecualikan
    // selamanya.
    let delivered = false;
    for (let i = 0; i < 5 && !delivered; i++) {
      const result = await engine.tick();
      if (result.action === 'deliver') delivered = true;
    }
    assert.ok(delivered, 'diamond harus akhirnya berhasil terkirim setelah brokenPositions di-reset - chest itu sebenarnya baik-baik saja, cuma pernah gagal sesaat');
  });

  it('OVERFLOW DARURAT: item harus tetap diantar ke chest UTAMA kalau masih ada ruang - overflow HANYA dipakai kalau chest utama BENAR-BENAR penuh, bukan rumah kedua yang setara - permintaan nyata pemilik: "make the overflow chest is for emergency only when the actual cest is full"', async () => {
    const primaryChest = { position: { x: -181, y: 74, z: -353 }, items: [{ name: 'iron_ingot', count: 10 }] };
    const overflowChest = { position: { x: -181, y: 74, z: -344 }, items: [] };
    const WIDE_HOUSE = { min: { x: -190, y: 70, z: -360 }, max: { x: -179, y: 76, z: -340 } };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,74,-353': primaryChest, '-181,74,-344': overflowChest },
      inventory: { diamond: 4 }
    });
    const engine = new StorageManagerEngine({
      adapter,
      houseBounds: WIDE_HOUSE,
      initialAssignments: { diamond: '-181,74,-353' },
      overflowChests: { '-181,74,-353': '-181,74,-344' }
    });

    const result = await engine.tick();

    assert.equal(result.action, 'deliver');
    assert.equal(result.deliveries[0].position.x, -181);
    assert.equal(result.deliveries[0].position.z, -353, 'chest utama MASIH ada ruang - harus tetap ke sana, BUKAN langsung ke overflow');
    assert.ok(!overflowChest.items.some((i) => i.name === 'diamond'), 'overflow tidak boleh dipakai kalau chest utama belum benar-benar penuh');
  });

  it('OVERFLOW DARURAT: begitu chest UTAMA benar-benar penuh, HARUS beralih ke overflow yang sudah didaftarkan secara spesifik untuknya - tanpa menimpa memori sortir permanen (item tetap "milik" chest utama untuk sesi berikutnya)', async () => {
    const primaryChest = { position: { x: -181, y: 74, z: -353 }, items: [{ name: 'iron_ingot', count: 64 }] };
    const overflowChest = { position: { x: -181, y: 74, z: -344 }, items: [] };
    const WIDE_HOUSE = { min: { x: -190, y: 70, z: -360 }, max: { x: -179, y: 76, z: -340 } };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,74,-353': primaryChest, '-181,74,-344': overflowChest },
      inventory: { diamond: 4 }
    });
    adapter.depositToChest = async (pos, predicate) => {
      if (pos.x === -181 && pos.z === -353) throw new Error('destination full');
      const chest = adapter.chests[`${pos.x},${pos.y},${pos.z}`];
      let deposited = 0;
      for (const [name, count] of Array.from(adapter.inventory.entries())) {
        if (!predicate({ name, count })) continue;
        if (chest) chest.items.push({ name, count });
        deposited += count;
        adapter.inventory.delete(name);
      }
      return { deposited };
    };
    const engine = new StorageManagerEngine({
      adapter,
      houseBounds: WIDE_HOUSE,
      initialAssignments: { diamond: '-181,74,-353' },
      overflowChests: { '-181,74,-353': '-181,74,-344' }
    });

    const first = await engine.tick(); // chest utama penuh - gagal, ditandai penuh
    assert.equal(first.action, 'deliver_failed');

    const second = await engine.tick(); // tick berikutnya harus beralih ke overflow yang terdaftar
    assert.equal(second.action, 'deliver');
    assert.equal(second.deliveries[0].position.z, -344, 'harus beralih ke overflow yang SUDAH didaftarkan untuk chest utama ini');
    // Memori sortir permanen TETAP menunjuk ke chest utama - overflow cuma solusi darurat kali ini.
    assert.equal(engine.getChestAssignments().diamond, '-181,74,-353');
  });

  it('OVERFLOW DARURAT: dua jenis item BERBEDA yang berbagi chest utama sama-sama penuh harus BISA sama-sama numpang di overflow terdaftar yang SAMA - bukan cuma satu jenis pertama yang kebetulan dapat tempat (fallback "chest kosong" generik gagal begitu overflow sudah kemasukan jenis lain - overflowChests eksplisit harus tetap bisa dipakai siapa saja yang terdaftar untuknya)', async () => {
    const primaryChest = { position: { x: -181, y: 74, z: -353 }, items: [{ name: 'iron_ingot', count: 64 }] };
    const overflowChest = { position: { x: -181, y: 74, z: -344 }, items: [{ name: 'diamond', count: 4 }] }; // sudah kemasukan diamond duluan
    const WIDE_HOUSE = { min: { x: -190, y: 70, z: -360 }, max: { x: -179, y: 76, z: -340 } };
    const adapter = new FakeStorageAdapter({
      chests: { '-181,74,-353': primaryChest, '-181,74,-344': overflowChest },
      inventory: { copper_ingot: 5 }
    });
    adapter.depositToChest = async (pos, predicate) => {
      if (pos.x === -181 && pos.z === -353) throw new Error('destination full');
      const chest = adapter.chests[`${pos.x},${pos.y},${pos.z}`];
      let deposited = 0;
      for (const [name, count] of Array.from(adapter.inventory.entries())) {
        if (!predicate({ name, count })) continue;
        if (chest) chest.items.push({ name, count });
        deposited += count;
        adapter.inventory.delete(name);
      }
      return { deposited };
    };
    const engine = new StorageManagerEngine({
      adapter,
      houseBounds: WIDE_HOUSE,
      // copper_ingot juga sudah mapan ke chest utama yang SAMA (persis skenario nyata: banyak
      // jenis ore/ingot berbagi satu chest utama).
      initialAssignments: { copper_ingot: '-181,74,-353' },
      overflowChests: { '-181,74,-353': '-181,74,-344' }
    });

    const first = await engine.tick();
    assert.equal(first.action, 'deliver_failed');

    const second = await engine.tick();
    assert.equal(second.action, 'deliver', 'copper_ingot HARUS tetap bisa numpang di overflow yang sama walau sudah ada diamond di sana - overflow eksplisit bukan "chest kosong" generik yang cuma muat satu jenis');
    assert.equal(second.deliveries[0].position.z, -344);
  });
});
