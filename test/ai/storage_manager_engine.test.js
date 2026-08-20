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

    assert.equal(result.action, 'idle', 'harus menyerah untuk tick ini (bukan malah dorong ke chest buku)');
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
  });
});
