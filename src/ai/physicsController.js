/**
 * @file physicsController.js
 * @description Jembatan "virtual keyboard" (forward/back/left/right/jump/sprint/sneak, persis
 * seperti tombol W/A/S/D asli) ke LiveProtocolClient, memakai prismarine-physics - mesin fisika
 * Minecraft asli yang sama dipakai mineflayer (gravitasi, akselerasi, gesekan, lengkung lompatan,
 * step-up otomatis). AI cuma memutuskan tombol mana yang "ditekan" tiap tick; hasil posisinya
 * murni keluaran simulasi fisika, bukan diset langsung - inilah yang membuat gerakan terlihat
 * natural (bukan lompat-lompat/teleport) sekaligus sesuai kecepatan & akselerasi vanilla asli.
 */

const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');

const MC_VERSION = '1.21.1';
const TICK_MS = 50; // 20 tick/detik, sama seperti server Minecraft asli

// Lompatan/turunan wajar di Minecraft (arc lompat penuh di tanah datar) selesai dalam ~12-13 tick.
// Kalau melayang (onGround=false) lebih lama dari ini, itu bukan lompatan biasa lagi - kemungkinan
// besar jatuh bebas ke void. Diberi margin longgar (40 tick / 2 detik) supaya turun tangga/tebing
// kecil yang wajar tidak salah kena deteksi, tapi tetap jauh lebih pendek daripada jatuh ke void
// yang bisa berlangsung ratusan/ribuan tick (kejadian nyata: Y sampai -11370 sebelum akhirnya
// dihentikan manual). Ini pengaman LAPIS KEDUA yang tidak bergantung pengecekan "blok di depan" -
// momentum sprint bisa membawa bot melewati cek itu sebelum sempat berhenti.
const MAX_AIRBORNE_TICKS = 40;

/**
 * @param {import('../network/liveProtocolClient').LiveProtocolClient} client
 */
function createPhysicsController(client) {
  const mcData = require('minecraft-data')(MC_VERSION);
  const Block = require('prismarine-block')(MC_VERSION);

  // Interface world yang dibutuhkan prismarine-physics: getBlock(pos) -> objek blok prismarine.
  // Posisi yang belum ter-cache (stateId null) dianggap udara - konsisten dengan filosofi yang
  // sama dipakai RichVoxelSpatialEngine/getBlockCollisionType di seluruh proyek ini.
  const world = {
    getBlock(pos) {
      const stateId = client.getBlockStateId(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
      const block = Block.fromStateId(stateId ?? 0, 0);
      // getSurroundingBBs (prismarine-physics) butuh block.position untuk hitung AABB tabrakan -
      // Block.fromStateId sendiri tidak mengisi ini (biasanya diisi prismarine-world/chunk).
      block.position = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
      return block;
    }
  };

  const physics = Physics(mcData, world);

  const player = {
    version: MC_VERSION,
    entity: {
      position: new Vec3(client.position.x, client.position.y, client.position.z),
      velocity: new Vec3(0, 0, 0),
      onGround: client.position.onGround !== false,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      elytraFlying: false,
      effects: {}, // tidak ada potion effect - PlayerState butuh objek ini walau kosong
      yaw: ((client.position.yaw || 0) * Math.PI) / 180,
      pitch: 0
    },
    inventory: { slots: [] }, // PlayerState cek sepatu/elytra di slot tertentu - kosongkan saja
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0
  };

  const controls = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  };

  const playerState = new PlayerState(player, controls);
  let airborneTicks = 0;

  return {
    physics,
    world,
    player,
    controls,
    playerState,

    /** True kalau bot sudah melayang (onGround=false) lebih lama dari batas wajar - lihat MAX_AIRBORNE_TICKS. */
    isFreefalling() {
      return airborneTicks > MAX_AIRBORNE_TICKS;
    },

    /**
     * Paksa simulasi lokal kembali cocok dengan posisi OTORITATIF server (client.position saat
     * ini) - posisi DAN kecepatan. Tanpa ini, begitu server menolak/mengoreksi gerakan (anti-cheat
     * vanilla "moved wrongly"/"moved too quickly" - kejadian nyata >2000x di satu sesi server),
     * client.position sendiri sudah benar (LiveProtocolClient selalu menerapkan koreksi dari
     * server), tapi simulasi fisika lokal di sini TIDAK PERNAH tahu - ia cuma membaca client.position
     * SEKALI saat construction lalu terus menghitung dari state internalnya sendiri yang makin lama
     * makin menyimpang, mengirim posisi yang makin tidak masuk akal ke server tiap tick (memicu
     * lebih banyak penolakan, bola salju). Panggil ini setiap kali ada event posisi otoritatif dari
     * server (teleport/respawn/koreksi apapun), bukan cuma sekali di awal sesi.
     */
    resyncToServer() {
      player.entity.position.set(client.position.x, client.position.y, client.position.z);
      player.entity.velocity.set(0, 0, 0);
      player.entity.onGround = client.position.onGround !== false;
      if (Number.isFinite(client.position.yaw)) {
        const yaw = (client.position.yaw * Math.PI) / 180;
        player.entity.yaw = yaw;
        playerState.yaw = yaw;
      }
      airborneTicks = 0;
    },

    /**
     * Arahkan yaw (hadap) ke suatu titik dunia. Gerakan sesudahnya (controls.forward=true)
     * akan mengikuti arah hadap ini - persis seperti pemain menekan W setelah memutar kamera.
     * PENTING: physics.simulatePlayer membaca playerState.yaw (salinan terpisah dibuat sekali
     * saat PlayerState dikonstruksi), BUKAN player.entity.yaw - keduanya harus disinkron manual
     * di sini, kalau tidak perubahan arah hadap tidak pernah benar-benar mempengaruhi gerakan.
     */
    faceToward(targetX, targetZ) {
      const dx = targetX - player.entity.position.x;
      const dz = targetZ - player.entity.position.z;
      // prismarine-physics menerjemahkan yaw jadi arah maju lewat (x=-sin(yaw), z=-cos(yaw)) - lihat
      // node_modules/prismarine-physics/index.js. Supaya arah maju itu benar-benar mengarah ke
      // (dx,dz), butuh -sin(yaw)=dx/r DAN -cos(yaw)=dz/r, yaitu yaw=atan2(-dx,-dz) - BUKAN
      // atan2(-dx,dz) (komponen dz kurang tanda minus). Bug nyata: versi lama membuat bot berjalan
      // ke arah CERMINAN-Z dari target setiap kali dz signifikan (z=0 murni kebetulan tidak
      // terpengaruh karena cos(yaw)=0 di kedua kemungkinan tanda, makanya lolos tak terdeteksi).
      const yaw = Math.atan2(-dx, -dz);
      player.entity.yaw = yaw;
      playerState.yaw = yaw;
    },

    /**
     * Jalankan satu tick fisika (50ms) memakai state controls saat ini, lalu kirim hasil posisi
     * ke server. Ini SATU-SATUNYA jalur pengiriman posisi - tidak ada set posisi manual di luar ini.
     */
    tick() {
      playerState.yaw = player.entity.yaw; // jaga-jaga kalau yaw diubah lewat player.entity langsung
      physics.simulatePlayer(playerState, world).apply(player);

      if (player.entity.onGround) {
        airborneTicks = 0;
      } else {
        airborneTicks++;
      }
      if (airborneTicks > MAX_AIRBORNE_TICKS) {
        // Freefall terdeteksi - matikan paksa semua tombol gerak. Tidak menghentikan jatuhnya
        // (gravitasi tetap berlaku, itu fisika nyata), tapi mencegah bot terus "berjalan" makin
        // jauh ke arah yang salah selama jatuh, dan memberi sinyal jelas ke caller lewat isFreefalling().
        controls.forward = false;
        controls.back = false;
        controls.left = false;
        controls.right = false;
        controls.jump = false;
        controls.sprint = false;
      }

      client.sendPositionAndRotation({
        x: player.entity.position.x,
        y: player.entity.position.y,
        z: player.entity.position.z,
        yaw: (player.entity.yaw * 180) / Math.PI,
        pitch: 0,
        onGround: player.entity.onGround,
        hasHorizontalCollision: player.entity.isCollidedHorizontally
      });
    }
  };
}

module.exports = { createPhysicsController, TICK_MS };
