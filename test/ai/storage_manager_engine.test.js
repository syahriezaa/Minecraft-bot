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
    assert.equal(result.position.x, -185);
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
    assert.equal(result.position.x, -185, 'harus pilih chest yang SUDAH berisi iron_ingot, bukan chest dirt yang ditemukan lebih dulu');
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
});
