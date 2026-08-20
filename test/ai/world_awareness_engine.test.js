/**
 * @file world_awareness_engine.test.js
 * @description Unit test WorldAwarenessEngine berbasis chunk.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  WorldAwarenessEngine,
  blockToChunkCoord,
  chunkRadiusToBlockRadius,
  estimateChunkScanCost,
  resolveScanProfile
} = require('../../src/ai/worldAwarenessEngine');

describe('WorldAwarenessEngine chunk math', () => {
  it('harus mengonversi block radius dari chunk radius dengan benar', () => {
    assert.equal(chunkRadiusToBlockRadius(10), 160);
    assert.deepEqual(blockToChunkCoord(0, 0), { cx: 0, cz: 0 });
    assert.deepEqual(blockToChunkCoord(15, 15), { cx: 0, cz: 0 });
    assert.deepEqual(blockToChunkCoord(16, -1), { cx: 1, cz: -1 });
  });

  it('harus menghitung estimasi biaya scan 10 chunk secara eksplisit', () => {
    const estimate = estimateChunkScanCost(10, 17);
    assert.equal(estimate.chunks, 441);
    assert.equal(estimate.horizontalBlocks, 112896);
    assert.equal(estimate.totalBlocks, 1919232);
  });

  it('harus menyediakan profile surface dan cave dengan biaya berbeda', () => {
    const surface = resolveScanProfile('surface');
    const cave = resolveScanProfile('cave');
    assert.equal(surface.chunkRadius, 10);
    assert.equal(surface.verticalBelow + surface.verticalAbove + 1, 6);
    assert.equal(cave.chunkRadius, 4);
    assert.equal(cave.verticalBelow + cave.verticalAbove + 1, 17);
  });
});

describe('WorldAwarenessEngine scanning', () => {
  it('harus scan sekitar bot sesuai budget dan meng-cache block non-air', () => {
    const world = (x, y, z) => {
      if (x === 2 && y === 64 && z === 3) return { name: 'wheat', properties: { age: 7 }, position: { x, y, z } };
      if (x === 4 && y === 63 && z === 0) return { name: 'lava', position: { x, y, z } };
      return { name: 'air', position: { x, y, z } };
    };
    const engine = new WorldAwarenessEngine({
      blockAccessor: world,
      chunkRadius: 0,
      verticalRadius: 1,
      scanBudgetBlocksPerTick: 16 * 16 * 3
    });

    const result = engine.scanAround({ x: 0, y: 64, z: 0 });

    assert.equal(result.complete, true);
    assert.ok(engine.findBlocksByNames('wheat').length >= 1);
    assert.ok(engine.findHazards().length >= 1);
  });

  it('harus membatasi scan besar memakai budget', () => {
    const engine = new WorldAwarenessEngine({
      blockAccessor: (x, y, z) => ({ name: 'stone', position: { x, y, z } }),
      chunkRadius: 10,
      verticalRadius: 8,
      scanBudgetBlocksPerTick: 100
    });

    const result = engine.scanAround({ x: 0, y: 64, z: 0 });

    assert.equal(result.complete, false);
    assert.equal(result.scanned, 100);
    assert.equal(engine.blocks.size, 100);
  });

  it('harus memprioritaskan chunk ke arah gerak pada profile surface', () => {
    const engine = new WorldAwarenessEngine({
      blockAccessor: (x, y, z) => ({ name: 'air', position: { x, y, z } })
    });

    const chunks = engine.getPrioritizedChunks(
      { x: 0, y: 64, z: 0 },
      { profile: 'surface', chunkRadius: 1, heading: { x: 1, z: 0 } }
    );

    assert.equal(chunks[0].cx >= 0, true);
  });

  it('harus memakai vertical band tipis pada profile surface', () => {
    const engine = new WorldAwarenessEngine({
      blockAccessor: (x, y, z) => ({ name: y === 63 ? 'grass_block' : 'air', position: { x, y, z } }),
      scanBudgetBlocksPerTick: 16 * 16 * 6
    });

    const result = engine.scanAround({ x: 0, y: 64, z: 0 }, { profile: 'surface', chunkRadius: 0 });

    assert.equal(result.complete, true);
    assert.equal(result.verticalHeight, 6);
  });

  it('harus mengecek safe standing spot dari cache/live accessor', () => {
    const world = (x, y, z) => {
      if (y === 63) return { name: 'grass_block', position: { x, y, z } };
      return { name: 'air', position: { x, y, z } };
    };
    const engine = new WorldAwarenessEngine({ blockAccessor: world });

    assert.equal(engine.isSafeStandingSpot({ x: 0, y: 64, z: 0 }), true);
  });
});
