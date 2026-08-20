/**
 * @file mineflayerVersionPatch.js
 * @description Tambalan SEMENTARA untuk gerbang whitelist versi mineflayer (lib/version.js, di-
 * hardcode maksimal '1.21.11' di rilis 4.37.1). Server nyata proyek ini berjalan di 26.1.2
 * (protokol 775, skema versi baru Mojang berbasis tahun) - datanya SUDAH lengkap di minecraft-data
 * (dikonfirmasi lewat probe langsung ke server: block/dunia ter-decode benar dengan nama blok yang
 * tepat, dan gerakan lewat mineflayer-pathfinder berjalan penuh sampai tujuan), cuma rilis
 * mineflayer di npm belum memperbarui whitelist internalnya - ini keterlambatan rilis library, BUKAN
 * ketidakcocokan protokol sungguhan.
 *
 * WAJIB dipanggil SEBELUM 'mineflayer' pertama kali di-require di proses manapun - module cache
 * Node bersifat global per proses, jadi begitu 'mineflayer/lib/version.js' sudah di-require dengan
 * nilai asli di tempat lain lebih dulu, gerbangnya sudah kadung dibaca dengan nilai lama.
 *
 * Hapus file ini (dan setiap pemanggilnya) begitu mineflayer resmi merilis dukungan native untuk
 * versi ini - lihat CHANGELOG mineflayer di https://github.com/PrismarineJS/mineflayer.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

function patchMineflayerVersionGate(targetVersion) {
  const versionModulePath = require.resolve('mineflayer/lib/version.js');
  const current = require(versionModulePath);
  if (current.testedVersions.includes(targetVersion) && current.latestSupportedVersion === targetVersion) return;
  require.cache[versionModulePath].exports = {
    testedVersions: [...new Set([...current.testedVersions, targetVersion])],
    latestSupportedVersion: targetVersion,
    oldestSupportedVersion: current.oldestSupportedVersion
  };
}

module.exports = { patchMineflayerVersionGate };
