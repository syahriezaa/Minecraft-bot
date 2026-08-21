/**
 * @file storage_memory.test.js
 * @description Unit test memori sortir gudang yang DIBAGIKAN ke semua bot (bukan cuma
 * StorageWorker) - permintaan nyata pemilik: "share memory tentang peti ke semua bot agar dapat
 * mencari barang barang dan menaruh barang dengan tepat".
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('storageMemory', () => {
  let tmpFile;
  let storageMemory;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `test_storage_assignments_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    process.env.STORAGE_ASSIGNMENTS_FILE = tmpFile;
    delete require.cache[require.resolve('../../src/ai/storageMemory')];
    storageMemory = require('../../src/ai/storageMemory');
  });

  afterEach(() => {
    delete process.env.STORAGE_ASSIGNMENTS_FILE;
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('getSharedChestAssignments() harus tahu rumah baku ore/ingot dan gear walau belum pernah ada yang diantar sesi ini (belum ada apa-apa di disk)', () => {
    const assignments = storageMemory.getSharedChestAssignments();
    assert.equal(assignments.iron_ingot, '-181,74,-353');
    assert.equal(assignments.redstone, '-181,73,-353');
    assert.equal(assignments.enchanted_book, '-181,72,-351');
  });

  it('getSharedChestAssignments() harus MENGGABUNGKAN memori yang sudah dipelajari dari disk (item yang belum punya rumah baku) dengan rumah baku - permintaan nyata pemilik: worker lain harus bisa memakai memori yang SAMA persis dengan yang dipakai StorageWorker', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ some_modded_item: '-181,74,-345' }));
    const assignments = storageMemory.getSharedChestAssignments();
    assert.equal(assignments.some_modded_item, '-181,74,-345', 'item yang dipelajari dari disk harus ikut muncul');
    assert.equal(assignments.iron_ingot, '-181,74,-353', 'rumah baku tetap ada bersamaan');
  });

  it('rumah baku HARUS menang atas apapun yang (secara keliru) tersimpan di disk untuk item yang sama - permintaan nyata pemilik sebelumnya: "jika ada ore atau ingot di peti yang salah silahkan di pindahkan"', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ iron_ingot: '-181,71,-344' }));
    const assignments = storageMemory.getSharedChestAssignments();
    assert.equal(assignments.iron_ingot, '-181,74,-353', 'rumah baku iron_ingot harus tetap menang, bukan posisi keliru yang kebetulan tersimpan di disk');
  });

  it('RAW_ORE_CHEST harus punya cadangan darurat terdaftar di OVERFLOW_CHESTS - ditemukan celah nyata: konstanta RAW_ORE_OVERFLOW_CHEST sudah didefinisikan tapi tidak pernah dipasangkan ke OVERFLOW_CHESTS, jadi redstone/raw_iron dkk tidak punya jalan keluar darurat sama sekali', () => {
    assert.equal(storageMemory.OVERFLOW_CHESTS['-181,73,-353'], '-180,73,-351');
  });

  it('parseChestPositionKey harus mengubah string "x,y,z" jadi objek {x,y,z} - dipakai worker lain untuk menerjemahkan posisi dari memori bersama jadi format yang dipahami adapter (bot.openChest dst)', () => {
    assert.deepEqual(storageMemory.parseChestPositionKey('-181,74,-353'), { x: -181, y: 74, z: -353 });
  });
});
