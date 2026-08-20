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
  async depositToChest(pos) {
    this.actions.push({ type: 'deposit', position: pos });
    return { deposited: 0 };
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
