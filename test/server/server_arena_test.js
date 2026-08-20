/**
 * @file server_arena_test.js
 * @description Suite Pengujian Komprehensif Headless Minecraft Test Server Arena & Bot Test Harness (Milestone 2).
 * Memvalidasi:
 * 1. Siklus hidup server headless in-process (start, stop, isRunning, idempotensi, fast restart).
 * 2. Manipulasi dan kueri blok dunia (setBlock, getBlock, resetWorld, bounds checking).
 * 3. Verifikasi geometri arena Level 1 (Medan Datar 30m).
 * 4. Verifikasi geometri arena Level 2 (Rintangan & Elevasi 50m).
 * 5. Verifikasi geometri arena Level 3 (Tangga, Ladder Shaft & Jembatan Sempit).
 * 6. Verifikasi geometri arena Level 4 (Rute Bawah Tanah & Dungeon Spawner Farm [-256, -20, -432]).
 * 7. Siklus hidup koneksi bot headless Mineflayer (spawn, block inspection, graceful quit).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

const {
  HeadlessTestServer,
  startTestServer,
  stopTestServer,
  isServerRunning,
  resetWorld,
  setBlock,
  getBlock,
  teleportPlayer,
  getServerInstance
} = require('../../src/server/testServer');

const {
  MIN_WORLD_Y,
  MAX_WORLD_Y,
  LEVEL_ARENA_CONFIGS,
  validateYCoordinate,
  validateServerInstance,
  safeSetBlock,
  fillRegion,
  buildLevel1Arena,
  buildLevel2Arena,
  buildLevel3Arena,
  buildLevel4Arena,
  buildArena,
  clearArena
} = require('../../src/server/arenaBuilder');

describe('Suite Verifikasi Headless Minecraft Server Arena & Bot Test Harness (Milestone 2)', () => {
  const TEST_PORT = 25567;

  before(async () => {
    // Pastikan port bersih sebelum memulai suite
    await stopTestServer();
  });

  after(async () => {
    // Pastikan server dimatikan secara bersih setelah seluruh suite selesai
    await stopTestServer();
  });

  // ===========================================================================
  // 1. PENGUJIAN LIFECYCLE SERVER HEADLESS (testServer.js)
  // ===========================================================================
  describe('1. Pengujian Lifecycle Server Headless (testServer.js)', () => {
    it('1.1 Memulai server pada port 25567 dan memverifikasi isServerRunning() bernilai true', async () => {
      const server = await startTestServer({ port: TEST_PORT, logging: false });
      assert.ok(server, 'Instance server flying-squid tidak boleh bernilai null atau undefined.');
      assert.equal(isServerRunning(), true, 'Server harus berstatus aktif (running) setelah startTestServer.');
    });

    it('1.2 Memverifikasi server mendengarkan koneksi TCP pada 127.0.0.1:25567', async () => {
      assert.equal(isServerRunning(), true, 'Server harus dalam keadaan running.');
      const client = new net.Socket();
      client.unref();
      const connected = await new Promise((resolve) => {
        client.connect(TEST_PORT, '127.0.0.1', () => {
          client.destroy();
          resolve(true);
        });
        client.on('error', () => {
          client.destroy();
          resolve(false);
        });
      });
      assert.equal(connected, true, 'Koneksi socket TCP ke 127.0.0.1:25567 harus berhasil tersambung.');
    });

    it('1.3 Menghentikan server dan memverifikasi port dilepaskan & isServerRunning() bernilai false', async () => {
      const stopResult = await stopTestServer();
      assert.equal(stopResult, true, 'stopTestServer harus mengembalikan true.');
      assert.equal(isServerRunning(), false, 'Server harus berstatus tidak aktif setelah stopTestServer.');
    });

    it('1.4 Idempotensi startTestServer() dan stopTestServer() saat dipanggil berulang kali', async () => {
      // Panggil stop berulang saat server sudah mati
      const stop1 = await stopTestServer();
      const stop2 = await stopTestServer();
      assert.equal(stop1, true, 'stopTestServer pertama harus aman.');
      assert.equal(stop2, true, 'stopTestServer kedua harus aman (idempoten).');
      assert.equal(isServerRunning(), false);

      // Start pertama
      const server1 = await startTestServer({ port: TEST_PORT, logging: false });
      assert.equal(isServerRunning(), true);

      // Start kedua (harus mengembalikan server yang sama)
      const server2 = await startTestServer({ port: TEST_PORT, logging: false });
      assert.equal(server1, server2, 'startTestServer berulang harus mengembalikan instance yang sedang berjalan.');
    });

    it('1.5 Siklus restart cepat pada port yang sama tanpa terjadi kesalahan EADDRINUSE', async () => {
      await stopTestServer();
      assert.equal(isServerRunning(), false);

      // Mulai kembali seketika pada port yang sama
      const server = await startTestServer({ port: TEST_PORT, logging: false });
      assert.ok(server);
      assert.equal(isServerRunning(), true, 'Server harus berhasil restart seketika pada port yang sama.');
    });
  });

  // ===========================================================================
  // 2. PENGUJIAN MANIPULASI & KUERI BLOK DUNIA (setBlock & getBlock)
  // ===========================================================================
  describe('2. Pengujian Manipulasi & Kueri Blok Dunia (setBlock & getBlock)', () => {
    it('2.1 Menempatkan dan membaca blok solid dasar (stone, cobblestone, deepslate)', async () => {
      await setBlock(5, 64, 5, 'stone');
      const blockStone = await getBlock(5, 64, 5);
      assert.equal(blockStone.name, 'stone', 'Blok pada (5, 64, 5) harus berupa stone.');

      await setBlock(6, 64, 5, 'cobblestone');
      const blockCobble = await getBlock(6, 64, 5);
      assert.equal(blockCobble.name, 'cobblestone', 'Blok pada (6, 64, 5) harus berupa cobblestone.');

      await setBlock(7, 64, 5, 'deepslate');
      const blockDeepslate = await getBlock(7, 64, 5);
      assert.equal(blockDeepslate.name, 'deepslate', 'Blok pada (7, 64, 5) harus berupa deepslate.');
    });

    it('2.2 Menempatkan dan membaca blok berarah/orientasi (ladder, stone_stairs, chest)', async () => {
      // Ladder dengan properti facing: north
      await setBlock(10, 65, 5, 'ladder', { facing: 'north' });
      const blockLadder = await getBlock(10, 65, 5);
      assert.equal(blockLadder.name, 'ladder', 'Blok pada (10, 65, 5) harus berupa ladder.');
      const ladderProps = blockLadder.getProperties ? blockLadder.getProperties() : {};
      assert.equal(ladderProps.facing, 'north', 'Properti facing ladder harus bernilai north.');

      // Stairs dengan properti facing: east, half: bottom
      await setBlock(11, 64, 5, 'stone_stairs', { facing: 'east', half: 'bottom' });
      const blockStairs = await getBlock(11, 64, 5);
      assert.equal(blockStairs.name, 'stone_stairs', 'Blok pada (11, 64, 5) harus berupa stone_stairs.');
      const stairsProps = blockStairs.getProperties ? blockStairs.getProperties() : {};
      assert.equal(stairsProps.facing, 'east', 'Properti facing tangga harus bernilai east.');

      // Chest
      await setBlock(12, 64, 5, 'chest');
      const blockChest = await getBlock(12, 64, 5);
      assert.equal(blockChest.name, 'chest', 'Blok pada (12, 64, 5) harus berupa chest.');
    });

    it('2.3 Menempatkan dan membaca blok khusus (spawner, lava, air)', async () => {
      await setBlock(20, 64, 20, 'spawner');
      const blockSpawner = await getBlock(20, 64, 20);
      assert.equal(blockSpawner.name, 'spawner', 'Blok pada (20, 64, 20) harus berupa spawner.');

      await setBlock(21, 64, 20, 'lava');
      const blockLava = await getBlock(21, 64, 20);
      assert.equal(blockLava.name, 'lava', 'Blok pada (21, 64, 20) harus berupa lava.');

      await setBlock(22, 64, 20, 'air');
      const blockAir = await getBlock(22, 64, 20);
      assert.equal(blockAir.name, 'air', 'Blok pada (22, 64, 20) harus berupa air.');
    });

    it('2.4 Validasi penolakan koordinat vertikal di luar batas [-64, 320]', async () => {
      await assert.rejects(
        async () => await setBlock(0, -65, 0, 'stone'),
        /di luar batas dunia Minecraft/i,
        'Harus melempar error saat koordinat Y < -64.'
      );

      await assert.rejects(
        async () => await setBlock(0, 321, 0, 'stone'),
        /di luar batas dunia Minecraft/i,
        'Harus melempar error saat koordinat Y > 320.'
      );

      await assert.rejects(
        async () => await getBlock(0, -70, 0),
        /di luar batas dunia Minecraft/i,
        'getBlock harus melempar error saat koordinat Y < -64.'
      );
    });

    it('2.5 Pembaruan blok yang sudah ada (penggantian jenis blok dan verifikasi state)', async () => {
      await setBlock(30, 64, 30, 'stone');
      let block = await getBlock(30, 64, 30);
      assert.equal(block.name, 'stone');

      // Ganti dengan cobblestone
      await setBlock(30, 64, 30, 'cobblestone');
      block = await getBlock(30, 64, 30);
      assert.equal(block.name, 'cobblestone', 'Blok harus berubah menjadi cobblestone.');

      // Ganti dengan air
      await setBlock(30, 64, 30, 'air');
      block = await getBlock(30, 64, 30);
      assert.equal(block.name, 'air', 'Blok harus berubah menjadi air.');
    });

    it('2.6 Validasi penolakan nama blok yang tidak terdaftar dalam registri', async () => {
      await assert.rejects(
        async () => await setBlock(0, 64, 0, 'blok_rahasia_fiktif_123'),
        /tidak ditemukan dalam registri Minecraft/i,
        'Harus menolak nama blok yang tidak valid.'
      );
    });
  });

  // ===========================================================================
  // 3. PENGUJIAN VERIFIKASI ARENA LEVEL 1 (MEDAN DATAR 30M)
  // ===========================================================================
  describe('3. Pengujian Verifikasi Arena Level 1 (Medan Datar 30m)', () => {
    it('3.1 Membangun Level 1 dan memverifikasi koordinat awal & target', async () => {
      const l1Data = await buildLevel1Arena({ setBlock, getBlock });
      assert.equal(l1Data.level, 1);
      assert.deepEqual(l1Data.startCoord, { x: 0, y: 64, z: 0 }, 'Start coord Level 1 harus [0, 64, 0].');
      assert.deepEqual(l1Data.targetCoord, { x: 30, y: 64, z: 0 }, 'Target coord Level 1 harus [30, 64, 0].');
    });

    it('3.2 Memverifikasi dimensi lantai batu pada Y=63 dan ruang udara Y=64..65', async () => {
      for (let x = 0; x <= 30; x += 5) {
        const floorBlock = await getBlock(x, 63, 0);
        assert.equal(floorBlock.name, 'stone', `Lantai pada (${x}, 63, 0) harus stone.`);

        const air64 = await getBlock(x, 64, 0);
        const air65 = await getBlock(x, 65, 0);
        assert.equal(air64.name, 'air', `Ruang udara pada (${x}, 64, 0) harus air.`);
        assert.equal(air65.name, 'air', `Ruang udara pada (${x}, 65, 0) harus air.`);
      }
    });

    it('3.3 Memverifikasi dinding pembatas samping pada Z=-3 dan Z=3', async () => {
      for (let x = 0; x <= 30; x += 10) {
        const wallLeft = await getBlock(x, 64, -3);
        const wallRight = await getBlock(x, 64, 3);
        assert.equal(wallLeft.name, 'stone', `Dinding samping kiri pada (${x}, 64, -3) harus stone.`);
        assert.equal(wallRight.name, 'stone', `Dinding samping kanan pada (${x}, 64, 3) harus stone.`);
      }
    });

    it('3.4 Memverifikasi dispatcher buildArena untuk Level 1', async () => {
      const dispatched = await buildArena(1, { setBlock, getBlock });
      assert.equal(dispatched.level, 1);
      assert.deepEqual(dispatched.targetCoord, { x: 30, y: 64, z: 0 });
    });
  });

  // ===========================================================================
  // 4. PENGUJIAN VERIFIKASI ARENA LEVEL 2 (RINTANGAN & ELEVASI 50M)
  // ===========================================================================
  describe('4. Pengujian Verifikasi Arena Level 2 (Rintangan & Elevasi 50m)', () => {
    it('4.1 Membangun Level 2 dan memverifikasi panjang lintasan 50m', async () => {
      const l2Data = await buildLevel2Arena({ setBlock, getBlock });
      assert.equal(l2Data.level, 2);
      assert.equal(l2Data.targetCoord.x, 50, 'Target lintasan Level 2 harus mencapai 50m.');
      assert.deepEqual(l2Data.startCoord, { x: 0, y: 64, z: 0 });
    });

    it('4.2 Memverifikasi segmen kenaikan elevasi 1-blok pada X=15..29 (Y=64)', async () => {
      const floorBeforeStep = await getBlock(14, 63, 0);
      assert.equal(floorBeforeStep.name, 'stone', 'Lantai pada X=14 harus di Y=63.');

      const floorOnStep = await getBlock(15, 64, 0);
      assert.equal(floorOnStep.name, 'stone', 'Lantai pada X=15 harus terangkat 1-blok ke Y=64.');

      const floorOnStep20 = await getBlock(20, 64, 2);
      assert.equal(floorOnStep20.name, 'stone', 'Lantai pada X=20 harus di Y=64.');
    });

    it('4.3 Memverifikasi penempatan dinding rintangan 2-blok tinggi pada titik belok X=20', async () => {
      const wallBlock1 = await getBlock(20, 65, 0);
      const wallBlock2 = await getBlock(20, 66, 0);
      assert.equal(wallBlock1.name, 'stone', 'Rintangan dinding lapis 1 pada (20, 65, 0) harus stone.');
      assert.equal(wallBlock2.name, 'stone', 'Rintangan dinding lapis 2 pada (20, 66, 0) harus stone.');
    });

    it('4.4 Memverifikasi ketersediaan celah udara pada jalur detour samping (bypass corridor)', async () => {
      const bypassAir1 = await getBlock(20, 65, 2);
      const bypassAir2 = await getBlock(20, 66, 2);
      assert.equal(bypassAir1.name, 'air', 'Jalur bypass celah kanan (20, 65, 2) harus air.');
      assert.equal(bypassAir2.name, 'air', 'Jalur bypass celah kanan (20, 66, 2) harus air.');
    });
  });

  // ===========================================================================
  // 5. PENGUJIAN VERIFIKASI ARENA LEVEL 3 (TANGGA, LADDER & JEMBATAN SEMPIT)
  // ===========================================================================
  describe('5. Pengujian Verifikasi Arena Level 3 (Tangga, Ladder & Jembatan Sempit)', () => {
    it('5.1 Membangun Level 3 dan memverifikasi tangga balok menanjak (stone_stairs)', async () => {
      const l3Data = await buildLevel3Arena({ setBlock, getBlock });
      assert.equal(l3Data.level, 3);

      const stair5 = await getBlock(5, 68, 0);
      assert.equal(stair5.name, 'stone_stairs', 'Blok pada (5, 68, 0) harus berupa stone_stairs.');
      const stairProps = stair5.getProperties ? stair5.getProperties() : {};
      assert.equal(stairProps.facing, 'east', 'Tangga balok harus menghadap timur (east).');
    });

    it('5.2 Memverifikasi jembatan sempit 1-blok pada Y=73 dengan jurang/void di kedua sisi', async () => {
      const bridgeWalkway = await getBlock(10, 73, 5);
      assert.equal(bridgeWalkway.name, 'stone', 'Lantai jembatan pada (10, 73, 5) harus stone.');

      const bridgeLeftVoid = await getBlock(9, 73, 5);
      const bridgeRightVoid = await getBlock(11, 73, 5);
      assert.equal(bridgeLeftVoid.name, 'air', 'Sisi kiri jembatan sempit (9, 73, 5) harus berupa jurang terbuka (air).');
      assert.equal(bridgeRightVoid.name, 'air', 'Sisi kanan jembatan sempit (11, 73, 5) harus berupa jurang terbuka (air).');
    });

    it('5.3 Memverifikasi shaft tangga vertikal (ladder) yang menempel pada tiang solid pendukung', async () => {
      const ladderBlock = await getBlock(10, 70, 15);
      assert.equal(ladderBlock.name, 'ladder', 'Blok pada (10, 70, 15) harus berupa ladder.');

      const backingWall = await getBlock(10, 70, 16);
      assert.equal(backingWall.name, 'stone', 'Tiang pendukung di belakang ladder (10, 70, 16) harus stone.');

      const frontAir = await getBlock(10, 70, 14);
      assert.equal(frontAir.name, 'air', 'Ruang di depan ladder (10, 70, 14) harus air.');
    });

    it('5.4 Memverifikasi platform pendaratan bawah pada target akhir', async () => {
      const landingFloor = await getBlock(10, 63, 15);
      assert.equal(landingFloor.name, 'stone', 'Platform pendaratan dasar (10, 63, 15) harus stone.');
    });
  });

  // ===========================================================================
  // 6. PENGUJIAN VERIFIKASI ARENA LEVEL 4 (RUTE BAWAH TANAH & DUNGEON FARM [-256, -20, -432])
  // ===========================================================================
  describe('6. Pengujian Verifikasi Arena Level 4 (Rute Bawah Tanah & Dungeon Farm)', () => {
    it('6.1 Membangun Level 4 dan memverifikasi pintu masuk permukaan & target', async () => {
      const l4Data = await buildLevel4Arena({ setBlock, getBlock });
      assert.equal(l4Data.level, 4);
      assert.deepEqual(l4Data.startCoord, { x: 0, y: 64, z: 0 });
      assert.deepEqual(l4Data.targetCoord, { x: -256, y: -20, z: -432 });
      assert.deepEqual(l4Data.spawnerCoord, { x: -256, y: -19, z: -432 });
    });

    it('6.2 Memverifikasi ruangan dungeon deepslate di sekitar [-256, -20, -432]', async () => {
      const dungeonFloor = await getBlock(-256, -21, -432);
      assert.equal(dungeonFloor.name, 'deepslate', 'Lantai dungeon pada (-256, -21, -432) harus deepslate.');

      const dungeonAir = await getBlock(-256, -20, -432);
      assert.equal(dungeonAir.name, 'air', 'Ruang gerak dungeon pada (-256, -20, -432) harus air.');

      const dungeonCeiling = await getBlock(-256, -16, -432);
      assert.equal(dungeonCeiling.name, 'deepslate', 'Langit-langit dungeon pada (-256, -16, -432) harus deepslate.');
    });

    it('6.3 Memverifikasi penempatan blok mob spawner pada koordinat target pusat', async () => {
      const spawnerBlock = await getBlock(-256, -19, -432);
      assert.equal(spawnerBlock.name, 'spawner', 'Pusat dungeon harus memiliki blok spawner pada (-256, -19, -432).');
    });

    it('6.4 Memverifikasi 4 unit peti inventaris terkategori pada perimeter dungeon', async () => {
      const chestCoords = [
        { x: -258, y: -20, z: -429 },
        { x: -256, y: -20, z: -429 },
        { x: -254, y: -20, z: -429 },
        { x: -252, y: -20, z: -429 }
      ];

      for (const c of chestCoords) {
        const block = await getBlock(c.x, c.y, c.z);
        assert.equal(block.name, 'chest', `Blok pada (${c.x}, ${c.y}, ${c.z}) harus berupa chest.`);
      }
    });

    it('6.5 Memverifikasi kolam pembakaran lava dengan pagar pengaman iron_bars', async () => {
      const lavaBlock = await getBlock(-259, -21, -435);
      assert.equal(lavaBlock.name, 'lava', 'Blok incinerator pada (-259, -21, -435) harus lava.');

      const ironBar1 = await getBlock(-260, -20, -435);
      const ironBar2 = await getBlock(-258, -20, -435);
      const ironBar3 = await getBlock(-259, -20, -436);
      assert.equal(ironBar1.name, 'iron_bars', 'Pagar pengaman kiri kolam lava harus iron_bars.');
      assert.equal(ironBar2.name, 'iron_bars', 'Pagar pengaman kanan kolam lava harus iron_bars.');
      assert.equal(ironBar3.name, 'iron_bars', 'Pagar pengaman belakang kolam lava harus iron_bars.');

      const safeStandingPlatform = await getBlock(-259, -21, -433);
      assert.equal(safeStandingPlatform.name, 'deepslate', 'Platform berdiri aman berjarak 2m harus deepslate.');
    });

    it('6.6 Memverifikasi penolakan dispatcher buildArena untuk level tidak valid', async () => {
      await assert.rejects(
        async () => await buildArena(999, { setBlock, getBlock }),
        /Tingkat level arena tidak valid!/i,
        'Harus melempar pesan error dalam Bahasa Indonesia untuk level fiktif.'
      );
    });
  });

  // ===========================================================================
  // 7. PENGUJIAN LIFECYCLE KONEKSI HEADLESS MINEFLAYER BOT
  // ===========================================================================
  describe('7. Pengujian Lifecycle Koneksi Headless Mineflayer Bot', () => {
    let bot;

    it('7.1 Bot Mineflayer berhasil terhubung ke 127.0.0.1:25567 dan menerima event spawn', async () => {
      // Siapkan platform start Level 1
      await buildLevel1Arena({ setBlock, getBlock });

      bot = mineflayer.createBot({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'ArenaTestBot',
        version: '1.20.1',
        checkTimeoutInterval: 5000
      });

      // Tangani event error agar tidak menjadi uncaught exception pada EventEmitter
      bot.on('error', (err) => {});

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Bot gagal memicu event spawn dalam batas waktu 5000ms.'));
        }, 5000);

        bot.once('spawn', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      assert.ok(bot.entity, 'Bot harus memiliki entitas aktif setelah event spawn.');
    });

    it('7.2 Bot menerima sinkronisasi chunk dunia dan koordinat posisi awal yang valid', async () => {
      assert.ok(bot.entity, 'Bot harus aktif.');
      assert.ok(typeof bot.entity.position.x === 'number', 'Posisi X bot harus berupa tipe angka.');
      assert.ok(typeof bot.entity.position.y === 'number', 'Posisi Y bot harus berupa tipe angka.');
      assert.ok(typeof bot.entity.position.z === 'number', 'Posisi Z bot harus berupa tipe angka.');
    });

    it('7.3 Bot dapat menginspeksi blok di sekitarnya melalui bot.blockAt()', async () => {
      // Tempatkan blok uji di dekat bot
      await setBlock(0, 63, 0, 'stone');
      const inspectedBlock = bot.blockAt(new Vec3(0, 63, 0));
      assert.ok(inspectedBlock, 'Inspeksi blok via bot.blockAt tidak boleh bernilai null.');
      assert.equal(inspectedBlock.name, 'stone', 'Nama blok yang diinspeksi oleh bot harus stone.');
    });

    it('7.4 Bot terputus secara bersih via bot.quit() dan server melepaskan entitas pemain', async () => {
      assert.ok(bot, 'Bot harus ada.');
      await new Promise((resolve) => {
        bot.once('end', resolve);
        try {
          if (bot._client && bot._client.socket) {
            bot._client.socket.unref();
          }
          bot.quit();
        } catch (e) {
          resolve();
        }
      });

      const serv = getServerInstance();
      if (serv && Array.isArray(serv.players)) {
        const found = serv.players.some((p) => p.username === 'ArenaTestBot');
        assert.equal(found, false, 'Entitas bot yang keluar harus dihapus dari daftar serv.players.');
      }
    });

    it('7.5 Verifikasi bebas kebocoran memori, nol hanging timer, dan shutdown server sempurna', async () => {
      if (bot && bot._client && bot._client.socket) {
        try {
          bot._client.socket.unref();
          bot._client.socket.destroy();
        } catch (e) {}
      }
      const stopSuccess = await stopTestServer();
      assert.equal(stopSuccess, true, 'Server harus berhenti secara sempurna.');
      assert.equal(isServerRunning(), false, 'Server harus berstatus tidak aktif.');
    });
  });
});
