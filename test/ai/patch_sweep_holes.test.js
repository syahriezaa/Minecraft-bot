/**
 * @file patch_sweep_holes.test.js
 * @description Uji unit bagian PURE (tanpa jaringan/RCON) dari patchSweepHoles.js - sampleSpreadPoints
 * & expandClusterToTargets. Ditemukan dari bug live nyata: lubang besar (ratusan ribu kolom) tidak
 * bisa ditambal dengan SATU titik teleport ke tengahnya - satu burst chunk cuma menutupi ~2300
 * kolom. Fungsi ini mengubah lubang besar jadi beberapa titik tersebar yang benar-benar mewakili
 * di mana kolom kosongnya ada (bukan menggrid seluruh kotak pembatas membabi buta, yang bisa jadi
 * sangat besar & jarang isinya kalau union-find menyambungkan celah-celah kecil yang tersebar jauh).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sampleSpreadPoints, expandClusterToTargets } = require('../../src/ai/patchSweepHoles');

describe('sampleSpreadPoints', () => {
  it('titik-titik yang berdekatan (dalam jarak spacing) cuma boleh diwakili SATU titik sampel', () => {
    const points = [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 10, z: 0 }]; // semua dalam radius 48

    const sampled = sampleSpreadPoints(points, 48, 40);

    assert.equal(sampled.length, 1, 'semua titik berdekatan harus diwakili satu sampel saja');
  });

  it('titik-titik yang jauh terpisah (lebih dari spacing) harus tetap diwakili titik TERPISAH', () => {
    const points = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 200, z: 0 }];

    const sampled = sampleSpreadPoints(points, 48, 40);

    assert.equal(sampled.length, 3, 'titik yang jauh terpisah tidak boleh digabung jadi satu sampel');
  });

  it('tidak boleh melebihi maxPoints walau titiknya jauh lebih banyak', () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ x: i * 100, z: 0 })); // semua jauh terpisah

    const sampled = sampleSpreadPoints(points, 48, 40);

    assert.equal(sampled.length, 40, 'harus berhenti tepat di batas maxPoints');
  });
});

describe('expandClusterToTargets', () => {
  it('klaster kecil (di bawah ambang) cuma jadi SATU target di titik tengahnya - tidak perlu sapuan mini', () => {
    const cluster = { x: 10, z: 10, size: 500, points: [{ x: 10, z: 10 }] };

    const targets = expandClusterToTargets(cluster, 48);

    assert.equal(targets.length, 1);
    assert.deepEqual(targets[0], { x: 10, z: 10, size: 500 });
  });

  it('klaster BESAR (di atas ambang) harus jadi BEBERAPA target tersebar, bukan satu titik tengah saja - ditemukan dari bug live nyata (lubang 488,727 kolom cuma tertambal sebagian kecil dengan satu titik)', () => {
    const points = [];
    for (let i = 0; i < 5000; i++) points.push({ x: (i % 50) * 100, z: Math.floor(i / 50) * 100 }); // tersebar luas
    const cluster = { x: 2450, z: 4900, size: points.length, points };

    const targets = expandClusterToTargets(cluster, 48);

    assert.ok(targets.length > 1, 'klaster besar harus menghasilkan lebih dari satu target teleport');
  });
});
