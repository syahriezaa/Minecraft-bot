const { test } = require('node:test');
const assert = require('node:assert/strict');
const { smeltStorageStone } = require('../../src/ai/storageRoomSmelter');

test('furnace resep lain tidak diambil atau diubah', async () => {
  let closed = false;
  const bot = {
    findBlocks: () => [{ x: 0, y: 64, z: 0 }],
    openFurnace: async () => ({
      inputItem: () => ({ name: 'raw_iron', count: 8 }), outputItem: () => ({ name: 'iron_ingot', count: 4 }),
      takeOutput: async () => { throw new Error('resep lain'); }, close: () => { closed = true; }
    })
  };
  const result = await smeltStorageStone({ bot, adapter: { navigateNear: async () => true, blockAt: p => p } });
  assert.equal(result, 0);
  assert.equal(closed, true);
});

test('membagi smelting delapan stone per furnace dan mengambil output terkonfirmasi', async () => {
  let cobble = 16;
  let coal = 2;
  const states = [0, 1].map(x => ({ pos: { x, y: 64, z: 0 }, input: null, fuel: null, output: null }));
  const inventory = () => [{ name: 'cobblestone', type: 4, count: cobble }, { name: 'coal', type: 5, count: coal }];
  const bot = {
    inventory: { items: inventory }, findBlocks: () => states.map(s => s.pos),
    openFurnace: async pos => {
      const s = states[pos.x];
      if (s.input) { s.output = { name: 'stone', count: s.input.count }; s.input = null; }
      return {
        inputItem: () => s.input, outputItem: () => s.output, fuelItem: () => s.fuel,
        putFuel: async (_, __, n) => { coal -= n; s.fuel = { name: 'coal', count: n }; },
        putInput: async (_, __, n) => { cobble -= n; s.input = { name: 'cobblestone', count: n }; },
        takeOutput: async () => { const output = s.output; s.output = null; return output; }, close: () => {}
      };
    }
  };
  const adapter = { navigateNear: async () => true, blockAt: p => p, getItemCount: name => inventory().find(i => i.name === name)?.count || 0 };
  assert.equal(await smeltStorageStone({ bot, adapter, count: 16, pollMs: 1, timeoutMs: 1000 }), 16);
  assert.equal(cobble, 0);
  assert.equal(coal, 0);
});

test('smelting non-blocking melepas kontrol setelah input furnace dijadwalkan', async () => {
  let cobble = 8;
  let coal = 1;
  let outputTaken = false;
  const bot = {
    findBlocks: () => [{ x: 0, y: 64, z: 0 }],
    inventory: { items: () => [{ name: 'cobblestone', type: 4, count: cobble }, { name: 'coal', type: 5, count: coal }] },
    openFurnace: async () => ({
      inputItem: () => null, outputItem: () => null, fuelItem: () => null,
      putFuel: async () => { coal -= 1; },
      putInput: async (_, __, count) => { cobble -= count; },
      takeOutput: async () => { outputTaken = true; return { name: 'stone', count: 8 }; },
      close: () => {}
    })
  };
  const adapter = { navigateNear: async () => true, blockAt: p => p, getItemCount: name => name === 'cobblestone' ? cobble : coal };
  const started = Date.now();
  assert.equal(await smeltStorageStone({ bot, adapter, count: 8, waitForOutput: false, timeoutMs: 1000, log: () => {} }), 0);
  assert.ok(Date.now() - started < 500);
  assert.equal(cobble, 0);
  assert.equal(coal, 0);
  assert.equal(outputTaken, false);
});

test('bulk smelting fills four furnaces with 64 input and 8 coal each', async () => {
  let cobble = 256;
  let coal = 32;
  const loads = [];
  const fuels = [];
  const bot = {
    findBlocks: () => [0, 1, 2, 3].map(x => ({ x, y: 64, z: 0 })),
    inventory: { items: () => [{ name: 'cobblestone', type: 4, count: cobble }, { name: 'coal', type: 5, count: coal }] },
    openFurnace: async () => ({
      inputItem: () => null, outputItem: () => null, fuelItem: () => null,
      putFuel: async (_, __, n) => { fuels.push(n); coal -= n; },
      putInput: async (_, __, n) => { loads.push(n); cobble -= n; }, close: () => {}
    })
  };
  const adapter = { navigateNear: async () => true, blockAt: p => p, getItemCount: n => n === 'cobblestone' ? cobble : coal };
  await smeltStorageStone({ bot, adapter, count: 256, waitForOutput: false });
  assert.deepEqual(loads, [64, 64, 64, 64]);
  assert.deepEqual(fuels, [8, 8, 8, 8]);
  assert.equal(cobble, 0);
  assert.equal(coal, 0);
});

test('smelter mengabaikan furnace yang menghalangi akses gudang', async () => {
  let opened = 0;
  const bot = {
    findBlocks: () => [
      { x: -183, y: 72, z: -347 },
      { x: -172, y: 64, z: -332 }
    ],
    openFurnace: async () => {
      opened += 1;
      return {
        inputItem: () => ({ name: 'raw_iron', count: 1 }),
        outputItem: () => null,
        fuelItem: () => null,
        close: () => {}
      };
    }
  };
  const adapter = { navigateNear: async () => true, blockAt: pos => ({ ...pos, name: 'furnace' }) };
  await smeltStorageStone({ bot, adapter, count: 8 });
  assert.equal(opened, 1);
});
