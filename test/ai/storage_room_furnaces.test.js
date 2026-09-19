const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expandStorageFurnaces } = require('../../src/ai/storageRoomFurnaces');
const { isStorageAccessPosition } = require('../../src/ai/storageAccessPolicy');

test('furnace survey is read-only and caps additions to a bounded yard', async () => {
  const adapter = { blockAt: pos => ({ name: pos.y === 62 ? 'grass_block' : 'air' }) };
  const result = await expandStorageFurnaces({ bot: {}, adapter });
  assert.equal(result.targets.length, 24);
  assert.equal(result.built, 0);
});

test('unknown terrain prevents furnace additions', async () => {
  let supplyCalls = 0;
  const adapter = { blockAt: () => null,
    withdrawFromChest: async () => { supplyCalls += 1; } };
  const result = await expandStorageFurnaces({ bot: {}, adapter, execute: true });
  assert.equal(result.blocked.length, 24);
  assert.equal(result.built, 0);
  assert.equal(supplyCalls, 0);
});

test('dynamic survey tidak memilih pijakan furnace jauh di bawah level bot', async () => {
  const adapter = {
    blockAt: pos => pos.x === -188 && pos.z === -354 && pos.y === 59
      ? { name: 'grass_block' }
      : { name: 'air' }
  };
  const result = await expandStorageFurnaces({ bot: { entity: { position: { x: -181, y: 72, z: -346 } } }, adapter });
  assert.equal(result.targets.length, 0);
});

test('dynamic furnace tidak memakai lantai gudang sebagai yard smelting', async () => {
  const adapter = {
    blockAt: pos => pos.y === 71 && pos.x >= -195 && pos.x <= -175 && pos.z >= -360 && pos.z <= -338
      ? { name: 'stone_bricks', position: pos }
      : { name: 'air', position: pos }
  };
  const result = await expandStorageFurnaces({
    bot: { entity: { position: { x: -183, y: 72, z: -347 } } },
    adapter,
    maxTargets: 4
  });
  assert.equal(result.targets.length, 0);
  assert.equal(isStorageAccessPosition({ x: -183, y: 72, z: -347 }), true);
  assert.equal(isStorageAccessPosition({ x: -172, y: 72, z: -347 }), false);
});

test('verified ground-level furnace additions survive a partial inventory', async () => {
  let inventory = 6;
  const placed = new Set();
  const key = p => `${p.x},${p.y},${p.z}`;
  const adapter = {
    blockAt: pos => ({ name: placed.has(key(pos)) ? 'furnace' : pos.y === 62 ? 'grass_block' : 'air', position: pos }),
    getItemCount: name => name === 'furnace' ? inventory : 0,
    withdrawFromChest: async () => ({ withdrawn: 0 }),
    craftItem: async () => false,
    navigateNear: async () => true,
    equipItem: async () => inventory > 0,
    placeBlockAt: async (pos, reference) => {
      assert.equal(reference.name, 'grass_block');
      inventory -= 1;
      placed.add(key(pos));
    }
  };
  const result = await expandStorageFurnaces({ bot: {}, adapter, execute: true });
  assert.equal(result.built, 6);
  assert.equal([...placed].filter(k => k.split(',')[1] === '63').length, 6);
});
