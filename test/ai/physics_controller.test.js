/**
 * @file physics_controller.test.js
 * @description Uji wiring createPhysicsController ke LiveProtocolClient. Tidak menguji ulang
 * kebenaran fisika prismarine-physics (sudah library teruji) - cuma memastikan controls (virtual
 * keyboard) benar-benar menggerakkan simulasi, dan hasilnya benar-benar terkirim lewat
 * sendPositionAndRotation, bukan diset manual.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPhysicsController } = require('../../src/ai/physicsController');

function makeFakeClient(startPos) {
  const sent = [];
  return {
    position: { ...startPos, yaw: 0, onGround: true },
    getBlockStateId(x, y, z) {
      // Lantai datar solid di y=63 ke bawah, udara di atasnya - dunia sederhana untuk uji fisika.
      return y < 63 ? 1 : 0; // 1 = stone (state id vanilla), 0 = air
    },
    sendPositionAndRotation(pos) {
      sent.push(pos);
    },
    sentPositions: sent
  };
}

describe('createPhysicsController', () => {
  it('tanpa tombol ditekan, bot harus diam di tempat (kecuali jatuh oleh gravitasi jika melayang)', () => {
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    const ctl = createPhysicsController(client);

    for (let i = 0; i < 5; i++) ctl.tick();

    const last = client.sentPositions[client.sentPositions.length - 1];
    assert.ok(Math.abs(last.x - 0) < 0.01, 'X tidak boleh bergeser tanpa tombol ditekan');
    assert.ok(Math.abs(last.z - 0) < 0.01, 'Z tidak boleh bergeser tanpa tombol ditekan');
  });

  it('controls.forward=true harus membuat bot maju sesuai arah yaw (faceToward)', () => {
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    const ctl = createPhysicsController(client);

    ctl.faceToward(10, 0); // hadap ke arah +X
    ctl.controls.forward = true;

    for (let i = 0; i < 20; i++) ctl.tick();

    const last = client.sentPositions[client.sentPositions.length - 1];
    assert.ok(last.x > 0.3, `bot harus bergerak maju ke arah +X, dapat x=${last.x}`);
    assert.ok(Math.abs(last.z) < 0.5, 'gerakan lurus ke +X seharusnya tidak menyimpang jauh di Z');
  });

  it('controls.forward=true harus membuat bot maju ke arah +Z (bukan -Z) ketika faceToward diberi target dengan komponen Z murni - menguji arah yaw untuk kasus non-cardinal-X', () => {
    // Tes sebelumnya cuma pakai faceToward(10, 0) (dz=0) - itu tidak bisa mendeteksi bug tanda pada
    // komponen Z karena cos(yaw) kebetulan 0 di kedua kemungkinan tanda. Target dengan dz murni
    // (dx=0) memaksa komponen Z benar-benar diuji.
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    const ctl = createPhysicsController(client);

    ctl.faceToward(0, 10); // hadap ke arah +Z
    ctl.controls.forward = true;

    for (let i = 0; i < 20; i++) ctl.tick();

    const last = client.sentPositions[client.sentPositions.length - 1];
    assert.ok(last.z > 0.3, `bot harus bergerak maju ke arah +Z sesuai target, dapat z=${last.z} (bukan menjauh ke arah -Z)`);
    assert.ok(Math.abs(last.x) < 0.5, 'gerakan lurus ke +Z seharusnya tidak menyimpang jauh di X');
  });

  it('gerakan harus berakselerasi bertahap (bukan langsung kecepatan penuh) - ciri fisika nyata, bukan teleport', () => {
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    const ctl = createPhysicsController(client);

    ctl.faceToward(100, 0);
    ctl.controls.forward = true;

    ctl.tick();
    const firstStepDist = client.sentPositions[0].x;

    for (let i = 0; i < 19; i++) ctl.tick();
    const laterPos = client.sentPositions[client.sentPositions.length - 1];
    const laterStepDist = laterPos.x - client.sentPositions[client.sentPositions.length - 2].x;

    assert.ok(laterStepDist > firstStepDist, `jarak per-tick harus membesar seiring akselerasi (awal=${firstStepDist}, belakangan=${laterStepDist})`);
  });

  it('setiap tick harus mengirim posisi lewat sendPositionAndRotation (bukan set posisi manual di luar fisika)', () => {
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    const ctl = createPhysicsController(client);

    ctl.tick();
    ctl.tick();
    ctl.tick();

    assert.equal(client.sentPositions.length, 3);
  });

  it('harus mendeteksi jatuh bebas (freefall) kalau melayang terlalu lama, dan otomatis mematikan forward/jump/sprint - pengaman terhadap void, tidak bergantung caller mengecek sendiri', () => {
    // Dunia dengan tebing nyata: tanah solid hanya di x<5, void total (udara di semua Y) di x>=5.
    // Momentum sprint bisa membawa bot melewati tebing walau cek "1 blok di depan" sempat menolak -
    // ini pengaman lapis kedua yang tidak bergantung lookahead sama sekali, murni dari durasi melayang.
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    client.getBlockStateId = (x, y, z) => {
      if (x >= 5) return 0; // void total
      return y < 63 ? 1 : 0;
    };
    const ctl = createPhysicsController(client);

    ctl.faceToward(100, 0);
    ctl.controls.forward = true;
    ctl.controls.sprint = true;

    let detectedAt = null;
    for (let i = 0; i < 200; i++) {
      ctl.tick();
      if (ctl.isFreefalling() && detectedAt === null) detectedAt = i;
    }

    assert.ok(detectedAt !== null, 'harus terdeteksi freefall dalam 200 tick berjalan lurus ke tebing');
    assert.equal(ctl.controls.forward, false, 'forward harus otomatis dimatikan begitu freefall terdeteksi');
    assert.equal(ctl.controls.jump, false);
    assert.equal(ctl.controls.sprint, false);
  });

  it('lompatan wajar (naik turun tangga singkat) TIDAK boleh dianggap freefall', () => {
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    const ctl = createPhysicsController(client);

    ctl.controls.jump = true;
    for (let i = 0; i < 5; i++) ctl.tick(); // lompat sebentar di tanah datar, bukan jatuh ke void
    ctl.controls.jump = false;
    for (let i = 0; i < 15; i++) ctl.tick(); // turun lagi ke tanah

    assert.equal(ctl.isFreefalling(), false, 'lompat biasa di tanah datar tidak boleh memicu freefall guard');
  });

  it('resyncToServer harus mengganti posisi & kecepatan simulasi lokal ke posisi server, bukan cuma dibaca sekali saat konstruksi', () => {
    // Bug nyata: client.position dibaca SEKALI saat createPhysicsController dipanggil, lalu tidak
    // pernah disinkronkan lagi - begitu server menolak/mengoreksi posisi (anti-cheat "moved wrongly"
    // / "moved too quickly", terlihat nyata >2000x di log server), simulasi lokal terus menyimpang
    // makin jauh dari kebenaran server tanpa pernah tahu. resyncToServer() harus jadi jalan untuk
    // memaksa simulasi lokal kembali cocok dengan posisi otoritatif server kapan saja dipanggil.
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    const ctl = createPhysicsController(client);

    ctl.controls.forward = true;
    ctl.faceToward(100, 0);
    for (let i = 0; i < 10; i++) ctl.tick(); // simulasi lokal sudah bergerak menjauh dari (0,64,0)

    const beforeResync = client.sentPositions[client.sentPositions.length - 1];
    assert.ok(beforeResync.x > 0.1, 'pastikan simulasi memang sudah bergerak sebelum resync (validasi setup tes)');

    // Server mengoreksi posisi bot ke titik yang SAMA SEKALI berbeda dari hasil simulasi lokal.
    client.position = { x: -500, y: 70, z: 300, yaw: 90, onGround: true };
    ctl.resyncToServer();
    ctl.controls.forward = false;
    ctl.tick();

    const afterResync = client.sentPositions[client.sentPositions.length - 1];
    assert.ok(Math.abs(afterResync.x - (-500)) < 1, `posisi X harus mengikuti koreksi server, dapat ${afterResync.x}`);
    assert.ok(Math.abs(afterResync.z - 300) < 1, `posisi Z harus mengikuti koreksi server, dapat ${afterResync.z}`);
  });

  it('resyncToServer harus mereset kecepatan ke nol - kecepatan lama tidak boleh "membawa" simulasi menjauh lagi dari posisi baru', () => {
    const client = makeFakeClient({ x: 0, y: 64, z: 0 });
    const ctl = createPhysicsController(client);

    ctl.controls.forward = true;
    ctl.controls.sprint = true;
    ctl.faceToward(100, 0);
    for (let i = 0; i < 20; i++) ctl.tick(); // bangun momentum/kecepatan nyata sebelum resync

    client.position = { x: 10, y: 64, z: 10, yaw: 0, onGround: true };
    ctl.resyncToServer();
    ctl.controls.forward = false;
    ctl.controls.sprint = false;
    ctl.tick();

    const after = client.sentPositions[client.sentPositions.length - 1];
    // Tanpa reset kecepatan, momentum sprint lama akan tetap menggeser posisi jauh dari (10,64,10)
    // walau forward sudah dimatikan - toleransi kecil untuk friksi 1 tick fisika normal.
    assert.ok(Math.abs(after.x - 10) < 0.5, `kecepatan lama tidak boleh terbawa - dapat x=${after.x}`);
  });
});
