/**
 * @file rewardMap.js
 * @description Peta reward/punishment PERSISTEN per kolom (x,z), berbeda dari blacklist escape yang
 * berbasis waktu (recentEscapeTargets di runWalkToBaseBot.js, lupa dalam ~6 detik). Skor di sini
 * TERAKUMULASI sepanjang sesi berjalan: kolom yang berulang kali dikunjungi/dituju tanpa progres
 * nyata makin lama makin dihukum dan makin dihindari secara permanen - inilah yang membedakan
 * "berputar sebentar lalu lupa" (blacklist lama) dari "benar-benar berhenti mengulang lingkaran yang
 * sama" (peta ini). Dipakai sebagai gerbang tambahan saat memilih target escape/frontier, dan
 * diekspos ke UI (Decision Inspector / Chunk Matrix) supaya terlihat kolom mana yang sedang
 * "dipercaya" vs "dicurigai" oleh bot.
 */

const HEAVILY_PUNISHED_THRESHOLD = -4;

function createRewardMap() {
  const scores = new Map();

  function key(x, z) {
    return `${Math.round(x)},${Math.round(z)}`;
  }

  function reward(x, z, amount = 1) {
    const k = key(x, z);
    scores.set(k, (scores.get(k) || 0) + amount);
  }

  function punish(x, z, amount = 1) {
    const k = key(x, z);
    scores.set(k, (scores.get(k) || 0) - amount);
  }

  function getScore(x, z) {
    return scores.get(key(x, z)) || 0;
  }

  function isHeavilyPunished(x, z) {
    return getScore(x, z) <= HEAVILY_PUNISHED_THRESHOLD;
  }

  function getAllScores() {
    return Array.from(scores.entries()).map(([k, score]) => {
      const [x, z] = k.split(',').map(Number);
      return { x, z, score };
    });
  }

  return { reward, punish, getScore, isHeavilyPunished, getAllScores };
}

module.exports = { createRewardMap };
