const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreStorageSite, generateCandidateOrigins } = require('../../src/ai/storageRoomSurvey');

test('survei menolak cairan dan blok penghalang dengan skor lebih buruk daripada area kosong', () => {
  const blueprint = { blocks: [
    { x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' },
    { x: 0, y: 1, z: 0, name: 'stone_bricks', phase: 'walls' }
  ] };
  const world = new Map([
    ['0,0,0', { name: 'air', boundingBox: 'empty' }],
    ['0,-1,0', { name: 'stone' }],
    ['0,1,0', { name: 'water' }]
  ]);
  const result = scoreStorageSite({ adapter: { blockAt: p => world.get(`${p.x},${p.y},${p.z}`) || { name: 'air', boundingBox: 'empty' } }, blueprint, origin: { x: 0, y: 0, z: 0 } });
  assert.equal(result.counts.liquid, 1);
  assert.equal(result.safe, false);
});

test('generateCandidateOrigins menghasilkan grid deterministik tanpa origin pecahan', () => {
  const origins = generateCandidateOrigins({ center: { x: 0, y: 64, z: 0 }, radius: 16, step: 16 });
  assert.equal(origins.length, 9);
  assert.deepEqual(origins[0], { x: -16, y: 64, z: -16 });
});

test('survei mengizinkan fondasi tambahan bila terrain-work diaktifkan', () => {
  const blueprint = { blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }] };
  const world = new Map([
    ['0,0,0', { name: 'air', boundingBox: 'empty' }],
    ['0,-1,0', { name: 'air', boundingBox: 'empty' }],
    ['0,-2,0', { name: 'stone' }]
  ]);
  const result = scoreStorageSite({
    adapter: { blockAt: p => world.get(`${p.x},${p.y},${p.z}`) || { name: 'air', boundingBox: 'empty' } },
    blueprint,
    origin: { x: 0, y: 0, z: 0 },
    allowFoundationFill: true
  });
  assert.equal(result.counts.foundationFill, 1);
  assert.equal(result.counts.unsafeFoundation, 0);
  assert.equal(result.safe, true);
});

test('survei menghitung blok natural sebagai pekerjaan gali bila diizinkan', () => {
  const blueprint = { blocks: [{ x: 0, y: 1, z: 0, name: 'stone_bricks', phase: 'walls' }] };
  const result = scoreStorageSite({
    adapter: { blockAt: () => ({ name: 'stone' }) },
    blueprint,
    origin: { x: 0, y: 0, z: 0 },
    allowExcavation: true
  });
  assert.equal(result.counts.excavation, 1);
  assert.equal(result.counts.blocked, 0);
  assert.equal(result.safe, true);
});
