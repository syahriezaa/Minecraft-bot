const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FarmerEngine } = require('../../src/ai/farmerEngine');
const { MineflayerRoleAdapter } = require('../../src/ai/mineflayerRoleAdapter');

test('baris tetap terurut dan benih tidak berganti pada batch berikutnya', () => {
  const engine = new FarmerEngine({ adapter: { hasItem: () => true } });
  engine.rowAxis = 'x';
  const spot = (x, z) => ({ name: 'farmland', position: { x, y: 64, z } });
  const ordered = engine.groupSpotsByRow([spot(2, 1), spot(2, 0), spot(1, 0)]).flat();
  assert.deepEqual(ordered.map(b => [b.position.x, b.position.z]), [[1, 0], [2, 0], [2, 1]]);
  const seed = engine.chooseSeedFor(spot(1, 0));
  engine.chooseSeedFor(spot(1, 1));
  assert.equal(engine.chooseSeedFor(spot(2, 0)), seed);
});

test('repair menempel pada sisi blok tanpa turun ke dasar lubang', async () => {
  const placements = [];
  const adapter = new MineflayerRoleAdapter({ placeBlock: async (...args) => placements.push(args) });
  adapter.equipItem = async () => true;
  adapter.blockAt = p => p.x === 1 && p.y === 64 ? { name: 'farmland', position: p } : { name: 'water', position: p };
  adapter.navigateNear = async p => { assert.equal(p.y, 65); return true; };
  assert.equal(await adapter.placeDirtAt({ x: 0, y: 64, z: 0 }), true);
  assert.equal(placements[0][1].x, -1);
  adapter.navigateNear = async () => false;
  assert.equal(await adapter.placeDirtAt({ x: 0, y: 64, z: 0 }), false);
  assert.equal(placements.length, 1);
});

test('repair gagal tidak diulang pada tick berikutnya', async () => {
  let attempts = 0;
  const engine = new FarmerEngine({ adapter: { hasItem: () => true, placeDirtAt: async () => { attempts++; return false; } } });
  engine.findRepairCandidates = () => [{ type: 'fill', position: { x: 0, y: 64, z: 0 } }];
  await engine.attemptRepair();
  await engine.attemptRepair();
  assert.equal(attempts, 1);
});
