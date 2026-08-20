/**
 * @file reward_map.test.js
 * @description Uji unit peta reward/punishment PERSISTEN per kolom (x,z) - beda dari blacklist
 * escape yang berbasis waktu (lupa dalam beberapa detik). Kolom yang berulang kali dikunjungi tanpa
 * progres nyata makin lama makin "dihukum" (skor makin negatif) dan makin dihindari SECARA PERMANEN
 * dalam sesi ini, bukan cuma sementara - inilah yang mencegah bot benar-benar berputar-putar di
 * lingkaran yang sama berkali-kali (kejadian nyata: bot "keep turning in circle").
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRewardMap } = require('../../src/ai/rewardMap');

describe('createRewardMap - dasar', () => {
  it('kolom yang belum pernah disentuh harus punya skor 0 (netral)', () => {
    const map = createRewardMap();
    assert.equal(map.getScore(5, 5), 0);
  });

  it('reward() harus menaikkan skor kolom itu', () => {
    const map = createRewardMap();
    map.reward(5, 5, 2);
    assert.equal(map.getScore(5, 5), 2);
  });

  it('punish() harus menurunkan skor kolom itu', () => {
    const map = createRewardMap();
    map.punish(5, 5, 3);
    assert.equal(map.getScore(5, 5), -3);
  });

  it('reward dan punish di kolom yang sama harus terakumulasi (bukan menimpa)', () => {
    const map = createRewardMap();
    map.reward(5, 5, 2);
    map.punish(5, 5, 5);
    map.reward(5, 5, 1);
    assert.equal(map.getScore(5, 5), 2 - 5 + 1);
  });

  it('koordinat dibulatkan ke integer terdekat - (5.4,5.4) dan (5,5) harus jadi kolom yang sama', () => {
    const map = createRewardMap();
    map.punish(5.4, 5.4, 1);
    assert.equal(map.getScore(5, 5), -1);
  });

  it('kolom yang berbeda harus punya skor independen', () => {
    const map = createRewardMap();
    map.punish(5, 5, 3);
    assert.equal(map.getScore(6, 6), 0);
  });
});

describe('createRewardMap - isHeavilyPunished (dipakai untuk menghindari lingkaran berulang)', () => {
  it('kolom netral/positif TIDAK boleh dianggap "dihukum berat"', () => {
    const map = createRewardMap();
    map.reward(5, 5, 10);
    assert.equal(map.isHeavilyPunished(5, 5), false);
  });

  it('kolom yang skornya melewati ambang batas HARUS dianggap "dihukum berat" - dihindari', () => {
    const map = createRewardMap();
    for (let i = 0; i < 5; i++) map.punish(5, 5, 1);
    assert.equal(map.isHeavilyPunished(5, 5), true);
  });
});

describe('createRewardMap - getAllScores (dipakai visualizer)', () => {
  it('harus mengembalikan seluruh kolom yang punya skor non-nol, bukan seluruh peta', () => {
    const map = createRewardMap();
    map.reward(1, 1, 2);
    map.punish(2, 2, 1);
    const all = map.getAllScores();
    assert.equal(all.length, 2);
    assert.ok(all.some((e) => e.x === 1 && e.z === 1 && e.score === 2));
    assert.ok(all.some((e) => e.x === 2 && e.z === 2 && e.score === -1));
  });
});
