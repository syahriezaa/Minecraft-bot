/**
 * @file terrainBaselineRepository.js
 * @description CRUD untuk tabel terrain_surface_baseline - baseline permukaan dunia persisten
 * lintas sesi. Dikumpulkan pasif dari tiap chunk nyata yang pernah dimuat bot manapun (lihat
 * terrainBaselineRecorder.js), plus opsional dari sesi eksplorasi khusus. Tujuannya menjawab
 * batas "cache-frontier": pathfinding / navigasi jarak jauh sebelumnya cuma bisa merencanakan di area yang
 * ter-cache pada SESI ITU SAJA - tabel ini membuat pengetahuan bertahan lintas sesi.
 */

const { pool: defaultPool } = require('../config/database');

/**
 * Menyimpan sekumpulan kolom (x,z) sekaligus lewat UNNEST + upsert (data terbaru menang).
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {Array<{x:number,z:number,surfaceY:number,blockStateId:number|null,blockName:string|null,source?:string}>} columns
 * @returns {Promise<number>} Jumlah baris yang di-insert/update
 */
async function upsertColumnsBatch(pool = defaultPool, columns = []) {
  if (!Array.isArray(columns) || columns.length === 0) return 0;

  const xs = [];
  const zs = [];
  const surfaceYs = [];
  const blockStateIds = [];
  const blockNames = [];
  const sources = [];

  for (const col of columns) {
    xs.push(Math.trunc(col.x));
    zs.push(Math.trunc(col.z));
    surfaceYs.push(Math.trunc(col.surfaceY));
    blockStateIds.push(col.blockStateId ?? null);
    blockNames.push(col.blockName ?? null);
    sources.push(col.source || 'passive');
  }

  const { rowCount } = await pool.query(
    `
    INSERT INTO terrain_surface_baseline (x, z, surface_y, block_state_id, block_name, source, updated_at)
    SELECT x, z, surface_y, block_state_id, block_name, source, NOW()
    FROM unnest(
      $1::int[], $2::int[], $3::int[], $4::int[], $5::varchar[], $6::varchar[]
    ) AS t(x, z, surface_y, block_state_id, block_name, source)
    ON CONFLICT (x, z) DO UPDATE SET
      surface_y = EXCLUDED.surface_y,
      block_state_id = EXCLUDED.block_state_id,
      block_name = EXCLUDED.block_name,
      source = EXCLUDED.source,
      updated_at = NOW()
    `,
    [xs, zs, surfaceYs, blockStateIds, blockNames, sources]
  );

  return rowCount;
}

/**
 * Mengambil satu kolom (x,z). Mengembalikan null kalau belum pernah tersimpan.
 * @param {import('pg').Pool} [pool=defaultPool]
 */
async function getColumn(pool = defaultPool, x, z) {
  const { rows } = await pool.query(
    'SELECT x, z, surface_y, block_state_id, block_name, source, updated_at FROM terrain_surface_baseline WHERE x = $1 AND z = $2',
    [Math.trunc(x), Math.trunc(z)]
  );
  return rows[0] || null;
}

/**
 * Mengambil seluruh kolom dalam rentang persegi (inklusif) - dipakai untuk memuat baseline ke
 * memori sebelum sesi navigasi dimulai.
 * @param {import('pg').Pool} [pool=defaultPool]
 */
async function getColumnsInBounds(pool = defaultPool, minX, maxX, minZ, maxZ) {
  const { rows } = await pool.query(
    'SELECT x, z, surface_y, block_state_id, block_name, source, updated_at FROM terrain_surface_baseline WHERE x BETWEEN $1 AND $2 AND z BETWEEN $3 AND $4',
    [Math.trunc(minX), Math.trunc(maxX), Math.trunc(minZ), Math.trunc(maxZ)]
  );
  return rows;
}

/**
 * Menghitung total kolom yang sudah tersimpan di baseline.
 * @param {import('pg').Pool} [pool=defaultPool]
 */
async function countColumns(pool = defaultPool) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM terrain_surface_baseline');
  return rows[0].count;
}

module.exports = {
  upsertColumnsBatch,
  getColumn,
  getColumnsInBounds,
  countColumns
};
