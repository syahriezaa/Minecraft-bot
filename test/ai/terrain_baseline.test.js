/**
 * @file terrain_baseline.test.js
 * @description Uji extractSurfaceColumns (ekstraksi permukaan dari chunk cache LiveProtocolClient)
 * dan world accessor gabungan (live cache -> baseline persisten -> null) di terrainBaseline.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSurfaceColumns,
  createBaselineWorldAccessor,
  createCombinedWorldAccessor
} = require('../../src/ai/terrainBaseline');

function makeFakeClient(blockAt) {
  return {
    getBlockName: (x, y, z) => blockAt(x, y, z),
    getBlockStateId: (x, y, z) => (blockAt(x, y, z) === null ? null : 1)
  };
}

describe('extractSurfaceColumns', () => {
  it('harus menemukan blok teratas non-udara untuk tiap kolom di chunk 16x16', () => {
    // Dunia sederhana: permukaan rata di y=64 untuk seluruh chunk (0,0).
    const client = makeFakeClient((x, y, z) => {
      if (y < 64) return 'stone';
      if (y === 64) return 'grass_block';
      return 'air';
    });

    const columns = extractSurfaceColumns(client, 0, 0);

    assert.equal(columns.length, 256, 'harus ada 256 kolom (16x16) untuk 1 chunk');
    assert.ok(columns.every((c) => c.surfaceY === 64 && c.blockName === 'grass_block'));
  });

  it('harus menghasilkan koordinat x,z absolut sesuai posisi chunk (bukan lokal 0-15)', () => {
    const client = makeFakeClient((x, y, z) => (y === 64 ? 'grass_block' : 'air'));

    // chunk (-2, 3) -> x absolut dari -32 s/d -17, z absolut dari 48 s/d 63
    const columns = extractSurfaceColumns(client, -2, 3);

    const xs = columns.map((c) => c.x);
    const zs = columns.map((c) => c.z);
    assert.equal(Math.min(...xs), -32);
    assert.equal(Math.max(...xs), -17);
    assert.equal(Math.min(...zs), 48);
    assert.equal(Math.max(...zs), 63);
  });

  it('kolom yang seluruhnya udara (tidak ada permukaan) harus dilewati, bukan error', () => {
    const client = makeFakeClient(() => 'air');

    const columns = extractSurfaceColumns(client, 0, 0);

    assert.equal(columns.length, 0);
  });
});

describe('createBaselineWorldAccessor', () => {
  it('harus mengembalikan nama blok asli persis di surfaceY, "air" di atasnya, "stone" di bawahnya', () => {
    const columnsMap = new Map([['5,5', { x: 5, z: 5, surface_y: 64, block_name: 'grass_block' }]]);
    const accessor = createBaselineWorldAccessor(columnsMap);

    assert.equal(accessor(5, 64, 5), 'grass_block');
    assert.equal(accessor(5, 70, 5), 'air');
    assert.equal(accessor(5, 50, 5), 'stone');
  });

  it('harus mengembalikan null untuk kolom yang tidak ada di baseline', () => {
    const accessor = createBaselineWorldAccessor(new Map());
    assert.equal(accessor(1, 64, 1), null);
  });
});

describe('createCombinedWorldAccessor', () => {
  it('harus memprioritaskan data live cache di atas baseline', () => {
    const client = makeFakeClient((x, y, z) => (x === 1 && y === 64 && z === 1 ? 'diamond_block' : null));
    const columnsMap = new Map([['1,1', { x: 1, z: 1, surface_y: 64, block_name: 'grass_block' }]]);
    const accessor = createCombinedWorldAccessor(client, createBaselineWorldAccessor(columnsMap));

    assert.equal(accessor(1, 64, 1), 'diamond_block', 'live cache harus menang atas baseline');
  });

  it('harus jatuh ke baseline kalau live cache tidak punya data (null)', () => {
    const client = makeFakeClient(() => null);
    const columnsMap = new Map([['1,1', { x: 1, z: 1, surface_y: 64, block_name: 'grass_block' }]]);
    const accessor = createCombinedWorldAccessor(client, createBaselineWorldAccessor(columnsMap));

    assert.equal(accessor(1, 64, 1), 'grass_block');
  });

  it('harus mengembalikan null kalau baik live maupun baseline sama-sama tidak punya data', () => {
    const client = makeFakeClient(() => null);
    const accessor = createCombinedWorldAccessor(client, createBaselineWorldAccessor(new Map()));

    assert.equal(accessor(1, 64, 1), null);
  });
});
