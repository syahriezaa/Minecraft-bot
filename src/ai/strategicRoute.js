/**
 * @file strategicRoute.js
 * @description Lapisan rute STRATEGIS: rantai waypoint dari start ke goal, "tebakan" garis lurus
 * yang dipertahankan sebagai komitmen arah jangka panjang. Ini sengaja TIDAK tahu apa-apa soal
 * rintangan/blok nyata (itu tugas findPath/A* di pathfinder.js dan findWideEscapeRoute di
 * richVoxelSpatialEngine.js, yang beroperasi TAKTIS di sekitar waypoint aktif saat ini).
 *
 * Alasan lapisan ini perlu ada: tanpanya, target navigasi dihitung ulang tiap siklus dari heading
 * "sekarang menuju goal akhir" dibatasi wilayah chunk yang sudah dimuat (lihat findCachedFrontier
 * di walk_to_base_physics.js) - begitu jalur lokal buntu dan bot mundur/menyimpang sedikit, heading
 * berikutnya bisa berubah drastis, menghasilkan osilasi bolak-balik tanpa progres bersih (terlihat
 * nyata di live run: X terkunci ratusan tick, cuma bergeser di Z). Rantai waypoint memberi target
 * antara yang TETAP dan pendek jaraknya (biasanya masih dalam cakupan chunk yang sudah/segera
 * dimuat), jadi A* taktis dan bakal segera "tebakan ulang" (predict again) begitu waypoint tercapai
 * atau chunk baru terbuka, sambil tetap berkomitmen ke arah keseluruhan.
 */

function buildWaypointChain(start, goal, spacing) {
  const dx = goal.x - start.x;
  const dz = goal.z - start.z;
  const totalDist = Math.hypot(dx, dz);

  if (totalDist < 1e-6) {
    return [{ x: start.x, z: start.z }];
  }

  const segments = Math.max(1, Math.ceil(totalDist / spacing));
  const chain = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    chain.push({ x: start.x + dx * t, z: start.z + dz * t });
  }
  return chain;
}

function advanceWaypoint(chain, currentIndex, pos, reachRadius) {
  // Cari waypoint TERJAUH di depan yang sudah dalam jangkauan (bukan cuma waypoint berikutnya
  // secara berurutan) - kalau bot ternyata sudah dekat dengan waypoint yang lebih jauh (jalan
  // pintas nyata, atau lompatan besar dari escape/A*), lewati semua yang di antaranya sekaligus.
  let furthestReached = currentIndex;
  for (let j = currentIndex + 1; j < chain.length; j++) {
    const wp = chain[j];
    const dist = Math.hypot(wp.x - pos.x, wp.z - pos.z);
    if (dist <= reachRadius) furthestReached = j;
  }
  return furthestReached;
}

// Titik proyeksi tegak lurus TERDEKAT di atas segmen lineStart->lineEnd - dijepit ke ujung segmen
// kalau proyeksi jatuh di luar (bukan garis tak berhingga). Dipakai sebagai target "tarik kembali"
// begitu bot menyimpang terlalu jauh dari garis utama (lihat distanceToLine).
function closestPointOnLine(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dz = lineEnd.z - lineStart.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-9) return { x: lineStart.x, z: lineStart.z };

  let t = ((point.x - lineStart.x) * dx + (point.z - lineStart.z) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: lineStart.x + dx * t, z: lineStart.z + dz * t };
}

// Jarak tegak lurus dari suatu posisi ke garis utama (segmen spawn->goal) - dipakai untuk mendeteksi
// seberapa jauh navigasi taktis (wall-follow/escape) sudah membawa bot menyimpang dari rute ideal,
// supaya bisa ditarik kembali sebelum menyimpang terlalu jauh (lihat runWalkToBaseBot.js).
function distanceToLine(point, lineStart, lineEnd) {
  const closest = closestPointOnLine(point, lineStart, lineEnd);
  return Math.hypot(point.x - closest.x, point.z - closest.z);
}

module.exports = { buildWaypointChain, advanceWaypoint, distanceToLine, closestPointOnLine };
