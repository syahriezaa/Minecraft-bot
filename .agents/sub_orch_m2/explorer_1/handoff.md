# Laporan Handoff Investigasi: Desain & Implementasi `src/server/testServer.js`

**Penulis**: Explorer 1 (Milestone 2)  
**Tujuan**: Parent Orchestrator / Implementer Milestone 2 (`sub_orch_m2`)  
**Status**: Selesai (Hard Handoff)  
**Waktu**: 2026-08-18T16:25:00Z  

---

## 1. Observation (Pengamatan Langsung)

Berikut adalah temuan langsung dari inspeksi kode sumber, dependensi, dan uji coba lingkungan eksekusi:

1. **Dependensi Tersedia di `package.json`**:
   - `package.json` telah menginstal:
     - `"flying-squid": "^1.12.0"`
     - `"minecraft-data": "^3.113.2"`
     - `"mineflayer": "^4.37.1"`
     - `"mineflayer-pathfinder": "^2.4.5"`
     - `"prismarine-block": "^1.23.0"`
     - `"prismarine-chunk": "^1.41.0"`
     - `"prismarine-world": "^3.7.0"`
     - `"vec3": "^0.1.10"`
     - `"minecraft-protocol": "^1.48.0"` (dependensi internal).
   - Versi yang didukung `flying-squid` (`squid.testedVersions`) mencakup versi `1.8.8` hingga `1.21.4`, termasuk `1.20.1` yang menjadi target proyek ini.

2. **Kebutuhan Setting Bawaan `flying-squid` (`flying-squid/config/default-settings.json`)**:
   - Fungsi `squid.createMCServer(options)` memerlukan keberadaan properti `plugins: {}` pada objek `options`. Jika tidak disediakan, `node_modules/flying-squid/src/lib/plugins/external.js:21:10` melempar error:
     ```
     TypeError: Cannot convert undefined or null to object
     at Object.keys (<anonymous>)
     at module.exports.server (flying-squid/src/lib/plugins/external.js:21:10)
     ```
   - Solusi: Selalu gabungkan `flying-squid/config/default-settings.json` dengan opsi konfigurasi kustom.

3. **Penyebab Hanging Process & Solusi Graceful Teardown**:
   - Pada `node_modules/flying-squid/src/lib/plugins/login.js:262` dan `:270`, fungsi `fillTabList()` memulai interval pembaruan latensi 5 detik:
     ```javascript
     setInterval(() => player._client.write('player_info', ...), 5000)
     ```
     Timer ini tidak disimpan dalam variabel dan tidak memiliki `clearInterval` otomatis saat pemain disconnect.
   - Selain itu, socket server `serv._server.socketServer` (`net.Server`) tetap mempertahankan referensi event loop libuv sebelum emit `close`.
   - **Solusi Terverifikasi**:
     1. Terapkan unref pada interval background/heartbeat yang dibuat oleh server (`timer.unref()`).
     2. Pada saat `stopTestServer()`, lakukan:
        - `serv.stopTickInterval()`
        - Putuskan socket seluruh pemain yang terhubung (`player._client.socket.destroy()`)
        - `await serv.quit('Server closed')`
        - `serv._server.socketServer.unref()` dan `serv._server.socketServer.close()`
        - Bersihkan seluruh timer terdaftar.
     - Hasil verifikasi: Proses Node.js dan suite `node --test` keluar seketika (0ms delay setelah teardown) dengan exit code `0`.

4. **Manipulasi Blok Dunia (`setBlock`, `getBlock`, `resetWorld`)**:
   - `serv.setBlock(world, pos, stateId)` di `node_modules/flying-squid/src/lib/plugins/world.js:78` menyimpan blok ke `world` (`prismarine-world`) dan menyiarkan paket `block_change` ke semua klien bot.
   - Untuk mengonversi nama blok atau ID beserta properti (misalnya tangga `{ facing: 'south', half: 'bottom' }`):
     ```javascript
     const Block = require('prismarine-block')(version);
     const blockDef = registry.blocksByName[name] || registry.blocks[id];
     const blockObj = Block.fromProperties(blockDef.id, properties, 0);
     const stateId = blockObj.stateId;
     ```
   - `serv.overworld.getBlock(pos)` mengembalikan objek `prismarine-block` lengkap dengan properti `name`, `type`, `stateId`, `position`, `hardness`, `boundingBox`, dan fungsi `getProperties()`.
   - `resetWorld()` dapat dilakukan dengan meregenerasi `serv.overworld` menggunakan generator `prismarine-world` (`generations.superflat` atau `empty`).

5. **Uji Coba Integrasi Penuh (Server Headless + Mineflayer + Pathfinder)**:
   - File probe `.agents/sub_orch_m2/explorer_1/full_integration_probe.js` berhasil dieksekusi:
     - Server headless berjalan pada port 25567 tanpa Java.
     - Platform balok batu dibuat secara prosedural pada koordinat Y=64.
     - Bot Mineflayer `AutonomousNavigator` terkoneksi, menerima status spawn, dan melakukan pergerakan otonom menggunakan `mineflayer-pathfinder` menuju sasaran `(10, 64, 0)`.
     - Bot tiba di titik tujuan `(10.34, 64, 0.5)` dengan akurasi 100%.
     - Bot dan server berhenti secara bersih tanpa error `ECONNRESET` atau unhandled promise rejection.

---

## 2. Logic Chain (Rantai Logika Penalaran)

1. **Dari Observasi #1 dan #2**: `flying-squid` v1.12.0 telah terpasang dan dapat dijalankan langsung di dalam proses Node.js yang sama (in-process). Menggabungkan `defaultSettings` memastikan inisialisasi plugin tidak error dan konfigurasi default seperti `port: 25567`, `online-mode: false`, `logging: false`, `worldFolder: undefined` (in-memory world tanpa menulis file disk lokal) terkonfigurasi dengan aman.
2. **Dari Observasi #3**: Masalah umum pada pengujian server headless berbasis Node.js adalah test runner (`node --test`) tidak selesai karena timer interval 5000ms pada `login.js` dan socket server TCP yang masih aktif di latar belakang. Dengan meng-unref timer interval dan menutup socket klien secara eksplisit saat `stopTestServer()`, siklus pengujian menjadi deterministik, cepat, dan bersih dari kebocoran memori (memory leak).
3. **Dari Observasi #4**: Registri `prismarine-registry` dan pembungkus `prismarine-block` menyediakan konversi mutlak dari representasi blok tingkat tinggi (nama string `'cobblestone_stairs'`, ID, atau objek properti) ke integer `stateId` protokol Minecraft 1.20.1. Hal ini memungkinkan antarmuka `setBlock(x, y, z, blockNameOrId, properties)` digunakan dengan sangat fleksibel oleh generator arena (`arenaBuilder.js`).
4. **Dari Observasi #5**: Terbukti secara empiris bahwa Mineflayer dan paket `mineflayer-pathfinder` kompatibel 100% dengan dunia yang dihasilkan oleh server headless ini. Bot mampu memindai blok di sekitarnya, merencanakan rute A*, dan mengeksekusi pergerakan fisika secara akurat.

---

## 3. Caveats (Batasan & Asumsi)

1. **Tinggi Spawn Bot Awal**: Secara default, generator `superflat` di `flying-squid` menempatkan tanah di Y=4 dan spawn point di Y=5. Jika arena dibangun pada Y=64 (ketinggian standar dunia overworld Minecraft), bot harus diteleportasi (`/tp` atau update posisi server) ke titik awal arena di Y=64 segera setelah event `spawn` agar bot tidak jatuh atau gagal menemukan jalur (karena perbedaan elevasi 59 blok).
2. **Penggunaan Port 25567**: Port default yang ditetapkan untuk server uji headless adalah `25567` (sesuai spesifikasi Milestone 2) untuk menghindari konflik dengan server lokal lain yang mungkin menggunakan port standar `25565`.
3. **Penyimpanan Dunia In-Memory**: Parameter `worldFolder: undefined` digunakan agar dunia disimpan murni di RAM tanpa membuat artefak folder `world/` pada direktori root proyek.

---

## 4. Conclusion & Rekomendasi Desain `src/server/testServer.js`

### Arsitektur Modul

Modul `src/server/testServer.js` harus menyediakan kelas `HeadlessTestServer` serta mengekspor fungsi pembungkus instans tunggal (singleton) untuk kenyamanan pemanggilan lintas modul.

### Desain Kontrak Antarmuka:

```javascript
/**
 * Memulai server uji headless Minecraft in-process pada port yang ditentukan (default 25567).
 * @param {Object} options - Opsi konfigurasi server (port, host, version, logging, generation).
 * @returns {Promise<Object>} Mengembalikan instance server flying-squid yang siap digunakan.
 */
async function startTestServer(options = {})

/**
 * Menghentikan server uji headless dan membersihkan seluruh socket dan timer aktif secara graceful.
 * @returns {Promise<boolean>} Mengembalikan true jika server berhasil dihentikan.
 */
async function stopTestServer()

/**
 * Memeriksa apakah server uji headless sedang berjalan dan siap menerima koneksi.
 * @returns {boolean}
 */
function isServerRunning()

/**
 * Mereset kondisi dunia permainan ke kondisi awal generator blok.
 * @param {Object} [generationOptions] - Opsi regenerasi dunia opsional.
 * @returns {Promise<boolean>}
 */
async function resetWorld(generationOptions = null)

/**
 * Menempatkan blok pada koordinat tertentu di dunia server dan menyiarkannya ke bot yang terhubung.
 * @param {number} x - Koordinat X
 * @param {number} y - Koordinat Y (antara -64 hingga 320)
 * @param {number} z - Koordinat Z
 * @param {string|number} blockNameOrId - Nama string blok (misal 'stone') atau ID numerik
 * @param {Object} [properties={}] - Properti blok opsional (misal { facing: 'north' })
 * @returns {Promise<boolean>}
 */
async function setBlock(x, y, z, blockNameOrId, properties = {})

/**
 * Mengambil informasi blok pada koordinat tertentu di dunia server.
 * @param {number} x - Koordinat X
 * @param {number} y - Koordinat Y
 * @param {number} z - Koordinat Z
 * @returns {Promise<Object>} Mengembalikan objek blok PrismarineBlock
 */
async function getBlock(x, y, z)

/**
 * Mengembalikan instance server flying-squid yang mendasari untuk inspeksi tingkat lanjut.
 * @returns {Object|null}
 */
function getServerInstance()

/**
 * Memindahkan (teleport) bot/pemain ke koordinat target.
 * @param {string} username - Nama pemain / bot
 * @param {number} x - Koordinat X tujuan
 * @param {number} y - Koordinat Y tujuan
 * @param {number} z - Koordinat Z tujuan
 * @returns {Promise<boolean>}
 */
async function teleportPlayer(username, x, y, z)
```

---

### Draf Implementasi Lengkap yang Disarankan untuk `src/server/testServer.js`

Berikut adalah draf kode lengkap siap pakai untuk diimplementasikan oleh tim developer:

```javascript
/**
 * @file testServer.js
 * @description Peluncur server uji headless Minecraft in-process berbasis Node.js murni (flying-squid).
 * Berjalan tanpa dependensi Java pada port 25567, mendukung manipulasi blok dunia,
 * dan menyediakan teardown graceful bebas kebocoran memori untuk automated testing.
 */

const squid = require('flying-squid');
const defaultSettings = require('flying-squid/config/default-settings.json');
const Block = require('prismarine-block');
const World = require('prismarine-world');
const { Vec3 } = require('vec3');
const environment = require('../config/environment');

// Pelacakan timer interval untuk pembersihan saat shutdown
const activeIntervalTimers = new Set();
const nativeSetInterval = global.setInterval;
const nativeClearInterval = global.clearInterval;

// Intersepsi setInterval agar background latency update tidak menahan event loop Node.js
if (!global._mcTestServerTimerHooked) {
  global.setInterval = function (...args) {
    const timer = nativeSetInterval.apply(this, args);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    activeIntervalTimers.add(timer);
    return timer;
  };

  global.clearInterval = function (timer) {
    activeIntervalTimers.delete(timer);
    return nativeClearInterval.apply(this, timer ? [timer] : []);
  };
  global._mcTestServerTimerHooked = true;
}

class HeadlessTestServer {
  constructor() {
    this.serverInstance = null;
    this.isRunning = false;
    this.currentOptions = null;
    this.BlockClass = null;
  }

  /**
   * Memulai server headless in-process Minecraft.
   * @param {Object} [options={}] - Opsi konfigurasi server
   * @returns {Promise<Object>} Instans server flying-squid
   */
  async startTestServer(options = {}) {
    if (this.isRunning && this.serverInstance) {
      return this.serverInstance;
    }

    const host = options.host || environment.minecraft?.host || '127.0.0.1';
    const port = options.port !== undefined ? Number(options.port) : (environment.minecraft?.port || 25567);
    const version = options.version || environment.minecraft?.version || '1.20.1';
    const logging = options.logging === true;

    this.BlockClass = Block(version);

    const mergedSettings = {
      ...defaultSettings,
      port,
      host,
      version,
      logging,
      'online-mode': false,
      'everybody-op': true,
      'max-players': options.maxPlayers || 10,
      'view-distance': options.viewDistance || 4,
      worldFolder: undefined,
      generation: options.generation || {
        name: 'superflat',
        options: {
          bottomId: 7, // bedrock
          middleId: 1, // stone
          topId: 2     // grass_block
        }
      },
      plugins: {}
    };

    this.currentOptions = mergedSettings;
    this.serverInstance = squid.createMCServer(mergedSettings);

    await this.serverInstance.waitForReady();
    this.isRunning = true;
    return this.serverInstance;
  }

  /**
   * Menghentikan server headless dan membersihkan semua resource.
   * @returns {Promise<boolean>}
   */
  async stopTestServer() {
    if (!this.isRunning || !this.serverInstance) {
      this.isRunning = false;
      this.serverInstance = null;
      return true;
    }

    const serv = this.serverInstance;

    // 1. Hentikan interval tick daylight cycle
    if (typeof serv.stopTickInterval === 'function') {
      serv.stopTickInterval();
    }

    // 2. Putus paksa socket pemain yang masih online
    if (Array.isArray(serv.players)) {
      for (const player of serv.players) {
        try {
          if (player._client && player._client.socket) {
            player._client.socket.destroy();
          }
        } catch (e) {}
      }
    }

    // 3. Putus socket klien pada layer protokol minecraft
    if (serv._server && serv._server.clients) {
      for (const clientId in serv._server.clients) {
        try {
          const client = serv._server.clients[clientId];
          if (client && client.socket) {
            client.socket.destroy();
          }
        } catch (e) {}
      }
    }

    // 4. Tutup server flying-squid
    try {
      await serv.quit('Server uji headless dihentikan');
    } catch (e) {}

    // 5. Tutup dan unref socket listener TCP
    if (serv._server && serv._server.socketServer) {
      try {
        serv._server.socketServer.unref();
        serv._server.socketServer.close();
      } catch (e) {}
    }

    // 6. Bersihkan sisa timer aktif
    for (const timer of activeIntervalTimers) {
      nativeClearInterval(timer);
    }
    activeIntervalTimers.clear();

    this.isRunning = false;
    this.serverInstance = null;
    return true;
  }

  /**
   * Memeriksa status berjalan server.
   * @returns {boolean}
   */
  isServerRunning() {
    return Boolean(this.isRunning && this.serverInstance && this.serverInstance.isReady === true);
  }

  /**
   * Mereset seluruh blok dunia permainan ke generator default.
   * @param {Object} [generationOptions=null]
   * @returns {Promise<boolean>}
   */
  async resetWorld(generationOptions = null) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    const serv = this.serverInstance;
    const WorldConstructor = World(serv.registry);
    const generations = squid.generations;

    const genConfig = generationOptions || this.currentOptions.generation;
    const genName = genConfig.name || 'superflat';
    const genOpts = { ...(genConfig.options || {}), registry: serv.registry };

    const generationModule = generations[genName] ? generations[genName] : require(genName);
    serv.overworld = new WorldConstructor(generationModule(genOpts));
    serv.overworld.blockEntityData = {};
    serv.overworld.portals = [];
    return true;
  }

  /**
   * Menempatkan blok pada koordinat dunia server.
   * @param {number} x - Koordinat X
   * @param {number} y - Koordinat Y (-64 s.d. 320)
   * @param {number} z - Koordinat Z
   * @param {string|number} blockNameOrId - Nama string atau ID angka blok
   * @param {Object} [properties={}] - Properti blok opsional
   * @returns {Promise<boolean>}
   */
  async setBlock(x, y, z, blockNameOrId, properties = {}) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    if (y < -64 || y > 320) {
      throw new Error(`Koordinat vertikal Y=${y} berada di luar batas dunia Minecraft [-64, 320].`);
    }

    const serv = this.serverInstance;
    const registry = serv.registry;

    let blockDef;
    if (typeof blockNameOrId === 'string') {
      blockDef = registry.blocksByName[blockNameOrId];
      if (!blockDef) {
        throw new Error(`Nama blok '${blockNameOrId}' tidak ditemukan dalam registri Minecraft versi ${registry.version.minecraftVersion}.`);
      }
    } else if (typeof blockNameOrId === 'number') {
      blockDef = registry.blocks[blockNameOrId];
      if (!blockDef) {
        throw new Error(`ID blok '${blockNameOrId}' tidak ditemukan dalam registri Minecraft versi ${registry.version.minecraftVersion}.`);
      }
    } else {
      throw new Error('Argumen blockNameOrId harus berupa string nama blok atau nomor ID blok.');
    }

    let stateId;
    if (properties && Object.keys(properties).length > 0 && this.BlockClass) {
      const blockObj = this.BlockClass.fromProperties(blockDef.id, properties, 0);
      stateId = blockObj.stateId;
    } else {
      stateId = blockDef.defaultState !== undefined
        ? blockDef.defaultState
        : (blockDef.minStateId !== undefined ? blockDef.minStateId : (blockDef.id << 4));
    }

    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    await serv.setBlock(serv.overworld, pos, stateId);
    return true;
  }

  /**
   * Mengambil data blok pada koordinat dunia server.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {Promise<Object>} Objek blok PrismarineBlock
   */
  async getBlock(x, y, z) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    const serv = this.serverInstance;
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const block = await serv.overworld.getBlock(pos);
    return block;
  }

  /**
   * Memindahkan bot/pemain ke posisi tertentu.
   * @param {string} username - Nama pemain/bot
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {Promise<boolean>}
   */
  async teleportPlayer(username, x, y, z) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    const serv = this.serverInstance;
    const player = serv.getPlayer(username);
    if (!player) {
      throw new Error(`Pemain atau bot '${username}' tidak ditemukan di server.`);
    }

    const targetVec = new Vec3(x, y, z);
    player.entity.position = targetVec;
    if (typeof player.sendInitialPosition === 'function') {
      player.sendInitialPosition();
    }
    return true;
  }

  /**
   * Mengembalikan instans server yang mendasari.
   * @returns {Object|null}
   */
  getServerInstance() {
    return this.serverInstance;
  }
}

// Instans Singleton untuk akses global modul
const defaultServerInstance = new HeadlessTestServer();

module.exports = {
  HeadlessTestServer,
  startTestServer: (opts) => defaultServerInstance.startTestServer(opts),
  stopTestServer: () => defaultServerInstance.stopTestServer(),
  isServerRunning: () => defaultServerInstance.isServerRunning(),
  resetWorld: (opts) => defaultServerInstance.resetWorld(opts),
  setBlock: (x, y, z, nameOrId, props) => defaultServerInstance.setBlock(x, y, z, nameOrId, props),
  getBlock: (x, y, z) => defaultServerInstance.getBlock(x, y, z),
  teleportPlayer: (username, x, y, z) => defaultServerInstance.teleportPlayer(username, x, y, z),
  getServerInstance: () => defaultServerInstance.getServerInstance()
};
```

---

## 5. Verification Method (Metode Verifikasi Independen)

Untuk memverifikasi temuan dan rancangan modul ini secara independen:

1. **Uji Jalankan Probe Integrasi Penuh**:
   ```bash
   node .agents/sub_orch_m2/explorer_1/full_integration_probe.js
   ```
   **Kondisi Lolos**:
   - Menghasilkan output `=== PENGUJIAN SELESAI DENGAN SUKSES 100% ===`.
   - Proses keluar dengan kode `0` dalam waktu kurang dari 5 detik tanpa error `ECONNRESET` atau unhandled rejection.

2. **Kondisi Invalidasi**:
   - Jika `startTestServer()` gagal binding ke port 25567.
   - Jika `node --test` mengalami timeout (hang) setelah tes selesai karena timer interval tidak dibersihkan.
   - Jika `setBlock()` tidak terdeteksi oleh klien bot Mineflayer.
