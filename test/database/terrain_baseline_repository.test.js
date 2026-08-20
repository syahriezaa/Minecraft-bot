/**
 * @file terrain_baseline_repository.test.js
 * @description Uji CRUD terrainBaselineRepository (tabel terrain_surface_baseline) - baseline
 * permukaan dunia persisten lintas sesi, dibangun dari data chunk nyata yang pernah dimuat.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { pool, checkDatabaseHealth, closeDatabasePool } = require('../../src/config/database');
const { runMigrations } = require('../../src/database/migrations');
const repo = require('../../src/database/terrainBaselineRepository');

describe('terrainBaselineRepository', () => {
  before(async () => {
    const health = await checkDatabaseHealth(3, 500);
    assert.equal(health.ok, true, `Database harus aktif: ${health.error}`);
    await runMigrations(pool);
  });

  after(async () => {
    await closeDatabasePool();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM terrain_surface_baseline');
  });

  it('upsertColumnsBatch harus menyimpan banyak kolom sekaligus', async () => {
    const inserted = await repo.upsertColumnsBatch(pool, [
      { x: 10, z: 20, surfaceY: 64, blockStateId: 8, blockName: 'grass_block', source: 'passive' },
      { x: 11, z: 20, surfaceY: 63, blockStateId: 1, blockName: 'stone', source: 'passive' }
    ]);

    assert.equal(inserted, 2);

    const { rows } = await pool.query('SELECT * FROM terrain_surface_baseline ORDER BY x');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].block_name, 'grass_block');
  });

  it('upsertColumnsBatch harus menimpa data lama untuk (x,z) yang sama (data terbaru menang)', async () => {
    await repo.upsertColumnsBatch(pool, [{ x: 5, z: 5, surfaceY: 60, blockStateId: 1, blockName: 'stone', source: 'passive' }]);
    await repo.upsertColumnsBatch(pool, [{ x: 5, z: 5, surfaceY: 70, blockStateId: 8, blockName: 'grass_block', source: 'exploration' }]);

    const col = await repo.getColumn(pool, 5, 5);
    assert.equal(col.surface_y, 70);
    assert.equal(col.block_name, 'grass_block');
    assert.equal(col.source, 'exploration');
  });

  it('getColumnsInBounds harus mengembalikan hanya kolom dalam rentang yang diminta', async () => {
    await repo.upsertColumnsBatch(pool, [
      { x: 0, z: 0, surfaceY: 64, blockStateId: 8, blockName: 'grass_block', source: 'passive' },
      { x: 5, z: 5, surfaceY: 64, blockStateId: 8, blockName: 'grass_block', source: 'passive' },
      { x: 100, z: 100, surfaceY: 64, blockStateId: 8, blockName: 'grass_block', source: 'passive' }
    ]);

    const rows = await repo.getColumnsInBounds(pool, -1, 10, -1, 10);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.x <= 10 && r.z <= 10));
  });

  it('getColumn harus mengembalikan null kalau kolom belum pernah tersimpan', async () => {
    const col = await repo.getColumn(pool, 999, 999);
    assert.equal(col, null);
  });

  it('countColumns harus menghitung total kolom tersimpan', async () => {
    await repo.upsertColumnsBatch(pool, [
      { x: 1, z: 1, surfaceY: 64, blockStateId: 8, blockName: 'grass_block', source: 'passive' },
      { x: 2, z: 2, surfaceY: 64, blockStateId: 8, blockName: 'grass_block', source: 'passive' }
    ]);

    const count = await repo.countColumns(pool);
    assert.equal(count, 2);
  });

  it('upsertColumnsBatch dengan array kosong harus mengembalikan 0 tanpa error', async () => {
    const inserted = await repo.upsertColumnsBatch(pool, []);
    assert.equal(inserted, 0);
  });
});
