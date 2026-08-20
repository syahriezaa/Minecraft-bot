/**
 * @file digAndReseal.js
 * @description Gali SATU blok penghalang (mis. dinding kandang villager) supaya bot bisa lewat,
 * lalu tambal kembali dengan blok cadangan dari inventaris - dipakai saat bot terjebak di ruang
 * tertutup (canDig sengaja DIMATIKAN di walkToBase.js, lihat komentar di sana) tapi satu-satunya
 * jalan keluar memang harus menggali. Beda dari canDig=true bawaan mineflayer-pathfinder: itu
 * menggali TAPI TIDAK PERNAH menambal kembali - modul ini SELALU mencoba menambal begitu selesai,
 * supaya struktur pemilik (mis. kandang villager) tidak dibiarkan bolong permanen.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

async function digAndReseal({ bot, digPos, referencePos, faceVector, replacementItemNames, log = () => {} }) {
  const targetBlock = bot.blockAt(digPos);
  if (!targetBlock) throw new Error('Blok penghalang tidak ditemukan di posisi yang diberikan.');
  log(`Menggali blok penghalang di (${digPos.x},${digPos.y},${digPos.z})...`);
  await bot.dig(targetBlock);

  const spareItem = bot.inventory.items().find((it) => replacementItemNames.includes(it.name));
  if (!spareItem) {
    log('Tidak ada blok cadangan yang cocok di inventaris - dinding dibiarkan terbuka.');
    return { resealed: false };
  }

  await bot.equip(spareItem, 'hand');
  const referenceBlock = bot.blockAt(referencePos);
  if (!referenceBlock) throw new Error('Blok referensi untuk menambal tidak ditemukan.');
  await bot.placeBlock(referenceBlock, faceVector);
  log('Dinding berhasil ditambal kembali.');
  return { resealed: true };
}

module.exports = { digAndReseal };
