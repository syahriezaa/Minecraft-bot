const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { StorageRoomLandscaper, mapLandscape } = require('../../src/ai/storageRoomLandscaper');

function fakeWorld(entries = {}) {
  const world = new Map(Object.entries(entries));
  const blockAt = pos => world.get(`${pos.x},${pos.y},${pos.z}`) || { name: 'air', boundingBox: 'empty', position: { ...pos } };
  return { world, blockAt };
}

describe('StorageRoomLandscaper', () => {
  test('memetakan kolom tinggi dan rendah ke datum lantai yang sama', () => {
    const { blockAt } = fakeWorld({
      '0,69,0': { name: 'dirt', boundingBox: 'block' },
      '0,68,0': { name: 'stone', boundingBox: 'block' },
      '1,70,0': { name: 'grass_block', boundingBox: 'block' },
      '1,69,0': { name: 'dirt', boundingBox: 'block' }
    });
    const plan = mapLandscape({
      adapter: { blockAt },
      origin: { x: 0, y: 70, z: 0 },
      blueprint: { dimensions: { width: 2, depth: 1 } },
      margin: 0,
      minY: 67,
      maxY: 71
    });
    assert.equal(plan.summary.columns, 2);
    assert.equal(plan.summary.clear, 1);
    assert.equal(plan.summary.fill, 0);
    assert.equal(plan.columns[1].clear.length, 1);
    assert.equal(plan.columns[1].surfaceY, 69);
  });

  test('menolak blok non-natural dan cairan sebelum mutasi dunia', () => {
    const { blockAt } = fakeWorld({
      '0,70,0': { name: 'stone_bricks', boundingBox: 'block' },
      '0,69,0': { name: 'stone', boundingBox: 'block' },
      '1,69,0': { name: 'water', boundingBox: 'liquid' }
    });
    const plan = mapLandscape({
      adapter: { blockAt }, origin: { x: 0, y: 70, z: 0 }, blueprint: { dimensions: { width: 2, depth: 1 } }, margin: 0, minY: 68, maxY: 71
    });
    assert.equal(plan.summary.blocked, 1);
    assert.equal(plan.summary.liquid, 1);
  });

  test('mengisi kolom rendah dari bawah dan memverifikasi dirt live', async () => {
    const { world, blockAt } = fakeWorld({
      '0,68,0': { name: 'stone', boundingBox: 'block', position: { x: 0, y: 68, z: 0 } },
      '1,67,0': { name: 'stone', boundingBox: 'block', position: { x: 1, y: 67, z: 0 } }
    });
    const bot = {
      placeBlock: async (reference, face) => {
        const pos = { x: reference.position.x + face.x, y: reference.position.y + face.y, z: reference.position.z + face.z };
        world.set(`${pos.x},${pos.y},${pos.z}`, { name: 'dirt', boundingBox: 'block', position: pos });
      }
    };
    const adapter = {
      blockAt, equipItem: async name => name === 'dirt', navigateNear: async () => true,
      findReferences: async () => [{ reference: blockAt({ x: 0, y: 68, z: 0 }), face: { x: 0, y: 1, z: 0 } }]
    };
    const landscaper = new StorageRoomLandscaper({
      bot, adapter, origin: { x: 0, y: 70, z: 0 }, blueprint: { dimensions: { width: 1, depth: 1 } }, options: { margin: 0, minY: 67, maxY: 71, placementVerifyTimeoutMs: 100 }
    });
    const result = await landscaper.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(world.get('0,69,0').name, 'dirt');
    assert.equal(result.completed, 1);
  });

  test('menunda titik fill yang belum punya referensi lalu mencoba lagi setelah ada kemajuan', async () => {
    const { world, blockAt } = fakeWorld({
      '0,68,0': { name: 'stone', boundingBox: 'block', position: { x: 0, y: 68, z: 0 } },
      '1,67,0': { name: 'stone', boundingBox: 'block', position: { x: 1, y: 67, z: 0 } }
    });
    let attempts = 0;
    const bot = {
      placeBlock: async (reference, face) => {
        const pos = { x: reference.position.x + face.x, y: reference.position.y + face.y, z: reference.position.z + face.z };
        world.set(`${pos.x},${pos.y},${pos.z}`, { name: 'dirt', boundingBox: 'block', position: pos });
      }
    };
    const adapter = {
      blockAt,
      equipItem: async name => name === 'dirt',
      navigateNear: async () => true,
      findReferences: async pos => {
        attempts += 1;
        if (attempts === 1) return [];
        const referencePos = { x: pos.x, y: pos.y - 1, z: pos.z };
        return [{ reference: blockAt(referencePos), face: { x: 0, y: 1, z: 0 } }];
      }
    };
    const landscaper = new StorageRoomLandscaper({
      bot, adapter, origin: { x: 0, y: 70, z: 0 }, blueprint: { dimensions: { width: 2, depth: 1 } },
      options: { margin: 0, minY: 67, maxY: 71, placementVerifyTimeoutMs: 100, placementRetryDelayMs: 1 }
    });
    const result = await landscaper.build();
    assert.equal(result.status, 'COMPLETE');
    assert.ok(attempts >= 3);
  });
});
