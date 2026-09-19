const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createStorageRoomBlueprint } = require('../../src/ai/storageRoomBlueprint');
const { auditStorageRoom } = require('../../src/ai/storageRoomAudit');

function fakeWorld(blueprint, origin, { light = 15, missing = new Set(), liquids = new Set() } = {}) {
  const expected = new Map(blueprint.blocks.map(block => {
    const pos = { x: origin.x + block.x, y: origin.y + block.y, z: origin.z + block.z };
    return [`${pos.x},${pos.y},${pos.z}`, { name: block.name, position: pos, light, properties: block.properties }];
  }));
  return {
    blockAt(pos) {
      const id = `${pos.x},${pos.y},${pos.z}`;
      if (missing.has(id)) return null;
      if (liquids.has(id)) return { name: 'water', position: pos, light: 0 };
      return expected.get(id) || { name: 'air', boundingBox: 'empty', position: pos, light };
    }
  };
}

describe('auditStorageRoom', () => {
  test('menolak facing berbeda walaupun kedua chest memiliki type left/right', async () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const origin = { x: -110, y: 70, z: -400 };
    const base = fakeWorld(blueprint, origin);
    const adapter = { blockAt: pos => {
      const block = base.blockAt(pos);
      return block.name === 'chest' && block.properties.type === 'left' ?
        { ...block, properties: { ...block.properties, facing: 'south' } } : block;
    } };
    const result = await auditStorageRoom({ adapter, blueprint, origin });
    assert.equal(result.ok, false);
    assert.equal(result.verifiedDoubleChests, 0);
  });

  test('akses kepala yang tidak termuat menghalangi kelulusan audit', async () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const origin = { x: -110, y: 70, z: -400 };
    const access = blueprint.pairs[0].access;
    const missing = new Set([`${origin.x + access.x},${origin.y + access.y + 1},${origin.z + access.z}`]);
    const result = await auditStorageRoom({ adapter: fakeWorld(blueprint, origin, { missing }), blueprint, origin });
    assert.equal(result.ok, false);
    assert.ok(result.accessBlocked.length > 0);
  });

  test('bukaan masuk dan state pintu wajib bisa diverifikasi', async () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const origin = { x: -110, y: 70, z: -400 };
    const base = fakeWorld(blueprint, origin);
    const adapter = { blockAt: pos => {
      const block = base.blockAt(pos);
      if (pos.x === origin.x + 21 && pos.y === origin.y + 1 && pos.z === origin.z - 2) {
        return { ...block, name: 'stone_bricks', boundingBox: 'block' };
      }
      if (block.name === 'oak_door' && block.properties?.half === 'lower') {
        return { ...block, properties: { ...block.properties, open: false } };
      }
      return block;
    } };
    const result = await auditStorageRoom({ adapter, blueprint, origin });
    assert.equal(result.ok, false);
    assert.ok(result.entryAccessBlocked.length > 0);
    assert.ok(result.doorStateIssues.length > 0);
  });

  test('audit origin negatif memakai koordinat absolut untuk pengecualian lorong', async () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const origin = { x: -110, y: 70, z: -400 };
    const result = await auditStorageRoom({ adapter: fakeWorld(blueprint, origin), blueprint, origin });
    assert.equal(result.ok, true);
  });
  test('meluluskan blueprint lengkap dengan pasangan dan cahaya memadai', async () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const result = await auditStorageRoom({ adapter: fakeWorld(blueprint, { x: 0, y: 70, z: 0 }), blueprint, origin: { x: 0, y: 70, z: 0 } });
    assert.equal(result.ok, true);
    assert.equal(result.chestBlocksFound, 520);
    assert.equal(result.verifiedDoubleChests, 260);
    assert.equal(result.lightingFound, result.lightingExpected);
  });

  test('menolak chest hilang dan cairan di area akses', async () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const origin = { x: 0, y: 70, z: 0 };
    const missing = new Set(['1,71,2']);
    const liquids = new Set(['1,71,1']);
    const result = await auditStorageRoom({ adapter: fakeWorld(blueprint, origin, { missing, liquids }), blueprint, origin });
    assert.equal(result.ok, false);
    assert.equal(result.unknown.length > 0, true);
    assert.equal(result.liquids.length > 0, true);
  });

  test('tidak menganggap dua chest sebagai double bila state type tidak tersedia', async () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const origin = { x: 0, y: 70, z: 0 };
    const adapter = fakeWorld(blueprint, origin);
    const originalBlockAt = adapter.blockAt;
    adapter.blockAt = pos => {
      const block = originalBlockAt(pos);
      if (block?.name === 'chest') delete block.properties;
      return block;
    };
    const result = await auditStorageRoom({ adapter, blueprint, origin });
    assert.equal(result.ok, false);
    assert.equal(result.verifiedDoubleChests, 0);
    assert.equal(result.pairStateUnknown.length > 0, true);
  });
});
