/**
 * @file strategic_route.test.js
 * @description Uji unit lapisan rute STRATEGIS (rantai waypoint dari start ke goal, "tebakan"
 * jalur lurus yang dipertahankan/diikuti secara konsisten) - berbeda dari findPath/A* yang cuma
 * TAKTIS (jarak pendek, dibatasi wilayah chunk yang sudah dimuat). Tanpa lapisan ini, target lokal
 * dihitung ulang dari heading "sekarang" tiap siklus dan gampang berosilasi bolak-balik begitu ada
 * rintangan - rantai waypoint memberi komitmen arah yang stabil, cuma maju ke waypoint berikutnya
 * kalau yang sekarang sudah benar-benar dekat dicapai.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildWaypointChain, advanceWaypoint, distanceToLine, closestPointOnLine } = require('../../src/ai/strategicRoute');

describe('buildWaypointChain', () => {
  it('harus menghasilkan titik awal dan titik akhir yang persis sama dengan start/goal', () => {
    const chain = buildWaypointChain({ x: 0, z: 0 }, { x: 100, z: 0 }, 24);

    assert.equal(chain[0].x, 0);
    assert.equal(chain[0].z, 0);
    const last = chain[chain.length - 1];
    assert.equal(last.x, 100);
    assert.equal(last.z, 0);
  });

  it('harus membagi rata semua segmen (bukan segmen terakhir yang pendek sendirian), tidak melebihi spacing', () => {
    const chain = buildWaypointChain({ x: 0, z: 0 }, { x: 100, z: 0 }, 24);

    const distances = [];
    for (let i = 1; i < chain.length; i++) {
      distances.push(Math.hypot(chain[i].x - chain[i - 1].x, chain[i].z - chain[i - 1].z));
    }
    for (const d of distances) assert.ok(d <= 24 + 0.01, `segmen tidak boleh melebihi spacing, dapat ${d}`);
    for (const d of distances) assert.ok(Math.abs(d - distances[0]) < 0.01, 'semua segmen harus sama panjang (pembagian rata)');
  });

  it('harus tetap menghasilkan chain valid kalau jarak start-goal lebih pendek dari spacing', () => {
    const chain = buildWaypointChain({ x: 0, z: 0 }, { x: 10, z: 0 }, 24);

    assert.equal(chain.length, 2);
    assert.equal(chain[0].x, 0);
    assert.equal(chain[1].x, 10);
  });

  it('harus menghasilkan chain diagonal yang benar (start == goal secara koordinat integer tetap 1 titik)', () => {
    const chain = buildWaypointChain({ x: 5, z: 5 }, { x: 5, z: 5 }, 24);

    assert.equal(chain.length, 1);
  });
});

describe('advanceWaypoint', () => {
  const chain = [
    { x: 0, z: 0 },
    { x: 24, z: 0 },
    { x: 48, z: 0 },
  ];

  it('harus TETAP di index sekarang kalau posisi masih jauh dari waypoint aktif', () => {
    const nextIndex = advanceWaypoint(chain, 0, { x: 5, z: 0 }, 6);
    assert.equal(nextIndex, 0);
  });

  it('harus maju ke index berikutnya begitu posisi dalam radius jangkau dari waypoint aktif', () => {
    const nextIndex = advanceWaypoint(chain, 0, { x: 22, z: 0 }, 6);
    assert.equal(nextIndex, 1);
  });

  it('harus bisa melompati lebih dari 1 waypoint kalau posisi sudah dekat dengan waypoint yang lebih jauh (mis. jalan pintas nyata)', () => {
    const nextIndex = advanceWaypoint(chain, 0, { x: 46, z: 0 }, 6);
    assert.equal(nextIndex, 2);
  });

  it('tidak boleh melewati index terakhir (goal) walau posisi sudah lebih jauh dari goal', () => {
    const nextIndex = advanceWaypoint(chain, 2, { x: 100, z: 0 }, 6);
    assert.equal(nextIndex, 2);
  });
});

describe('distanceToLine - seberapa jauh posisi menyimpang dari garis lurus utama (spawn->goal)', () => {
  it('harus mengembalikan 0 untuk titik yang PERSIS di atas garis', () => {
    const d = distanceToLine({ x: 5, z: 0 }, { x: 0, z: 0 }, { x: 10, z: 0 });
    assert.equal(d, 0);
  });

  it('harus mengembalikan jarak tegak lurus yang benar untuk titik di samping garis', () => {
    const d = distanceToLine({ x: 5, z: 8 }, { x: 0, z: 0 }, { x: 10, z: 0 });
    assert.equal(d, 8);
  });

  it('harus tetap benar untuk garis diagonal (bukan cuma sumbu lurus)', () => {
    // Garis dari (0,0) ke (10,10) - titik (10,0) berjarak tegak lurus 10/sqrt(2) dari garis itu.
    const d = distanceToLine({ x: 10, z: 0 }, { x: 0, z: 0 }, { x: 10, z: 10 });
    assert.ok(Math.abs(d - 10 / Math.sqrt(2)) < 0.001, `dapat ${d}`);
  });

  it('harus memakai jarak ke UJUNG segmen kalau proyeksi jatuh di luar segmen (bukan garis tak berhingga)', () => {
    // Titik JAUH di belakang start (0,0), bukan di antara start-goal - jarak ke segmen = jarak ke (0,0).
    const d = distanceToLine({ x: -5, z: 3 }, { x: 0, z: 0 }, { x: 10, z: 0 });
    assert.ok(Math.abs(d - Math.hypot(5, 3)) < 0.001, `dapat ${d}`);
  });
});

describe('closestPointOnLine - dipakai untuk "tarik kembali ke garis utama" saat menyimpang terlalu jauh', () => {
  it('harus mengembalikan titik proyeksi tegak lurus di atas segmen', () => {
    const p = closestPointOnLine({ x: 5, z: 8 }, { x: 0, z: 0 }, { x: 10, z: 0 });
    assert.ok(Math.abs(p.x - 5) < 0.001 && Math.abs(p.z - 0) < 0.001, `dapat (${p.x},${p.z})`);
  });

  it('harus dijepit ke ujung segmen kalau proyeksi jatuh di luar (tidak pernah melewati start atau goal)', () => {
    const p = closestPointOnLine({ x: -5, z: 3 }, { x: 0, z: 0 }, { x: 10, z: 0 });
    assert.ok(Math.abs(p.x - 0) < 0.001 && Math.abs(p.z - 0) < 0.001, `harus dijepit ke start (0,0), dapat (${p.x},${p.z})`);
  });
});
