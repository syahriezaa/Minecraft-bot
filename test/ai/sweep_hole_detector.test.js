/**
 * @file sweep_hole_detector.test.js
 * @description Uji unit deteksi lubang (kolom yang belum tercakup) & pengelompokan lubang jadi
 * klaster - dipakai untuk menambal sapuan grid besar (mis. 1000x1000) tanpa menyapu ulang semuanya.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findMissingColumns, clusterHoles } = require('../../src/ai/sweepHoleDetector');

describe('findMissingColumns', () => {
  it('harus mengembalikan array kosong kalau semua kolom dalam batas sudah punya simpul', () => {
    const nodes = [];
    for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) nodes.push({ x, y: 64, z });

    const missing = findMissingColumns(nodes, { minX: 0, maxX: 2, minZ: 0, maxZ: 2 });

    assert.equal(missing.length, 0);
  });

  it('harus menemukan kolom yang hilang di tengah area yang sebagian besar tercakup', () => {
    const nodes = [];
    for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) {
      if (x === 2 && z === 2) continue; // lubang tunggal di tengah
      nodes.push({ x, y: 64, z });
    }

    const missing = findMissingColumns(nodes, { minX: 0, maxX: 4, minZ: 0, maxZ: 4 });

    assert.equal(missing.length, 1);
    assert.deepEqual(missing[0], { x: 2, z: 2 });
  });
});

describe('clusterHoles', () => {
  it('harus mengembalikan array kosong kalau tidak ada lubang', () => {
    assert.deepEqual(clusterHoles([]), []);
  });

  it('kolom-kolom yang berdekatan harus digabung jadi SATU klaster dengan titik tengah yang benar', () => {
    const missing = [{ x: 10, z: 10 }, { x: 11, z: 10 }, { x: 10, z: 11 }, { x: 11, z: 11 }];

    const clusters = clusterHoles(missing, 8);

    assert.equal(clusters.length, 1, 'empat kolom berdekatan harus jadi satu klaster');
    assert.equal(clusters[0].size, 4);
    assert.equal(clusters[0].x, Math.round(10.5));
    assert.equal(clusters[0].z, Math.round(10.5));
  });

  it('dua lubang yang jauh terpisah harus jadi DUA klaster berbeda, bukan digabung', () => {
    const missing = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 500, z: 500 }, { x: 501, z: 500 }];

    const clusters = clusterHoles(missing, 8);

    assert.equal(clusters.length, 2, 'dua kelompok jauh terpisah harus jadi dua klaster');
  });

  it('tiap klaster harus menyertakan kotak pembatas (bounding box), bukan cuma titik tengah - dipakai untuk memutuskan kapan lubang perlu sapuan mini (beberapa titik), bukan cuma satu tambalan', () => {
    const missing = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }];

    const clusters = clusterHoles(missing, 24);

    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].x, 5);
    assert.equal(clusters[0].z, 5);
    assert.equal(clusters[0].size, 4);
    assert.deepEqual({ minX: clusters[0].minX, maxX: clusters[0].maxX, minZ: clusters[0].minZ, maxZ: clusters[0].maxZ }, { minX: 0, maxX: 10, minZ: 0, maxZ: 10 });
    assert.equal(clusters[0].points.length, 4, 'harus menyertakan titik-titik mentah, dipakai patchSweepHoles.js untuk sampling lubang besar');
  });

  it('lubang besar (banyak kolom bersambung) tetap harus jadi satu klaster kalau semua dalam jangkauan clusterRadius berantai', () => {
    // Rantai kolom bersambung 0,0 -> 5,0 -> 10,0 -> 15,0 (tiap loncatan 5, dalam radius 8) - harus
    // tetap satu klaster besar walau ujung-ke-ujung jaraknya (15) melebihi clusterRadius sendiri.
    const missing = [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 10, z: 0 }, { x: 15, z: 0 }];

    const clusters = clusterHoles(missing, 8);

    assert.equal(clusters.length, 1, 'rantai kolom bersambung harus tetap satu klaster (union-find transitif)');
    assert.equal(clusters[0].size, 4);
  });
});
