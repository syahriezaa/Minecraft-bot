const { describe, it } = require('node:test');
const assert = require('node:assert');
const { patchMineflayerVersionGate } = require('../../src/network/mineflayerVersionPatch');

describe('patchMineflayerVersionGate - tambalan gerbang whitelist versi mineflayer', () => {
  it('harus menambahkan versi target ke testedVersions dan menjadikannya latestSupportedVersion - server nyata proyek ini (26.1.2, skema versi baru Mojang) datanya sudah lengkap di minecraft-data, tapi rilis mineflayer di npm belum memperbarui whitelist internalnya sehingga createBot menolak koneksi padahal protokolnya sungguh kompatibel (dikonfirmasi lewat probe langsung: block/dunia ter-decode benar, movement/pathfinder jalan penuh)', () => {
    patchMineflayerVersionGate('26.1.2');
    const version = require('mineflayer/lib/version.js');
    assert.ok(version.testedVersions.includes('26.1.2'), 'testedVersions harus mencakup versi target');
    assert.equal(version.latestSupportedVersion, '26.1.2');
  });

  it('memanggil dua kali dengan versi yang sama tidak boleh menduplikasi entri di testedVersions', () => {
    patchMineflayerVersionGate('26.1.2');
    patchMineflayerVersionGate('26.1.2');
    const version = require('mineflayer/lib/version.js');
    const count = version.testedVersions.filter((v) => v === '26.1.2').length;
    assert.equal(count, 1);
  });

  it('tidak boleh menghapus oldestSupportedVersion asli - batas bawah versi lama tetap harus dihormati', () => {
    const before = require('mineflayer/lib/version.js').oldestSupportedVersion;
    patchMineflayerVersionGate('26.1.2');
    const after = require('mineflayer/lib/version.js').oldestSupportedVersion;
    assert.equal(after, before);
  });
});
