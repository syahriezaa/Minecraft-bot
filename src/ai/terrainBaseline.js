/**
 * @file terrainBaseline.js
 * @description Ekstraksi permukaan dari chunk cache LiveProtocolClient + world accessor gabungan
 * (live cache -> baseline persisten PostgreSQL -> null). Menjawab batas "cache-frontier": rute
 * pathfinding sebelumnya cuma bisa merencanakan di area yang ter-cache pada SESI ITU SAJA -
 * baseline_recorder mengumpulkan surface tiap chunk yang pernah dimuat bot manapun secara pasif
 * ke database, supaya pengetahuan bertahan lintas sesi dan bertumbuh dari waktu ke waktu.
 *
 * Catatan penting: baseline hanya menyimpan SATU permukaan teratas per kolom (x,z), bukan data
 * voxel 3D penuh - cukup untuk perkiraan ketinggian tanah/kelayakan berjalan di jarak jauh, tapi
 * TIDAK bisa merepresentasikan gua/overhang. Di bawah surfaceY diasumsikan solid ('stone'), di
 * atasnya diasumsikan kosong ('air') - perkiraan yang jauh lebih baik daripada dunia superflat
 * palsu sebelumnya, tapi tetap sebuah perkiraan, bukan kepastian.
 */

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/**
 * Memindai satu chunk (16x16 kolom) di client.chunkCache untuk permukaan teratas non-udara per
 * kolom. Dipakai untuk mengumpulkan data ke terrain_surface_baseline setiap kali chunk_loaded.
 * @param {import('../network/liveProtocolClient').LiveProtocolClient} client
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {{ maxY?: number, minY?: number }} [options]
 */
function extractSurfaceColumns(client, chunkX, chunkZ, options = {}) {
  const maxY = options.maxY ?? 320;
  const minY = options.minY ?? -64;
  const columns = [];

  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const x = chunkX * 16 + lx;
      const z = chunkZ * 16 + lz;

      for (let y = maxY; y >= minY; y--) {
        const name = client.getBlockName(x, y, z);
        if (name === null) continue; // belum ter-cache di ketinggian ini, lanjut turun
        if (AIR_NAMES.has(name)) continue;

        columns.push({
          x,
          z,
          surfaceY: y,
          blockStateId: client.getBlockStateId(x, y, z),
          blockName: name
        });
        break;
      }
    }
  }

  return columns;
}

/**
 * Membuat worldAccessor dari peta kolom baseline (hasil terrainBaselineRepository.getColumnsInBounds,
 * dimuat ke Map "x,z" -> row). y===surfaceY -> nama blok asli, y>surfaceY -> 'air', y<surfaceY -> 'stone'.
 */
function createBaselineWorldAccessor(columnsMap) {
  return (x, y, z) => {
    const col = columnsMap.get(`${x},${z}`);
    if (!col) return null;
    if (y === col.surface_y) return col.block_name;
    if (y > col.surface_y) return 'air';
    return 'stone';
  };
}

/**
 * Menggabungkan world accessor live (prioritas) dengan baseline persisten (fallback saat live
 * tidak punya data). Kalau keduanya tidak punya data, kembalikan null (biarkan caller yang
 * memutuskan, sama seperti perilaku "chunk belum ter-cache" yang sudah ada sebelumnya).
 */
function createCombinedWorldAccessor(client, baselineAccessor) {
  return (x, y, z) => {
    const live = client.getBlockName(x, y, z);
    if (live !== null) return live;
    return baselineAccessor(x, y, z);
  };
}

/**
 * Menyambungkan LiveProtocolClient ke terrain_surface_baseline secara pasif: tiap chunk_loaded,
 * permukaannya diekstrak dan diantrikan, lalu di-flush ke database secara berkala (bukan tiap
 * chunk - supaya tidak membanjiri koneksi DB saat banyak chunk masuk sekaligus). Gagal simpan
 * tidak boleh menghentikan bot (cuma log error) - baseline adalah peningkatan, bukan dependensi
 * keras jalur gerak.
 * @param {import('../network/liveProtocolClient').LiveProtocolClient} client
 * @param {{ pool?: import('pg').Pool, source?: 'passive'|'exploration', flushIntervalMs?: number }} [options]
 */
function attachTerrainBaselineRecorder(client, options = {}) {
  const repo = require('../database/terrainBaselineRepository');
  const source = options.source || 'passive';
  const flushIntervalMs = options.flushIntervalMs ?? 5000;

  let pending = [];
  let totalSaved = 0;

  function onChunkLoaded({ chunkX, chunkZ }) {
    const columns = extractSurfaceColumns(client, chunkX, chunkZ);
    for (const col of columns) pending.push({ ...col, source });
  }

  async function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      const saved = await repo.upsertColumnsBatch(options.pool, batch);
      totalSaved += saved;
    } catch (err) {
      console.error(`❌ [TerrainBaseline] Gagal menyimpan batch (${batch.length} kolom): ${err.message}`);
    }
  }

  client.on('chunk_loaded', onChunkLoaded);
  const timer = setInterval(flush, flushIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    flushNow: flush,
    stop() {
      clearInterval(timer);
      client.off('chunk_loaded', onChunkLoaded);
      return flush();
    },
    getTotalSaved: () => totalSaved
  };
}

module.exports = {
  extractSurfaceColumns,
  createBaselineWorldAccessor,
  createCombinedWorldAccessor,
  attachTerrainBaselineRecorder
};
