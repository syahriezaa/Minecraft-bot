const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storageSources, supplyStorageMaterial } = require('../../src/ai/storageRoomMaterials');

function setup(stock = {}, initial = {}) {
  const inventory = { ...initial };
  const visited = [];
  const crafts = [];
  const adapter = {
    getItemCount: name => inventory[name] || 0,
    withdrawFromChest: async (pos, names, count) => {
      const key = `${pos.x},${pos.y},${pos.z}`;
      visited.push(key);
      const contents = stock[key] || {};
      const name = names.find(item => contents[item] > 0);
      const amount = name ? Math.min(count, contents[name]) : 0;
      if (name) { contents[name] -= amount; inventory[name] = (inventory[name] || 0) + amount; }
      return { withdrawn: amount };
    },
    craftItem: async (name, recipes) => {
      crafts.push({ name, recipes });
      const materials = name === 'stone_bricks' ? { stone: 4 } : name === 'chest' ? { oak_planks: 8 } :
        name === 'oak_door' ? { oak_planks: 6 } : name === 'torch' ? { coal: 1, stick: 1 } : name === 'stick' ? { oak_planks: 2 } : { oak_log: 1 };
      for (const [item, count] of Object.entries(materials)) {
        assert.ok(inventory[item] >= count * recipes, `insufficient ${item}`);
        inventory[item] -= count * recipes;
      }
      inventory[name] = (inventory[name] || 0) + recipes * (name === 'chest' ? 1 : name === 'oak_door' ? 3 : 4);
      return true;
    }
  };
  return { adapter, inventory, visited, crafts };
}

test('stone visits all mapped overflow chests in order without duplicate halves', () => {
  assert.deepEqual(storageSources(['stone']).map(p => `${p.x},${p.y},${p.z}`), [
    '-181,71,-352', '-181,73,-344', '-181,73,-348', '-181,73,-346', '-181,72,-346', '-181,74,-348'
  ]);
});

test('stone in later overflow is crafted before smelting is considered', async () => {
  const state = setup({ '-181,73,-348': { stone: 64 } });
  const result = await supplyStorageMaterial({ ...state, name: 'stone_bricks', required: 64,
    smelt: async () => { throw new Error('must not smelt existing stone'); } });
  assert.deepEqual(result, { available: 64, added: 64, missing: 0 });
  assert.deepEqual(state.crafts, [{ name: 'stone_bricks', recipes: 16 }]);
  assert.ok(!state.visited.includes('-181,73,-346'));
});

test('builder dapat mengambil material jadi tanpa ikut smelting atau crafting', async () => {
  const state = setup({ '-181,73,-352': { stone_bricks: 12 }, '-181,71,-352': { stone: 64, cobblestone: 64 } });
  let smelted = false;
  const result = await supplyStorageMaterial({ ...state, name: 'stone_bricks', required: 32,
    allowProcessing: false, smelt: async () => { smelted = true; return 0; } });
  assert.equal(result.available, 12);
  assert.equal(result.missing, 20);
  assert.equal(smelted, false);
  assert.deepEqual(state.crafts, []);
});

test('crafts double-chest materials from mapped logs when planks are empty', async () => {
  const state = setup({ '-181,74,-347': { oak_log: 4 } });
  const result = await supplyStorageMaterial({ ...state, name: 'chest', required: 2 });
  assert.equal(result.available, 2);
  assert.equal(state.inventory.oak_planks, 0);
  assert.deepEqual(state.crafts, [{ name: 'oak_planks', recipes: 4 }, { name: 'chest', recipes: 2 }]);
});

test('crafts entrance doors from mapped planks without smelting', async () => {
  const state = setup({ '-181,73,-347': { oak_planks: 6 } });
  const result = await supplyStorageMaterial({ ...state, name: 'oak_door', required: 2, allowProcessing: false, allowCrafting: true });
  assert.equal(result.available, 3);
  assert.deepEqual(state.crafts, [{ name: 'oak_door', recipes: 1 }]);
});

test('crafts torch sticks from planks and uses primary coal source', async () => {
  const state = setup({ '-181,73,-347': { oak_planks: 2 }, '-181,74,-353': { coal: 4 } });
  assert.equal((await supplyStorageMaterial({ ...state, name: 'torch', required: 16 })).available, 16);
  assert.equal(state.inventory.coal, 0);
});

test('reported craft success without inventory change is not supply evidence', async () => {
  const state = setup({}, { stone: 4 });
  state.adapter.craftItem = async () => true;
  assert.deepEqual(await supplyStorageMaterial({ ...state, name: 'stone_bricks', required: 4 }),
    { available: 0, added: 0, missing: 4 });
});

test('large shortage schedules a bulk batch without waiting for furnace output', async () => {
  const state = setup({ '-181,71,-352': { cobblestone: 512 }, '-181,74,-353': { coal: 64 } });
  let job;
  const result = await supplyStorageMaterial({ ...state, name: 'stone_bricks', required: 512,
    smelt: async request => { job = request; return 0; } });
  assert.equal(job.count, 512);
  assert.equal(job.waitForOutput, false);
  assert.equal(result.missing, 512);
});

test('stone bricks dapat menunggu output furnace sebelum craft saat worker produksi memintanya', async () => {
  const state = setup({ '-181,71,-352': { cobblestone: 4 } });
  let smeltRequest;
  const result = await supplyStorageMaterial({ ...state, name: 'stone_bricks', required: 4,
    waitForSmeltOutput: true,
    smelt: async request => {
      smeltRequest = request;
      state.inventory.stone = 4;
      return 4;
    } });
  assert.equal(smeltRequest.waitForOutput, true);
  assert.deepEqual(state.crafts, [{ name: 'stone_bricks', recipes: 1 }]);
  assert.equal(result.available, 4);
});

test('live fallback mencari chest baru ketika assignment resmi tidak mencukupi', async () => {
  const state = setup({ '-180,73,-344': { cobblestone: 730 } });
  state.adapter.findMatchingChest = async (_names, options) => {
    assert.ok(options.excludePositions.some(pos => pos.x === -181 && pos.y === 71 && pos.z === -352));
    return { x: -180, y: 73, z: -344 };
  };
  const result = await supplyStorageMaterial({ ...state, name: 'cobblestone', required: 64 });
  assert.equal(result.available, 64);
  assert.ok(state.visited.includes('-180,73,-344'));
});
