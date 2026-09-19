const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareStorageRoomTools } = require('../../src/ai/storageRoomToolPreparation');

function fixture(initial = {}, stock = {}) {
  const inventory = { ...initial };
  const reads = [];
  const crafts = [];
  const bot = { entity: { position: { x: -185, y: 71, z: -352 } } };
  const adapter = {
    bot,
    getInventoryItems: () => Object.entries(inventory).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
    findChestPositions: async () => [],
    openChestAt: async pos => {
      const key = `${pos.x},${pos.y},${pos.z}`;
      reads.push(key);
      return { containerItems: () => Object.entries(stock[key] || {}).map(([name, count]) => ({ name, count })), close() {} };
    },
    withdrawFromChest: async (pos, [name], n) => {
      const items = stock[`${pos.x},${pos.y},${pos.z}`];
      const take = Math.min(n, items?.[name] || 0);
      if (take) { items[name] -= take; inventory[name] = (inventory[name] || 0) + take; }
      return { withdrawn: take };
    },
    craftItem: async (name, recipes) => {
      assert.equal(recipes, 1);
      crafts.push(name);
      const ingredients = name === 'oak_planks' ? { oak_log: 1 } : name === 'stick' ? { oak_planks: 2 } :
        { [name.startsWith('iron') ? 'iron_ingot' : (inventory.cobblestone >= (name.endsWith('pickaxe') ? 3 : 1) ? 'cobblestone' : 'cobbled_deepslate')]: name.endsWith('pickaxe') ? 3 : 1, stick: 2 };
      for (const [item, n] of Object.entries(ingredients)) {
        assert.ok(inventory[item] >= n);
        inventory[item] -= n;
      }
      inventory[name] = (inventory[name] || 0) + (['oak_planks', 'stick'].includes(name) ? 4 : 1);
      return true;
    }
  };
  return { adapter, bot, reads, crafts, walk: async () => ({ success: true }), sourceSearchCount: 16 };
}

test('observation and already-ready inventory never walk, craft or scan chests', async () => {
  const state = fixture({ iron_pickaxe: 1, stone_shovel: 1 });
  state.walk = async () => { throw new Error('unexpected travel'); };
  assert.equal((await prepareStorageRoomTools(state)).ready, true);
  assert.equal(state.reads.length, 0);
  assert.equal((await prepareStorageRoomTools(fixture())).reason, 'preparation_not_authorized');
});

test('one chest index serves iron tools and stick crafting from actual wood names', async () => {
  const state = fixture({}, { '-181,74,-353': { iron_ingot: 4 }, '-181,74,-347': { oak_log: 1 } });
  const result = await prepareStorageRoomTools({ ...state, execute: true });
  assert.equal(result.ready, true);
  assert.equal(result.tools.pickaxe.name, 'iron_pickaxe');
  assert.equal(result.tools.shovel.name, 'iron_shovel');
  assert.deepEqual(state.crafts, ['oak_planks', 'stick', 'iron_pickaxe', 'iron_shovel']);
  assert.equal(new Set(state.reads).size, state.reads.length);
});

test('known tool chest menghentikan discovery live setelah kedua tool ditemukan', async () => {
  const state = fixture({}, { '-181,71,-348': { iron_pickaxe: 1, iron_shovel: 1 } });
  state.adapter.findChestPositions = async () => { throw new Error('discovery tidak seharusnya dipanggil'); };
  const result = await prepareStorageRoomTools({ ...state, execute: true });
  assert.equal(result.ready, true);
  assert.equal(state.reads[0], '-181,71,-348');
});

test('unreachable base does not inspect or mutate containers', async () => {
  const state = fixture();
  const result = await prepareStorageRoomTools({ ...state, execute: true, walk: async () => ({ success: false }) });
  assert.equal(result.reason, 'base_unreachable');
  assert.equal(state.reads.length, 0);
});

test('bootstrap terrain hanya diteruskan bila diaktifkan eksplisit', async () => {
  const state = fixture();
  let received;
  state.walk = async options => { received = options; return { success: false, reason: 'test' }; };
  await prepareStorageRoomTools({ ...state, execute: true, allowTerrainWork: true, terrainBreakAllowlist: new Set(['dirt']) });
  assert.equal(received.allowTerrainWork, true);
  assert.deepEqual([...received.terrainBreakAllowlist], ['dirt']);
});

test('landing level fallback diteruskan ke perjalanan persiapan tool', async () => {
  const state = fixture();
  let received;
  state.walk = async options => { received = options; return { success: false, reason: 'test' }; };
  await prepareStorageRoomTools({ ...state, execute: true, fallbackGoalYOffsets: [-1, -2] });
  assert.deepEqual(received.fallbackGoalYOffsets, [-1, -2]);
});

test('stage distance onboarding diteruskan ke navigator', async () => {
  const state = fixture();
  let received;
  state.walk = async options => { received = options; return { success: false, reason: 'test' }; };
  await prepareStorageRoomTools({ ...state, execute: true, stageDistance: 32 });
  assert.equal(received.stageDistance, 32);
});

test('false craft success cannot make a worker ready', async () => {
  const state = fixture({ stick: 4, iron_ingot: 4 });
  state.adapter.craftItem = async () => true;
  const result = await prepareStorageRoomTools({ ...state, execute: true });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ['pickaxe', 'shovel']);
});

test('mengunci setiap withdrawal tool agar worker paralel tidak mengambil stok yang sama', async () => {
  const state = fixture({}, { '-181,74,-353': { iron_ingot: 4 }, '-181,74,-347': { oak_log: 1 } });
  const calls = [];
  const result = await prepareStorageRoomTools({
    ...state,
    execute: true,
    withLock: async (action, options) => {
      calls.push(options.resourceKey);
      return action();
    }
  });
  assert.equal(result.ready, true);
  assert.ok(calls.some(key => key.includes('chest:')));
});

test('menggunakan cobbled_deepslate sebagai fallback stone-tool saat cobblestone habis', async () => {
  const state = fixture({}, { '-181,71,-352': { cobblestone: 1, cobbled_deepslate: 8 }, '-181,74,-347': { oak_log: 1 } });
  const result = await prepareStorageRoomTools({ ...state, execute: true });
  assert.equal(result.ready, true);
  assert.deepEqual(state.crafts, ['oak_planks', 'stick', 'stone_pickaxe', 'stone_shovel']);
});

test('mencari ulang sumber material tool ketika assignment lama tidak cukup', async () => {
  const state = fixture({}, { '-181,74,-347': { oak_log: 1 }, '-181,70,-350': { cobbled_deepslate: 8 } });
  state.adapter.findChestPositions = async () => [];
  state.adapter.findMatchingChest = async names => names.includes('cobbled_deepslate') ? { x: -181, y: 70, z: -350 } : null;
  const result = await prepareStorageRoomTools({ ...state, execute: true });
  assert.equal(result.ready, true);
  assert.equal(state.crafts.includes('stone_pickaxe'), true);
});

test('mencari ulang stick dari chest live sebelum gagal membuat pickaxe', async () => {
  const state = fixture({}, { '-181,70,-350': { cobbled_deepslate: 8 }, '-181,70,-349': { stick: 8 } });
  state.adapter.findChestPositions = async () => [];
  state.adapter.findMatchingChest = async names => {
    if (names.includes('cobbled_deepslate')) return { x: -181, y: 70, z: -350 };
    if (names.length === 1 && names[0] === 'stick') return { x: -181, y: 70, z: -349 };
    return null;
  };
  const result = await prepareStorageRoomTools({ ...state, execute: true });
  assert.equal(result.ready, true);
  assert.equal(state.crafts.includes('stone_pickaxe'), true);
});
