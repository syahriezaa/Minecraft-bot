const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { GearRepairEngine } = require('../../src/ai/gearRepairEngine');

class FakeGearAdapter {
  constructor({ armor = {}, items = {}, chestIron = 0, craftSucceedsIf = () => true } = {}) {
    this.armor = { head: null, torso: null, legs: null, feet: null, ...armor };
    this.items = new Map(Object.entries(items));
    this.chestIron = chestIron;
    this.craftSucceedsIf = craftSucceedsIf;
    this.actions = [];
  }
  getEquippedArmor() { return this.armor; }
  hasItem(names) {
    const list = Array.isArray(names) ? names : [names];
    return list.some(name => (this.items.get(name) || 0) > 0);
  }
  async equipItem(name, dest) {
    this.actions.push({ type: 'equip', name, dest });
    this.armor[Object.keys(this.armor).find(k => dest === k) || dest] = name;
    return true;
  }
  async craftItem(itemName) {
    this.actions.push({ type: 'craft', itemName });
    if (this.craftSucceedsIf(itemName, this.items.get('iron_ingot') || 0)) {
      this.items.set(itemName, (this.items.get(itemName) || 0) + 1);
      return true;
    }
    return false;
  }
  async findMatchingChest(itemNames) {
    this.actions.push({ type: 'findMatchingChest', itemNames });
    return this.chestIron > 0 ? { x: 1, y: 64, z: 1 } : null;
  }
  async withdrawFromChest(pos, itemNames, count) {
    const take = Math.min(count, this.chestIron);
    this.chestIron -= take;
    this.items.set('iron_ingot', (this.items.get('iron_ingot') || 0) + take);
    this.actions.push({ type: 'withdraw', pos, itemNames, count: take });
    return { withdrawn: take };
  }
}

describe('GearRepairEngine - perbaiki gear yang hilang/rusak dengan craft dari iron di gudang', () => {
  it('kalau semua slot armor terisi, tidak melakukan apapun', async () => {
    const adapter = new FakeGearAdapter({ armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } });
    const engine = new GearRepairEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'idle');
    assert.equal(adapter.actions.length, 0);
  });

  it('kalau ada slot kosong dan SUDAH punya cadangan piece itu di inventaris, langsung equip - tidak perlu craft/ambil bahan', async () => {
    const adapter = new FakeGearAdapter({ armor: { head: null, torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }, items: { iron_helmet: 1 } });
    const engine = new GearRepairEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'repair');
    assert.equal(result.piece, 'iron_helmet');
    assert.deepEqual(adapter.actions, [{ type: 'equip', name: 'iron_helmet', dest: 'head' }]);
  });

  it('kalau slot kosong dan bahan iron di inventaris SUDAH cukup, craft lalu equip langsung - tidak perlu ke gudang', async () => {
    const adapter = new FakeGearAdapter({ armor: { head: 'iron_helmet', torso: null, legs: 'iron_leggings', feet: 'iron_boots' }, items: { iron_ingot: 8 } });
    const engine = new GearRepairEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'repair');
    assert.equal(result.piece, 'iron_chestplate');
    const types = adapter.actions.map(a => a.type);
    assert.deepEqual(types, ['craft', 'equip']);
  });

  it('kalau craft gagal (bahan kurang) tapi ADA chest gudang berisi iron, ambil iron dulu dari gudang - belum craft di tick ini', async () => {
    const adapter = new FakeGearAdapter({ armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: null, feet: 'iron_boots' }, chestIron: 10, craftSucceedsIf: () => false });
    const engine = new GearRepairEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'gather_iron');
    assert.equal(result.count, 7); // iron_leggings butuh 7
    const types = adapter.actions.map(a => a.type);
    assert.deepEqual(types, ['craft', 'findMatchingChest', 'withdraw']);
  });

  it('kalau tidak ada iron sama sekali (gudang juga kosong), lewati piece itu dan idle - jangan macet mencoba berulang tanpa hasil', async () => {
    const adapter = new FakeGearAdapter({ armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: null }, chestIron: 0, craftSucceedsIf: () => false });
    const engine = new GearRepairEngine({ adapter });

    const result = await engine.tick();

    assert.equal(result.action, 'idle');
  });
});
