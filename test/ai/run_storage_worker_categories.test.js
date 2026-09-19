/**
 * @file run_storage_worker_categories.test.js
 * @description Unit test peta nama kategori chest gudang (CHEST_CATEGORY_LABELS) - dipakai
 * dashboard untuk menampilkan nama kategori manusiawi per posisi chest, bukan cuma koordinat
 * mentah. Permintaan nyata pemilik: "di ui tampilan peti nya rapikan urut baris dan kolom nya
 * dan berikan nama kategorinya".
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const { CHEST_CATEGORY_LABELS, canonicalContainerPosition } = require('../../src/ai/runStorageWorker');

describe('CHEST_CATEGORY_LABELS', () => {
  it('harus punya nama kategori untuk chest utama yang sudah didaftarkan (mis. bahan berharga di -181,74,-353)', () => {
    assert.equal(CHEST_CATEGORY_LABELS['-181,74,-353'], 'Bahan Berharga (Ore Olahan)');
    assert.equal(CHEST_CATEGORY_LABELS['-181,73,-353'], 'Bijih Mentah');
  });

  it('chest (bukan barel) HARUS punya label yang sama di pasangan double-chest fisiknya (x=-180 di z & y yang sama) - permintaan nyata pemilik sebelumnya: pasangan double-chest sungguhan selalu x=-181 dengan x=-180', () => {
    assert.equal(CHEST_CATEGORY_LABELS['-180,74,-353'], CHEST_CATEGORY_LABELS['-181,74,-353'], 'pasangan fisik chest yang sama harus tampil sebagai kategori yang sama');
    assert.equal(CHEST_CATEGORY_LABELS['-180,73,-352'], 'Bahan Bangunan');
  });

  it('barel (armor, buku, perkakas, dst) TIDAK boleh punya pasangan bergabung - x=-180 di posisi yang sama TIDAK otomatis mewarisi label barel itu, karena barel tidak pernah menyatu fisik dengan blok lain', () => {
    assert.equal(CHEST_CATEGORY_LABELS['-181,71,-351'], 'Armor');
    assert.notEqual(CHEST_CATEGORY_LABELS['-180,71,-351'], 'Armor');
  });
});

test('canonicalContainerPosition menyatukan pasangan double chest tetapi tidak barel', () => {
  const types = new Map([
    ['-181,71,-352', 'right'],
    ['-180,71,-352', 'left']
  ]);
  const adapter = { getChestHalfType: position => types.get(`${position.x},${position.y},${position.z}`) || null };
  assert.deepEqual(canonicalContainerPosition(adapter, { x: -180, y: 71, z: -352 }), { x: -181, y: 71, z: -352 });
  assert.deepEqual(canonicalContainerPosition(adapter, { x: -181, y: 71, z: -351 }), { x: -181, y: 71, z: -351 });
});
