/**
 * @file sweepHoleDetector.js
 * @description Deteksi "lubang" (kolom x,z yang seharusnya tercakup area sapuan tapi belum punya
 * simpul) dan pengelompokan lubang-lubang berdekatan jadi klaster, supaya bisa ditambal dengan
 * sapuan tambahan yang TARGET (bukan sapuan ulang seluruh area). Murni fungsi, tidak menyentuh
 * jaringan/RCON - itu tugas gridSweepViaRcon.js.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

// Cari semua kolom (x,z) di dalam batas persegi [minX..maxX] x [minZ..maxZ] yang TIDAK punya simpul
// di graf - ini "lubang" mentah, sebelum dikelompokkan.
function findMissingColumns(nodes, bounds) {
  const known = new Set(nodes.map((n) => `${n.x},${n.z}`));
  const missing = [];
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
      if (!known.has(`${x},${z}`)) missing.push({ x, z });
    }
  }
  return missing;
}

// Kelompokkan kolom yang hilang jadi klaster (union-find grid sederhana - dua titik satu klaster
// kalau jaraknya <= clusterRadius) supaya satu lubang besar cukup ditambal dengan SATU titik
// teleport ke tengahnya, bukan satu per kolom (bisa ribuan kolom per lubang).
function clusterHoles(missingColumns, clusterRadius = 8) {
  if (missingColumns.length === 0) return [];

  const parent = missingColumns.map((_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

  // Grid spasial kasar untuk hindari O(n^2) - kelompokkan dulu per sel clusterRadius, cuma
  // bandingkan titik dalam sel yang sama atau bertetangga.
  const cellSize = clusterRadius;
  const grid = new Map();
  missingColumns.forEach((p, i) => {
    const cx = Math.floor(p.x / cellSize), cz = Math.floor(p.z / cellSize);
    const key = `${cx},${cz}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });

  missingColumns.forEach((p, i) => {
    const cx = Math.floor(p.x / cellSize), cz = Math.floor(p.z / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const neighbors = grid.get(`${cx + dx},${cz + dz}`);
        if (!neighbors) continue;
        for (const j of neighbors) {
          if (j <= i) continue;
          const q = missingColumns[j];
          if (Math.hypot(p.x - q.x, p.z - q.z) <= clusterRadius) union(i, j);
        }
      }
    }
  });

  const groups = new Map();
  missingColumns.forEach((p, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  });

  return Array.from(groups.values()).map((points) => {
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cz = points.reduce((s, p) => s + p.z, 0) / points.length;
    // Sertakan kotak pembatas (bounding box) DAN titik-titik mentah - ditemukan dari bug live nyata:
    // lubang besar tidak bisa ditambal dengan SATU teleport ke titik tengah (satu burst cuma
    // menutupi ~2300 kolom), tapi kotak pembatas SENDIRI bisa menyesatkan (union-find bisa
    // menyambungkan banyak celah kecil yang tersebar jauh jadi satu "klaster" dengan bbox raksasa,
    // padahal isinya jarang - lihat sampleSpreadPoints di patchSweepHoles.js yang sampling dari
    // TITIK MENTAH ini, bukan menggrid seluruh bbox membabi buta).
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    return { x: Math.round(cx), z: Math.round(cz), size: points.length, minX, maxX, minZ, maxZ, points };
  });
}

module.exports = { findMissingColumns, clusterHoles };
