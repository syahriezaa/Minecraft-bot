# Laporan Spesifikasi Pengujian (Handoff Report) — Milestone 2: Headless Server Arena & Bot Test Harness

## 1. Observation
Berdasarkan investigasi mendalam terhadap repositori, dokumen spesifikasi (`ORIGINAL_REQUEST.md`, `PROJECT.md`, `.agents/sub_orch_m2/SCOPE.md`), dependensi `package.json`, dan perilaku runtime `flying-squid`, `prismarine-block`, `prismarine-chunk`, `minecraft-data`, serta `mineflayer`:

1. **Infrastruktur Headless Server In-Process (`src/server/testServer.js`)**:
   - Repositori menggunakan `flying-squid` (^1.12.0) sebagai in-process zero-Java Minecraft server yang berjalan pada port 25567 (versi protokol Minecraft 1.20.1 / 1.19.4).
   - Berdasarkan probe eksekusi langsung, server `flying-squid` dapat di-booting dalam ~150ms dan dihentikan dalam ~50ms secara bersih tanpa dependensi runtime JVM eksternal.
   - Server mengekspos objek dunia via `serv.overworld` (`prismarine-world`) yang mendukung mutasi blok asinkron `serv.setBlock(world, pos, stateId)` dan pembacaan blok `serv.overworld.getBlock(pos)`.
   - Modul `testServer.js` wajib mengekspos API kontrak:
     - `startTestServer(options)`: Menginisialisasi dan menjalankan server pada port 25567 (default host `127.0.0.1`, logging `false`).
     - `stopTestServer()`: Menghentikan server, menutup soket jaringan, dan membersihkan chunk memori.
     - `isServerRunning()`: Mengembalikan boolean status aktif server.
     - `resetWorld()`: Mengosongkan atau mereset ulang chunk arena.
     - `setBlock(x, y, z, blockNameOrId, properties)`: Menempatkan blok dengan nama dan properti state (misal `facing`, `half`, `waterlogged`).
     - `getBlock(x, y, z)`: Mengambil objek blok pada koordinat tertentu.
     - `getServerInstance()`: Mengembalikan instance server `serv` untuk inspeksi langsung.

2. **Generator Arena Prosedural 4-Level (`src/server/arenaBuilder.js`)**:
   - `buildLevel1Arena(server, options)`: Membangun jalur sprint datar 30m dari `[0, 64, 0]` ke `[30, 64, 0]` dengan lantai batu (X=[-2..32], Z=[-2..2], Y=63), ruang udara bebas rintangan pada Y=64 dan Y=65, pembatas pinggir pada Z=-3 dan Z=3, serta penanda visual awal (`emerald_block`) dan target (`diamond_block`/`beacon`).
   - `buildLevel2Arena(server, options)`: Membangun lintasan rintangan 50m ke target `[50, 68, 0]` dengan kenaikan elevasi 1-blok bertingkat, rintangan elevasi 2-blok, dan dinding penghalang (obstacle barriers) pada interval tertentu (misal X=20 dan X=35) yang mewajibkan manuver belok lateral/detour.
   - `buildLevel3Arena(server, options)`: Membangun lintasan navigasi vertikal yang mencakup tangga balok mendaki (`stone_stairs` dengan properti `facing` menghadap tanjakan), shaft tangga vertikal (`ladder` dengan penempelan ke dinding solid), dan jembatan sempit 1-blok (lebar Z=1 blok dengan celah jurang/udara di kiri Z-1 dan kanan Z+1) menuju target `[40, 80, 20]` / `[10, 64, 15]`.
   - `buildLevel4Arena(server, options)`: Membangun rute turunan bawah tanah dari permukaan `[0, 64, 0]` menuju dungeon target koordinat `[-256, -20, -432]`. Di dalam dungeon terdapat ruangan deepslate/cobblestone dengan mob spawner (`spawner`) di tengah `[-256, -19, -432]`, peti inventaris (`chest`), dan kolam pembakaran sampah lava (`lava`) dengan batas perimeter aman batu.
   - `buildArena(level, server, options)`: Fungsi pembungkus (dispatcher) untuk membangun arena berdasarkan nomor level (1, 2, 3, atau 4).
   - `clearArena(server, bounds)`: Mengosongkan blok di dalam batas area arena.

3. **Konektivitas Headless Mineflayer Bot**:
   - `mineflayer.createBot` berhasil terhubung ke `127.0.0.1:25567`, menerima data chunk overworld, memicu event `spawn` dalam < 300ms, menginspeksi blok via `bot.blockAt(vec3)`, dan terputus secara bersih (`bot.quit()`) dalam < 1.5 detik total.

4. **Infrastruktur Pengujian Proyek**:
   - Repositori menggunakan native Node.js Test Runner (`node:test` dan `node:assert/strict`).
   - Format test suite terbukti pada `test/database/telemetry_db_test.js` dan `test/runner.js`.
   - Aturan bahasa proyek (`RULE[user_global]`): Semua komentar, label assertions, dan pesan kesalahan ditulis dalam **Bahasa Indonesia**.

---

## Features Discovered

| # | Kategori | Fitur | Deskripsi | Input | Output | Penanganan Error | Sumber / Ditemukan Melalui |
|---|----------|-------|-----------|-------|--------|------------------|---------------------------|
| 1 | Server Lifecycle | `startTestServer` | Memulai server Minecraft in-process headless pada port 25567 | `options: { port?: number, host?: string, version?: string, logging?: boolean }` | `Promise<MCServer>` | Menolak jika port sudah terpakai oleh proses non-server atau inisialisasi gagal | `SCOPE.md`, `flying-squid` API |
| 2 | Server Lifecycle | `stopTestServer` | Menghentikan server secara bersih dan melepaskan port soket | none | `Promise<void>` | Idempoten jika server sudah berhenti, tidak melempar uncaught error | `SCOPE.md`, `flying-squid` API |
| 3 | Server Lifecycle | `isServerRunning` | Mengecek status aktif server | none | `boolean` (true/false) | Aman dipanggil kapan saja tanpa efek samping | `SCOPE.md` |
| 4 | Server Lifecycle | `resetWorld` | Mengosongkan data chunk dunia untuk isolasi pengujian | `options?: { clearEntities?: boolean }` | `Promise<void>` | Menangani kasus dunia belum diinisialisasi | `SCOPE.md`, `prismarine-world` |
| 5 | World Mutation | `setBlock` | Menempatkan blok spesifik pada koordinat (X, Y, Z) beserta properti state | `x: number, y: number, z: number, blockNameOrId: string\|number, properties?: object` | `Promise<Block>` | Melempar error jika Y di luar batas `[-64, 320]` atau nama blok tidak dikenal di `minecraft-data` | `SCOPE.md`, `prismarine-block` |
| 6 | World Query | `getBlock` | Mengambil data blok pada koordinat (X, Y, Z) | `x: number, y: number, z: number` | `Promise<Block>` | Mengembalikan blok udara (`air`) jika koordinat belum dimutasi | `SCOPE.md`, `prismarine-world` |
| 7 | Arena Generator | `buildLevel1Arena` | Membangun arena sprint 30m datar `[0,64,0]` ke `[30,64,0]` | `server: object, options?: object` | `Promise<{ startPos, targetPos, bounds }>` | Validasi instance server tidak null | `ORIGINAL_REQUEST §R2`, `SCOPE.md` |
| 8 | Arena Generator | `buildLevel2Arena` | Membangun arena rintangan elevasi 1-blok & dinding penghalang 50m | `server: object, options?: object` | `Promise<{ startPos, targetPos, obstacleCount, bounds }>` | Validasi instance server tidak null | `ORIGINAL_REQUEST §R2`, `SCOPE.md` |
| 9 | Arena Generator | `buildLevel3Arena` | Membangun arena tangga balok, tangga vertikal (ladder), & jembatan sempit 1-blok | `server: object, options?: object` | `Promise<{ startPos, targetPos, stairsCount, ladderHeight, bounds }>` | Validasi attachment ladder & orientasi tangga | `ORIGINAL_REQUEST §R2`, `SCOPE.md` |
| 10 | Arena Generator | `buildLevel4Arena` | Membangun rute gua & dungeon spawner bawah tanah di `[-256, -20, -432]` | `server: object, options?: object` | `Promise<{ startPos, targetPos, spawnerCoord, chestCoords, hazardCoord, bounds }>` | Validasi koordinat Y negatif dan penempatan spawner/peti/lava | `ORIGINAL_REQUEST §R2`, `SCOPE.md` |
| 11 | Arena Generator | `buildArena` | Dispatcher untuk membangun arena level 1, 2, 3, atau 4 | `level: number\|string, server: object, options?: object` | `Promise<object>` | Melempar error jika level bukan 1, 2, 3, atau 4 | `SCOPE.md` |
| 12 | Bot Connection | Bot Lifecycle | Spawn, chunk sync, block query, dan disconnect bersih | `botOptions: { host, port, username, version }` | `Promise<{ bot: MineflayerBot, position, blockAtPos }>` | Timeout guard jika server tidak merespons handshake dalam 5 detik | `ORIGINAL_REQUEST §R1`, `mineflayer` |

---

## Edge Cases

| # | Fitur | Input / Kondisi | Perilaku yang Diharapkan |
|---|-------|-----------------|--------------------------|
| 1 | Server Lifecycle | Pemanggilan berulang `startTestServer()` saat server sudah aktif | Mengembalikan instance server yang sedang berjalan (idempoten) tanpa error `EADDRINUSE`. |
| 2 | Server Lifecycle | Pemanggilan berulang `stopTestServer()` saat server sudah mati | Menyelesaikan promise secara aman tanpa melempar error atau crash. |
| 3 | Server Lifecycle | Siklus Cepat Restart (Stop -> Start segera pada port yang sama) | Port soket harus dilepaskan seketika (`server.close()`), memungkinkan start kembali tanpa `EADDRINUSE`. |
| 4 | World Manipulation | Koordinat Y di luar batas dunia (misal Y = -65 atau Y = 321) | `setBlock` melempar error informatif dalam Bahasa Indonesia: *"Koordinat vertikal Y di luar batas dunia [-64, 320]"*. |
| 5 | World Manipulation | Penempatan blok dengan nama tidak valid (misal `non_existent_block_xyz`) | Melempar error dalam Bahasa Indonesia: *"Nama blok 'non_existent_block_xyz' tidak ditemukan pada minecraft-data"*. |
| 6 | World Manipulation | Penempatan blok tangga (`ladder`) tanpa properti `facing` | Memberikan default `facing: 'north'` atau sesuai backing wall agar tidak invalid state. |
| 7 | Level 4 Dungeon | Koordinat Y negatif (Y = -20) pada layer deepslate | World generator menangani koordinat Y negatif dengan benar tanpa integer overflow atau chunk loading error. |
| 8 | Bot Connection | Disconnect bot mendadak saat chunk sedang di-stream | Server menangani event `end`/`kick` tanpa uncaught exception dan menghapus bot dari daftar `serv.players`. |
| 9 | Resource Leak | Multiple test cases dijalankan berurutan | Semua soket, interval timer tick, dan listener event ditutup bersih; total runtime < 10 detik. |

---

## 2. Logic Chain

1. **Kebutuhan Uji Otonom**: Proyek membutuhkan pengujian headless otomatis untuk arena Minecraft tanpa memerlukan GUI atau instalasi Java. `flying-squid` menyediakan server in-process murni Node.js pada port 25567.
2. **Kebutuhan Verifikasi Geometri Arena**: Setiap level benchmark (1-4) memiliki karakteristik geometri yang unik:
   - Level 1: Uji dasar sprint datar 30m (`[0,64,0]` -> `[30,64,0]`).
   - Level 2: Uji rintangan elevasi 1-blok & dinding penghalang 50m (`[0,64,0]` -> `[50,68,0]`).
   - Level 3: Uji navigasi vertikal (tangga blok, ladder shaft) & jembatan sempit 1-blok.
   - Level 4: Uji rute bawah tanah ke spawner `[-256, -20, -432]`, peti sortir, dan kolam lava pembakaran sampah.
3. **Kebutuhan Kontrak Uji `test/server/server_arena_test.js`**:
   - File tes ini bertindak sebagai guard spesifikasi untuk Milestone 2.
   - Tes harus mencakup seluruh aspek: lifecycle server, manipulasi blok dunia, verifikasi blok untuk tiap level arena (1-4), dan lifecycle koneksi bot Mineflayer.
   - Eksekusi harus cepat (< 10 detik) dan bebas dari kebocoran memori atau hanging process.
   - Semua assertions dan keterangan harus berbahasa Indonesia sesuai aturan proyek.

---

## 3. Detailed Test Matrix for `test/server/server_arena_test.js`

```
Suite: Verifikasi Headless Minecraft Server Arena & Bot Test Harness (Milestone 2)
│
├── 1. Pengujian Lifecycle Server Headless (`testServer.js`)
│   ├── Test 1.1: Memulai server pada port 25567 dan memverifikasi `isServerRunning() === true`
│   ├── Test 1.2: Memverifikasi server mendengarkan koneksi TCP pada 127.0.0.1:25567
│   ├── Test 1.3: Menghentikan server dan memverifikasi port dilepaskan & `isServerRunning() === false`
│   ├── Test 1.4: Idempotensi `startTestServer()` dan `stopTestServer()` saat dipanggil berulang
│   └── Test 1.5: Siklus restart cepat pada port yang sama tanpa terjadi kesalahan `EADDRINUSE`
│
├── 2. Pengujian Manipulasi & Kueri Blok Dunia (`setBlock` & `getBlock`)
│   ├── Test 2.1: Menempatkan dan membaca blok solid dasar (`stone`, `cobblestone`, `deepslate`)
│   ├── Test 2.2: Menempatkan dan membaca blok berarah/orientasi (`ladder`, `stone_stairs`, `chest`)
│   ├── Test 2.3: Menempatkan dan membaca blok khusus (`spawner`, `lava`, `air`)
│   ├── Test 2.4: Validasi penolakan koordinat vertikal di luar batas `[-64, 320]`
│   └── Test 2.5: Pembaruan blok yang sudah ada (penggantian jenis blok dan verifikasi state)
│
├── 3. Pengujian Verifikasi Arena Level 1 (Medan Datar 30m)
│   ├── Test 3.1: Memverifikasi dimensi lantai batu dari X=[-2..32] dan Z=[-2..2] pada Y=63
│   ├── Test 3.2: Memverifikasi ruang udara bersih bebas hambatan pada Y=64 dan Y=65 sepanjang jalur
│   ├── Test 3.3: Memverifikasi penanda koordinat awal `[0, 63, 0]` dan koordinat target `[30, 63, 0]`
│   └── Test 3.4: Memverifikasi batas pengaman tepi (border walls/railings) pada Z=-3 dan Z=3
│
├── 4. Pengujian Verifikasi Arena Level 2 (Rintangan & Elevasi 50m)
│   ├── Test 4.1: Memverifikasi panjang lintasan 50m dari `[0, 64, 0]` menuju `[50, 68, 0]`
│   ├── Test 4.2: Memverifikasi segmen kenaikan elevasi 1-blok bertingkat pada jalur
│   ├── Test 4.3: Memverifikasi penempatan dinding rintangan 2-blok tinggi pada titik belok/detour
│   └── Test 4.4: Memverifikasi ketersediaan celah udara pada jalur detour samping (bypass corridor)
│
├── 5. Pengujian Verifikasi Arena Level 3 (Tangga, Ladder & Jembatan Sempit)
│   ├── Test 5.1: Memverifikasi balok tangga mendaki (`stone_stairs`) dengan orientasi `facing` yang benar
│   ├── Test 5.2: Memverifikasi shaft tangga vertikal (`ladder`) yang menempel pada dinding solid
│   ├── Test 5.3: Memverifikasi jembatan sempit 1-blok (lebar Z=1) yang diapit oleh celah udara (jurang)
│   └── Test 5.4: Memverifikasi platform pendaratan target akhir pada elevasi tinggi
│
├── 6. Pengujian Verifikasi Arena Level 4 (Rute Bawah Tanah & Target Spawner `[-256, -20, -432]`)
│   ├── Test 6.1: Memverifikasi pintu masuk permukaan `[0, 64, 0]` dan rute koridor penurunan ke Y=-20
│   ├── Test 6.2: Memverifikasi geometri ruangan dungeon deepslate di sekitar `[-256, -20, -432]`
│   ├── Test 6.3: Memverifikasi penempatan blok `spawner` pada koordinat target pusat ruangan
│   ├── Test 6.4: Memverifikasi penempatan peti-peti inventaris (`chest`) pada perimeter dungeon
│   └── Test 6.5: Memverifikasi kolam pembakaran lava (`lava`) dengan batas perimeter aman batu
│
└── 7. Pengujian Lifecycle Koneksi Headless Mineflayer Bot
    ├── Test 7.1: Bot Mineflayer berhasil terhubung ke `127.0.0.1:25567` dan menerima event `spawn`
    ├── Test 7.2: Bot menerima sinkronisasi chunk dunia dan koordinat posisi awal yang valid
    ├── Test 7.3: Bot dapat menginspeksi blok di sekitarnya melalui `bot.blockAt()` sesuai arena yang dibuat
    ├── Test 7.4: Bot terputus secara bersih via `bot.quit()` dan server melepaskan entitas pemain
    └── Test 7.5: Verifikasi bebas kebocoran memori, nol hanging timer, dan shutdown server sempurna
```

---

## 4. Exact Assertion Specifications

Berikut spesifikasi assertion teknis yang wajib diimplementasikan pada `test/server/server_arena_test.js`:

### Kategori 1: Server Lifecycle
```javascript
// Test 1.1: Start server
const server = await startTestServer({ port: 25567, logging: false });
assert.equal(isServerRunning(), true, 'Server harus berstatus aktif (running) setelah startTestServer.');
assert.ok(server, 'Instance server tidak boleh null.');

// Test 1.2: Port listening
const address = server._server.socketServer.address();
assert.equal(address.port, 25567, 'Port server yang mendengarkan harus bernilai 25567.');

// Test 1.3: Stop server
await stopTestServer();
assert.equal(isServerRunning(), false, 'Server harus berstatus tidak aktif setelah stopTestServer.');

// Test 1.4: Idempotensi
await stopTestServer(); // panggil ulang saat sudah mati
assert.equal(isServerRunning(), false, 'Pemanggilan berulang stopTestServer harus tetap aman.');
```

### Kategori 2: World Block Manipulation
```javascript
// Test 2.1: Basic stone placement
await setBlock(10, 64, 5, 'stone');
const blockStone = await getBlock(10, 64, 5);
assert.equal(blockStone.name, 'stone', 'Blok pada koordinat (10, 64, 5) harus berupa stone.');

// Test 2.2: Ladder with facing
await setBlock(10, 65, 5, 'ladder', { facing: 'north' });
const blockLadder = await getBlock(10, 65, 5);
assert.equal(blockLadder.name, 'ladder', 'Blok harus berupa ladder.');
assert.equal(blockLadder.getProperties().facing, 'north', 'Properti facing ladder harus bernilai north.');

// Test 2.3: Stairs with facing and half
await setBlock(11, 64, 5, 'stone_stairs', { facing: 'east', half: 'bottom' });
const blockStairs = await getBlock(11, 64, 5);
assert.equal(blockStairs.name, 'stone_stairs', 'Blok harus berupa stone_stairs.');
assert.equal(blockStairs.getProperties().facing, 'east', 'Properti facing tangga harus east.');

// Test 2.4: Special spawner & lava
await setBlock(-256, -19, -432, 'spawner');
const blockSpawner = await getBlock(-256, -19, -432);
assert.equal(blockSpawner.name, 'spawner', 'Blok pada koordinat target harus berupa spawner.');

await setBlock(20, 64, 20, 'lava');
const blockLava = await getBlock(20, 64, 20);
assert.equal(blockLava.name, 'lava', 'Blok harus berupa lava.');

// Test 2.5: Coordinate validation
await assert.rejects(
  async () => await setBlock(0, -65, 0, 'stone'),
  /di luar batas dunia/,
  'Harus melempar error saat Y < -64.'
);
```

### Kategori 3: Level 1 Arena Verification
```javascript
const l1Data = await buildLevel1Arena(server);
assert.deepEqual(l1Data.startPos, { x: 0, y: 64, z: 0 }, 'Start position Level 1 harus [0, 64, 0].');
assert.deepEqual(l1Data.targetPos, { x: 30, y: 64, z: 0 }, 'Target position Level 1 harus [30, 64, 0].');

// Validasi sampling lantai dan ruang udara
for (let x = 0; x <= 30; x += 5) {
  const floorBlock = await getBlock(x, 63, 0);
  assert.ok(['stone', 'smooth_stone', 'emerald_block', 'diamond_block'].includes(floorBlock.name), `Lantai pada X=${x} harus solid.`);
  const air1 = await getBlock(x, 64, 0);
  const air2 = await getBlock(x, 65, 0);
  assert.equal(air1.name, 'air', `Ruang udara pada (${x}, 64, 0) harus air.`);
  assert.equal(air2.name, 'air', `Ruang udara pada (${x}, 65, 0) harus air.`);
}
```

### Kategori 4: Level 2 Arena Verification
```javascript
const l2Data = await buildLevel2Arena(server);
assert.ok(l2Data.targetPos.x >= 50, 'Panjang lintasan Level 2 minimal 50m.');

// Validasi keberadaan rintangan dan elevasi 1-blok
const stepBlock = await getBlock(15, 64, 0);
assert.ok(stepBlock.name !== 'air', 'Harus terdapat kenaikan elevasi blok pada X=15.');

const obstacleBlock = await getBlock(20, 65, 0);
assert.ok(obstacleBlock.name !== 'air', 'Harus terdapat dinding rintangan pada koordinat (20, 65, 0).');

const bypassBlock = await getBlock(20, 65, 2);
assert.equal(bypassBlock.name, 'air', 'Jalur bypass samping pada (20, 65, 2) harus terbuka (air).');
```

### Kategori 5: Level 3 Arena Verification
```javascript
const l3Data = await buildLevel3Arena(server);

// Validasi tangga balok
const stair = await getBlock(5, 68, 0);
assert.ok(stair.name.includes('stairs'), 'Harus berupa balok tangga pada tanjakan.');

// Validasi ladder shaft
const ladderBlock = await getBlock(10, 70, 15);
assert.equal(ladderBlock.name, 'ladder', 'Harus terdapat blok ladder pada shaft vertikal.');
const ladderBacking = await getBlock(10, 70, 16);
assert.ok(ladderBacking.name !== 'air', 'Ladder harus menempel pada dinding solid pendukung.');

// Validasi jembatan sempit 1-blok
const bridgeWalkway = await getBlock(10, 74, 5);
const bridgeLeft = await getBlock(9, 74, 5);
const bridgeRight = await getBlock(11, 74, 5);
assert.ok(bridgeWalkway.name !== 'air', 'Lantai jembatan tengah harus solid.');
assert.equal(bridgeLeft.name, 'air', 'Sisi kiri jembatan sempit harus berupa celah jurang (air).');
assert.equal(bridgeRight.name, 'air', 'Sisi kanan jembatan sempit harus berupa celah jurang (air).');
```

### Kategori 6: Level 4 Arena Verification
```javascript
const l4Data = await buildLevel4Arena(server);
assert.deepEqual(l4Data.spawnerCoord, { x: -256, y: -19, z: -432 }, 'Koordinat spawner harus [-256, -19, -432].');

// Validasi spawner
const spawner = await getBlock(-256, -19, -432);
assert.equal(spawner.name, 'spawner', 'Target dungeon harus memiliki blok spawner.');

// Validasi peti dan kolam lava
assert.ok(Array.isArray(l4Data.chestCoords) && l4Data.chestCoords.length >= 1, 'Harus ada minimal 1 koordinat peti.');
for (const c of l4Data.chestCoords) {
  const chestBlock = await getBlock(c.x, c.y, c.z);
  assert.equal(chestBlock.name, 'chest', `Blok pada (${c.x}, ${c.y}, ${c.z}) harus berupa chest.`);
}

const lavaBlock = await getBlock(l4Data.hazardCoord.x, l4Data.hazardCoord.y, l4Data.hazardCoord.z);
assert.equal(lavaBlock.name, 'lava', 'Blok bahaya incinerator harus berupa lava.');
```

### Kategori 7: Headless Bot Connection Lifecycle
```javascript
const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25567,
  username: 'ArenaTestBot',
  version: '1.20.1',
  checkTimeoutInterval: 5000
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Bot gagal spawn dalam 5000ms')), 5000);
  bot.once('spawn', () => {
    clearTimeout(timer);
    resolve();
  });
  bot.once('error', reject);
});

assert.ok(bot.entity, 'Bot harus memiliki entitas aktif setelah spawn.');
assert.ok(typeof bot.entity.position.x === 'number', 'Koordinat bot harus valid number.');

// Inspeksi blok oleh bot
const inspectedBlock = bot.blockAt(new Vec3(0, 63, 0));
assert.ok(inspectedBlock, 'Bot harus dapat menginspeksi blok pada koordinat dunia.');
assert.ok(['stone', 'smooth_stone', 'emerald_block'].includes(inspectedBlock.name), 'Inspeksi blok bot harus cocok dengan arena.');

// Disconnect bersih
await new Promise((resolve) => {
  bot.once('end', resolve);
  bot.quit();
});
```

---

## 5. Mock and Integration Test Structures

Struktur file dan modul yang dirancang untuk Milestone 2:

1. **`src/server/testServer.js`**:
   - Membungkus `flying-squid` `createMCServer` dengan konfigurasi headless (online-mode: false, gameMode: 1, logging: false, port: 25567).
   - Menyediakan `startTestServer(options)`, `stopTestServer()`, `isServerRunning()`, `resetWorld()`, `setBlock()`, `getBlock()`, `getServerInstance()`.
   - Menggunakan `minecraft-data` dan `prismarine-block` untuk konversi nama blok & state properties ke `stateId`.

2. **`src/server/arenaBuilder.js`**:
   - Mengimplementasikan `buildLevel1Arena`, `buildLevel2Arena`, `buildLevel3Arena`, `buildLevel4Arena`, `buildArena`, dan `clearArena`.
   - Menghasilkan struktur blok deterministik sesuai konstanta `BENCHMARK_CONFIGS` dan `TARGET_SPAWNER_COORDINATES`.

3. **`test/server/server_arena_test.js`**:
   - Menggunakan `describe` dan `it` dari `node:test` dan `assert` dari `node:assert/strict`.
   - Hooks:
     - `before`: Memulai server test awal atau inisialisasi lingkungan.
     - `after`: Memastikan server dihentikan dan semua bot terputus (`stopTestServer()`).
     - `afterEach`: Membersihkan state blok atau arena antar tes.

---

## 6. Caveats
- `flying-squid` memerlukan opsi `generation.options.seed` saat menggunakan generator `superflat` atau `empty` agar tidak terjadi TypeError pada plugin world.
- Pada versi Minecraft 1.18+, batas vertikal dunia adalah Y = -64 hingga Y = 320 (Level 4 dungeon pada Y = -20 berada di dalam zona deepslate yang sepenuhnya didukung).
- Port 25567 dipilih agar tidak konflik dengan port default Minecraft (25565) atau port WebSocket dashboard (8080).

---

## 7. Conclusion
Spesifikasi pengujian untuk `test/server/server_arena_test.js` telah lengkap dan terperinci mencakup 7 kategori pengujian, seluruh level arena 1-4, manipulasi blok, serta siklus hidup bot Mineflayer dengan target eksekusi < 10 detik dan zero memory leaks.

---

## 8. Verification Method
Untuk memverifikasi spesifikasi ini secara independen setelah implementasi dilakukan oleh `code_architect_1`:
```bash
node --test test/server/server_arena_test.js
```
Kriteria keberhasilan:
- Seluruh pengujian pada 7 kategori berstatus PASS (100% lulus).
- Total waktu eksekusi < 10 detik.
- Tidak ada error `EADDRINUSE`, tidak ada hanging promises, dan proses exit dengan code 0.
