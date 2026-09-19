const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AdaptiveMiningPlanner } = require('../../src/ai/adaptiveMiningPlanner');

test('frontier dimulai dari garis pengguna lalu membagi strip menjadi sel non-overlap', () => {
  const planner = new AdaptiveMiningPlanner({ cellSize: 8, direction: 'east' });
  const cells = planner.createSeedCells({ seedX: -66, minZ: -406, maxZ: -379, floorY: 40, maxY: 80 });
  assert.equal(cells[0].bounds.minX, -66);
  assert.equal(cells[0].bounds.maxX, -59);
  assert.equal(cells[0].bounds.minZ, -406);
  assert.equal(cells.at(-1).bounds.maxZ, -379);
  assert.equal(new Set(cells.map(cell => cell.id)).size, cells.length);
});

test('unknown, struktur, dan cairan tidak pernah menjadi sel tambang aman', () => {
  const planner = new AdaptiveMiningPlanner();
  assert.equal(planner.classifyCell({ unknownColumns: 1, totalColumns: 64 }).classification, 'UNKNOWN');
  assert.equal(planner.classifyCell({ structureColumns: 1, totalColumns: 64 }).classification, 'PROTECTED');
  assert.equal(planner.classifyCell({ liquidColumns: 40, deepLiquidColumns: 35, totalColumns: 64 }).classification, 'OCEAN');
  assert.equal(planner.classifyCell({ naturalColumns: 64, totalColumns: 64 }).classification, 'SAFE');
});

test('frontier hanya berkembang ke timur setelah sel aman selesai', () => {
  const planner = new AdaptiveMiningPlanner({ cellSize: 8, direction: 'east' });
  const [cell] = planner.createSeedCells({ seedX: -66, minZ: -406, maxZ: -399, floorY: 40, maxY: 80 });
  assert.deepEqual(planner.nextFrontierCells(cell, { classification: 'OCEAN', exhausted: true }), []);
  assert.deepEqual(planner.nextFrontierCells(cell, { classification: 'SAFE', exhausted: false }), []);
  const [next] = planner.nextFrontierCells(cell, { classification: 'SAFE', exhausted: true });
  assert.equal(next.bounds.minX, -58);
  assert.equal(next.bounds.maxX, -51);
  assert.equal(next.parentId, cell.id);
});

test('frontier edge cave/ravine boleh melanjutkan survei setelah target aman habis', () => {
  const planner = new AdaptiveMiningPlanner({ cellSize: 8, direction: 'east' });
  const [cell] = planner.createSeedCells({ seedX: -66, minZ: -406, maxZ: -399, floorY: 40, maxY: 80 });
  const [next] = planner.nextFrontierCells(cell, { classification: 'RAVINE_EDGE', exhausted: true });
  assert.equal(next.bounds.minX, -58);
  assert.equal(next.parentId, cell.id);
});

test('frontier terlindungi dilewati ke timur tanpa menjadi mineable', () => {
  const planner = new AdaptiveMiningPlanner({ cellSize: 8, direction: 'east' });
  const [cell] = planner.createSeedCells({ seedX: -66, minZ: -406, maxZ: -399, floorY: 40, maxY: 80 });
  const [next] = planner.nextFrontierCells(cell, { classification: 'PROTECTED', exhausted: true });
  assert.equal(next.bounds.minX, -58);
  assert.equal(next.bounds.maxX, -51);
});
