/**
 * @file run_farmer_worker_movements.test.js
 * @description Unit test konfigurasi pathfinder FarmerWorker (buildMovements) - permintaan nyata
 * pemilik: "bot nya ngawur seperti tidak paham map sekitar base apa mungkin kita maping untuk itu
 * agar bot lebih akurat?". Ditemukan lewat pemantauan live: metrics.eaten melonjak drastis (17->26
 * dalam beberapa menit) tepat saat fitur perbaikan lahan aktif bekerja di dekat lubang ledakan
 * creeper - tanda bot berulang kali kena fall damage (regenerasi HP menguras hunger cepat), BUKAN
 * navigasi acak/tidak paham peta. Root cause: pathfinder default membolehkan rute yang PASTI
 * menyakiti bot (jatuh 4 blok, atau lompat parkour berisiko) sebagai "jalan pintas".
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMovements } = require('../../src/ai/runFarmerWorker');

describe('runFarmerWorker.buildMovements', () => {
  const fakeBot = {
    version: '1.21.1',
    // Movements butuh registry NYATA (bukan mock) - lihat pola yang sama di walk_to_base.test.js.
    registry: require('minecraft-data')('1.21.1'),
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [] }
  };

  it('maxDropDown harus 3, BUKAN default library (4) - di Minecraft jatuh sampai 3 blok TIDAK kena damage sama sekali, jatuh 4 blok pasti kena 1 damage, jadi default 4 membolehkan pathfinder memilih rute yang PASTI menyakiti bot sebagai jalan pintas', () => {
    const movements = buildMovements(fakeBot);
    assert.equal(movements.maxDropDown, 3);
  });

  it('allowParkour harus true - permintaan nyata pemilik ("allow aja") setelah FarmerEngine punya health-retreat + makan sambil mundur, fall-damage sesekali dari parkour tidak lagi berisiko bikin bot macet/mati diam-diam', () => {
    const movements = buildMovements(fakeBot);
    assert.equal(movements.allowParkour, true);
  });

  it('canDig tetap false dan tidak menaruh scaffolding - perilaku lama yang sudah benar tidak boleh berubah gara-gara perbaikan ini', () => {
    const movements = buildMovements(fakeBot);
    assert.equal(movements.canDig, false);
    assert.deepEqual(movements.scafoldingBlocks, []);
    assert.equal(movements.allow1by1towers, false);
  });
});
