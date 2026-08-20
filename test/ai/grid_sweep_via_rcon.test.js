/**
 * @file grid_sweep_via_rcon.test.js
 * @description Uji unit buildGridPoints - bagian PURE (tanpa jaringan/RCON) dari gridSweepViaRcon.js
 * yang menyusun titik-titik teleport untuk sapuan grid area luas (mis. 1000x1000 blok).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildGridPoints, partitionPoints, buildWorkerBotName } = require('../../src/ai/gridSweepViaRcon');

describe('buildGridPoints', () => {
  it('harus mencakup titik pusat dan kedua ujung area (bukan cuma satu sisi)', () => {
    const points = buildGridPoints({ x: 0, z: 0 }, 100, 50);

    assert.ok(points.some((p) => p.x === -50 && p.z === -50), 'harus mencakup sudut kiri-atas');
    assert.ok(points.some((p) => p.x === 50 && p.z === 50), 'harus mencakup sudut kanan-bawah');
    assert.ok(points.some((p) => p.x === 0 && p.z === 0), 'harus mencakup titik tengah');
  });

  it('jumlah titik harus sesuai grid persegi (sizeBlocks/spacing + 1) di tiap sumbu', () => {
    const points = buildGridPoints({ x: 0, z: 0 }, 100, 50);

    // -50, 0, 50 di tiap sumbu = 3x3 = 9 titik
    assert.equal(points.length, 9);
  });

  it('titik harus digeser sesuai pusat yang diberikan (bukan selalu berpusat di 0,0)', () => {
    const points = buildGridPoints({ x: 500, z: -300 }, 100, 50);

    assert.ok(points.every((p) => p.x >= 450 && p.x <= 550));
    assert.ok(points.every((p) => p.z >= -350 && p.z <= -250));
    assert.ok(points.some((p) => p.x === 500 && p.z === -300));
  });

  it('urutan harus berbentuk "ular" (snake) - kolom berurutan naik lalu turun bergantian, bukan lompat acak', () => {
    const points = buildGridPoints({ x: 0, z: 0 }, 100, 50);

    // Kolom pertama (x=-50) harus naik z: -50,0,50 - kolom kedua (x=0) harus turun: 50,0,-50
    const col1 = points.filter((p) => p.x === -50).map((p) => p.z);
    const col2 = points.filter((p) => p.x === 0).map((p) => p.z);
    assert.deepEqual(col1, [-50, 0, 50]);
    assert.deepEqual(col2, [50, 0, -50]);
  });
});

describe('partitionPoints - membagi titik grid ke N bot paralel', () => {
  it('harus membagi HABIS semua titik tanpa ada yang hilang atau terduplikasi', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ x: i, z: 0 }));

    const buckets = partitionPoints(points, 10);

    const total = buckets.reduce((s, b) => s + b.length, 0);
    assert.equal(total, 100, 'total titik di semua bucket harus sama dengan jumlah titik asli');
    const allX = new Set(buckets.flat().map((p) => p.x));
    assert.equal(allX.size, 100, 'tidak boleh ada titik yang terduplikasi atau hilang');
  });

  it('harus menghasilkan tepat workerCount bucket, walau jumlah titik tidak habis dibagi', () => {
    const points = Array.from({ length: 23 }, (_, i) => ({ x: i, z: 0 }));

    const buckets = partitionPoints(points, 5);

    assert.equal(buckets.length, 5);
  });

  it('pembagian harus selang-seling (round-robin), bukan blok berurutan - supaya tiap bot langsung mencakup berbagai bagian peta sejak awal', () => {
    const points = Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 }));

    const buckets = partitionPoints(points, 3);

    assert.deepEqual(buckets[0].map((p) => p.x), [0, 3]);
    assert.deepEqual(buckets[1].map((p) => p.x), [1, 4]);
    assert.deepEqual(buckets[2].map((p) => p.x), [2, 5]);
  });
});

describe('buildWorkerBotName - nama akun worker sapuan', () => {
  it('harus SELALU di bawah batas 16 karakter Minecraft, untuk index berapapun yang wajar (sampai 20 worker)', () => {
    // Ditemukan dari bug live nyata: "AutoCompanionBot" SUDAH pas 16 karakter, jadi menambah sufiks
    // (mis. "AutoCompanionBot_S1", 20 karakter) DIPOTONG DIAM-DIAM oleh server jadi 16 karakter
    // pertama - "AutoCompanionBot" polos - membuat SEMUA worker bentrok login sebagai akun yang
    // sama (dikonfirmasi lewat UUID identik di log server). Nama worker HARUS pendek dari awal.
    for (let i = 0; i < 20; i++) {
      const name = buildWorkerBotName(i);
      assert.ok(name.length <= 16, `nama worker "${name}" (index ${i}) melebihi 16 karakter (${name.length})`);
    }
  });

  it('nama worker harus unik untuk tiap index (tidak boleh ada tabrakan)', () => {
    const names = new Set();
    for (let i = 0; i < 20; i++) names.add(buildWorkerBotName(i));

    assert.equal(names.size, 20, 'semua nama worker harus berbeda satu sama lain');
  });
});
