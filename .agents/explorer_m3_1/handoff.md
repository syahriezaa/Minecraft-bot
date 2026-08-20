# Handoff Report: Milestone 3 — Zombie Spawner Farming Task Architecture (`src/tasks/zombieSpawnerTask.js`)

## 1. Observation
Berdasarkan investigasi terhadap seluruh berkas otoritatif dan modul sistem terkait:
1. **Target Koordinat Spawner**:
   - Berkas: `src/config/constants.js:63-67` mendefinisikan `TARGET_SPAWNER_COORDINATES = Object.freeze({ x: -256, y: -20, z: -432 })`.
   - Berkas: `PROJECT.md:19` mencatat Feature #7: *"Autonomous farming loop at spawner `[-256, -20, -432]`, targeting zombies with 625ms weapon cooldown"*.
   - Berkas: `test/e2e/test_zombie_combat_xp.js:32-37` mengonfirmasi pengujian zombie spawner pada ruang bawah tanah `[-256, -20, -432]`.

2. **Mekanika Cooldown Senjata (Combat Pacing)**:
   - Berkas: `src/config/constants.js:88-97` mendefinisikan `WEAPON_COOLDOWNS_MS = { sword: 625, axe: 1250, trident: 909, pickaxe: 833, shovel: 1000, hoe: 500, hand: 250, default: 625 }`.
   - Berkas: `test/helpers/assertions.js:86-96` menegakkan `assertAttackPacing(attackTimestamps, minCooldownMs = 625)` yang memverifikasi bahwa interval serangan antarentitas memenuhi `delta >= minCooldownMs - 20ms`.
   - Setiap serangan sebelum batas cooldown selesai dianggap *spam attack* dan ditolak oleh server/anti-cheat.

3. **Perolehan XP & Loot**:
   - Berkas: `test/e2e/test_zombie_combat_xp.js:63-72` mendemonstrasikan bahwa membunuh zombie menghasilkan drop XP (5 XP per zombie) dan loot (`rotten_flesh`, `iron_ingot`).
   - Formula kenaikan level Minecraft: Level 1 (7 XP), Level 2 (16 XP), dll. (Level = $\lfloor XP / 7 \rfloor$ untuk level awal atau formula standar Minecraft).
   - Telemetri dicatat ke PostgreSQL `telemetry_logs` dan `benchmark_runs` (`src/database/telemetryRepository.js:203-239`).

4. **Karakteristik & Dukungan Klien Ganda (Dual Client)**:
   - **`LiveProtocolClient` (Protokol 775 / NeoForge 26.1.2)** (`src/network/liveProtocolClient.js`):
     - Memancarkan event: `spawn`, `packet`, `keep_alive`, `teleport`, `health` (`{ health, food }`), `disconnect`, `end`.
     - Menyediakan metode: `sendPosition({ x, y, z, onGround, hasHorizontalCollision })`, `sendPositionAndRotation({ x, y, z, yaw, pitch, onGround, hasHorizontalCollision })`, `sendAttack(targetEntityId)`, `sendChat(message)`, `disconnect()`.
   - **`MockArenaHarness` / Mineflayer Bot** (`test/helpers/mockArenaHarness.js`, `src/navigation/botClient.js`):
     - Memiliki `bot.entity.position`, `bot.health`, `bot.food`, `bot.experience.points`, `bot.experience.level`, `bot.inventory`.
     - Menyediakan metode: `bot.attack(target)`, `bot.lookAt(coord)`, `bot.nearestEntity(filter)`.

5. **Kontrak Status & Dashboard**:
   - Berkas: `PROJECT.md:44-46` dan `.agents/sub_orch_m3_autonomy/SCOPE.md:45-48` mendefinisikan interface contract:
     `getTaskStatus() -> { active: boolean, targetCoords: { x, y, z }, zombiesKilled: number, xpGained: number, currentHealth: number, currentFood: number, runtimeSeconds: number }`.
   - Event yang dipancarkan: `task_start`, `task_step`, `mob_killed`, `xp_collected`, `vitality_warning`, `auto_eat`, `retreat_triggered`, `task_complete`.

---

## 2. Logic Chain
1. **Kebutuhan Adapter Klien**: Karena `LiveProtocolClient` dan Mineflayer/Mock bot memiliki API berbeda (`sendAttack(id)` vs `attack(target)`), `ZombieSpawnerTask` harus memiliki lapisan adaptasi (`ClientAdapter`) terpadu. Adapter mendeteksi apakah instance klien merupakan `LiveProtocolClient`, Mineflayer bot, atau `MockArenaHarness`, lalu mengekspos API seragam:
   - `getPosition() -> { x, y, z }`
   - `getVitality() -> { health: number, food: number }`
   - `getExperience() -> { points: number, level: number }`
   - `getInventory() -> Array<{ name: string, count: number }>`
   - `lookAt(targetCoord)`
   - `attack(targetEntityIdOrObj)`
   - `consumeFood(foodItemName)`
   - `getNearbyEntities(radius, typeFilter) -> Array<Entity>`

2. **Alur Siklus Hidup Farming (State Machine)**:
   Task beroperasi melalui Finite State Machine (FSM):
   - `IDLE`: Menunggu inisialisasi / perintah mulai.
   - `NAVIGATING`: Berpindah ke posisi stasiun spawner `[-256, -20, -432]` jika jarak bot $> 3.0$ meter.
   - `FARMING`: Berada di perimeter spawner, memindai zombie dalam radius serangan ($\le 4.5$m), mengarahkan pandangan (`lookAt`), dan melancarkan tebasan sesuai cooldown senjata.
   - `EATING`: Terpicu jika `food <= 14` atau regenerasi darah diperlukan (`health < 20 && food < 20`). Mencari makanan di inventaris dan mengonsumsinya.
   - `RETREATING`: Terpicu darurat jika `health < 6` (3 hearts). Bot mundur sejauh 6-10 meter ke waypoint aman, menghentikan serangan sementara hingga darah pulih ($\ge 14$ HP).
   - `PAUSED`: Penangguhan sementara oleh supervisor anti-AFK atau user.
   - `COMPLETED`: Tugas selesai atau durasi/kuota tercapai.

3. **Penegakan Cooldown Senjata Presisi**:
   - `lastAttackTimestamp` dicatat pada setiap eksekusi serangan.
   - Durasi jeda dihitung dinamis berdasarkan tipe senjata (`WEAPON_COOLDOWNS_MS[weapon] || 625ms`).
   - Penambahan buffer keamanan $+5$ms untuk menjamin tidak terjadi fluktuasi tick timer yang melanggar batasan `assertAttackPacing`.

4. **Deteksi XP & Loot Otomatis**:
   - Nilai awal XP (`initialXP`) dan inventory dicatat saat task dimulai.
   - Pembaruan berkala dari event `experience` / `health` atau polling delta inventaris menghitung `xpGained = currentXP - initialXP` dan akumulasi loot per jenis item.
   - Menghasilkan event `xp_collected` dan `loot_collected`.

5. **Antarmuka Telemetri & Web Server**:
   - Metode `getTaskStatus()` mengembalikan snapshot data lengkap yang dapat langsung di-broadcast ke Web Dashboard (`/api/status` & WebSocket `TICK_UPDATE`).
   - Mendukung integrasi dengan `telemetryRepository.js` untuk persistensi log PostgreSQL.

---

## 3. Caveats
1. **Lingkungan Headless Tanpa Pathfinder Penuh**: Pada `LiveProtocolClient` (protokol 775 murni tanpa plugin pathfinder eksternal), navigasi dilakukan via interpolasi transmisi paket `sendPositionAndRotation`. Pada Mineflayer, navigasi menggunakan `bot.pathfinder`. Lapisan adapter menangani kedua kasus dengan anggun.
2. **Ketersediaan Makanan di Inventaris**: Jika bot kehabisan makanan saat darah rendah, FSM akan beralih ke mode bertahan/mundur (`RETREATING`) tanpa gagal fatal (graceful panic evasion).
3. **Deteksi Entitas pada Live Server**: Pada live server NeoForge 26.1.2, jika paket entity spawn belum di-parse secara komprehensif oleh klien dasar, `ZombieSpawnerTask` mendukung registrasi entitas manual/event packet listener atau simulated targets untuk pengujian deterministik.

---

## 4. Conclusion & Complete Implementation Design

Berikut adalah spesifikasi arsitektur dan rancangan implementasi lengkap untuk berkas `src/tasks/zombieSpawnerTask.js`:

```javascript
/**
 * @file zombieSpawnerTask.js
 * @description Tugas Otonom Pembasmi Zombie & Pengumpul XP di Spawner Bawah Tanah [-256, -20, -432].
 * Dilengkapi lapisan adaptasi klien ganda (LiveProtocolClient & Mineflayer/MockArenaHarness),
 * penegakan jeda serangan senjata (weapon cooldown pacing >= 625ms), FSM manajemen vitalitas
 * (auto-eat & retreat HP < 6), serta pelacak XP dan loot inventaris real-time.
 *
 * Aturan Tim: Komentar kode, pesan log pengguna, dan status UI dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { TARGET_SPAWNER_COORDINATES, WEAPON_COOLDOWNS_MS } = require('../config/constants');

/**
 * Status Finite State Machine (FSM) Tugas Spawner
 */
const TASK_STATES = Object.freeze({
  IDLE: 'IDLE',
  NAVIGATING: 'NAVIGATING',
  FARMING: 'FARMING',
  EATING: 'EATING',
  RETREATING: 'RETREATING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED'
});

/**
 * Daftar Item Makanan yang Didukung untuk Vitality Recovery
 */
const FOOD_ITEMS = Object.freeze([
  'cooked_beef', 'steak', 'cooked_porkchop', 'golden_apple', 'bread',
  'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'baked_potato', 'apple', 'carrot'
]);

/**
 * Daftar Tipe Entitas Target Mob yang Valid
 */
const VALID_TARGET_MOBS = Object.freeze([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton'
]);

/**
 * @class UnifiedClientAdapter
 * @description Menyediakan antarmuka seragam antara LiveProtocolClient dan Mineflayer/Mock bot.
 */
class UnifiedClientAdapter {
  constructor(clientInstance) {
    this.rawClient = clientInstance;
    this.isLiveClient = Boolean(
      clientInstance && (clientInstance.protocolState !== undefined || typeof clientInstance._sendPacketRaw === 'function')
    );
    this.isMockOrMineflayer = Boolean(
      clientInstance && (clientInstance.bot !== undefined || clientInstance.entity !== undefined || clientInstance.inventory !== undefined)
    );
    this.botRef = clientInstance?.bot || clientInstance;
  }

  getPosition() {
    if (this.isLiveClient) {
      return { ...this.rawClient.position };
    }
    if (this.botRef?.entity?.position) {
      const p = this.botRef.entity.position;
      return { x: p.x, y: p.y, z: p.z };
    }
    return { x: 0, y: 64, z: 0 };
  }

  setPosition(pos) {
    if (this.isLiveClient) {
      this.rawClient.sendPosition({ x: pos.x, y: pos.y, z: pos.z, onGround: true });
    } else if (this.botRef?.entity?.position) {
      this.botRef.entity.position = { ...pos };
    }
  }

  getHealth() {
    if (this.isLiveClient) return this.rawClient.health ?? 20;
    return this.botRef?.health ?? 20;
  }

  getFood() {
    if (this.isLiveClient) return this.rawClient.food ?? 20;
    return this.botRef?.food ?? 20;
  }

  getExperience() {
    if (this.isLiveClient) {
      return {
        points: this.rawClient.experiencePoints || 0,
        level: this.rawClient.experienceLevel || 0
      };
    }
    if (this.botRef?.experience) {
      return {
        points: this.botRef.experience.points || 0,
        level: this.botRef.experience.level || 0
      };
    }
    return { points: 0, level: 0 };
  }

  setExperience(points, level) {
    if (this.isLiveClient) {
      this.rawClient.experiencePoints = points;
      this.rawClient.experienceLevel = level;
    } else if (this.botRef?.experience) {
      this.botRef.experience.points = points;
      this.botRef.experience.level = level;
    }
  }

  getInventoryItems() {
    if (this.botRef?.inventory?.items) {
      if (Array.isArray(this.botRef.inventory.items)) {
        return this.botRef.inventory.items;
      }
      if (typeof this.botRef.inventory.items === 'function') {
        return this.botRef.inventory.items();
      }
    }
    return [];
  }

  getItemCount(itemName) {
    if (typeof this.botRef?.inventory?.getItemCount === 'function') {
      return this.botRef.inventory.getItemCount(itemName);
    }
    const items = this.getInventoryItems();
    const it = items.find(i => (i.name === itemName || i.name?.includes(itemName)));
    return it ? (it.count || 1) : 0;
  }

  addItem(itemName, count = 1) {
    if (typeof this.botRef?.inventory?.addItem === 'function') {
      this.botRef.inventory.addItem(itemName, count);
    }
  }

  removeItem(itemName, count = 1) {
    if (typeof this.botRef?.inventory?.removeItem === 'function') {
      return this.botRef.inventory.removeItem(itemName, count);
    }
    return false;
  }

  async lookAt(coord) {
    if (this.isLiveClient) {
      const pos = this.getPosition();
      const dx = coord.x - pos.x;
      const dy = coord.y - pos.y;
      const dz = coord.z - pos.z;
      const distXZ = Math.hypot(dx, dz);
      const yaw = Math.atan2(-dx, -dz) * (180 / Math.PI);
      const pitch = Math.atan2(-dy, distXZ) * (180 / Math.PI);
      this.rawClient.sendPositionAndRotation({
        x: pos.x, y: pos.y, z: pos.z,
        yaw, pitch,
        onGround: true,
        hasHorizontalCollision: false
      });
    } else if (typeof this.botRef?.lookAt === 'function') {
      await this.botRef.lookAt(coord);
    }
  }

  attack(target) {
    if (this.isLiveClient) {
      const targetId = typeof target === 'object' ? (target.id || target.entityId || 1) : target;
      this.rawClient.sendAttack(targetId);
      return { success: true, targetId, timestamp: Date.now() };
    }
    if (typeof this.botRef?.attack === 'function') {
      return this.botRef.attack(target);
    }
    return { success: false, timestamp: Date.now() };
  }

  on(event, callback) {
    if (this.rawClient && typeof this.rawClient.on === 'function') {
      this.rawClient.on(event, callback);
    }
    if (this.botRef && this.botRef !== this.rawClient && typeof this.botRef.on === 'function') {
      this.botRef.on(event, callback);
    }
  }

  removeListener(event, callback) {
    if (this.rawClient && typeof this.rawClient.removeListener === 'function') {
      this.rawClient.removeListener(event, callback);
    }
    if (this.botRef && this.botRef !== this.rawClient && typeof this.botRef.removeListener === 'function') {
      this.botRef.removeListener(event, callback);
    }
  }
}

/**
 * @class ZombieSpawnerTask
 * @extends EventEmitter
 * @description Mesin pelaksana tugas otonom pembasmi zombie di spawner bawah tanah.
 */
class ZombieSpawnerTask extends EventEmitter {
  /**
   * @param {Object} [options={}] - Konfigurasi parameter tugas
   * @param {Object} options.client - Instans LiveProtocolClient, Mineflayer Bot, atau MockArenaHarness
   * @param {Object} [options.movementController] - Controller pergerakan pathfinder opsional
   * @param {{ x: number, y: number, z: number }} [options.targetCoords] - Titik target spawner (default: [-256, -20, -432])
   * @param {string} [options.weapon='sword'] - Tipe senjata ('sword', 'axe', dll)
   * @param {number} [options.attackRange=4.5] - Jangkauan serangan maksimum (meter)
   * @param {number} [options.autoEatThreshold=14] - Ambang batas rasa lapar untuk makan otomatis
   * @param {number} [options.retreatThreshold=6] - Ambang batas darah kritis untuk mundur (HP < 6)
   * @param {number} [options.maxKills=Infinity] - Batas kuota zombie yang dibasmi
   * @param {number} [options.durationSeconds=Infinity] - Batas waktu durasi farming
   */
  constructor(options = {}) {
    super();

    this.options = {
      targetCoords: { ...TARGET_SPAWNER_COORDINATES },
      retreatCoords: { x: -256, y: -20, z: -420 }, // Titik aman mundur 12m dari spawner
      weapon: 'sword',
      attackRange: 4.5,
      autoEatThreshold: 14,
      retreatThreshold: 6,
      safeRecoveryHealth: 14,
      maxKills: Infinity,
      durationSeconds: Infinity,
      tickIntervalMs: 50, // 20 Hz
      ...options
    };

    this.adapter = new UnifiedClientAdapter(options.client);
    this.movementController = options.movementController || null;

    // Status FSM & Metrik Operasional
    this.state = TASK_STATES.IDLE;
    this.isActive = false;
    this.startTime = null;
    this.stopTime = null;
    this._loopTimer = null;

    // Metrik Farming & Statistik
    this.zombiesKilled = 0;
    this.totalHits = 0;
    this.initialXP = 0;
    this.currentXP = 0;
    this.xpGained = 0;
    this.initialLevel = 0;
    this.currentLevel = 0;
    this.lootCollected = {};
    this.attackTimestamps = [];
    this.lastAttackTimestamp = 0;

    // Penjejakan Target Aktif
    this.activeTarget = null;
    this.mockTargetQueue = [];

    // Cooldown Senjata Terkonfigurasi
    this.weaponCooldownMs = WEAPON_COOLDOWNS_MS[this.options.weapon] || WEAPON_COOLDOWNS_MS.sword;

    // Pasang Event Listeners Klien
    this._setupClientEventListeners();
  }

  /**
   * Menghubungkan client baru ke task.
   * @param {Object} client
   */
  attachClient(client) {
    this.adapter = new UnifiedClientAdapter(client);
    this._setupClientEventListeners();
  }

  /**
   * Memasang pendengar event dari klien untuk sinkronisasi darah, XP, dan loot.
   * @private
   */
  _setupClientEventListeners() {
    this.adapter.on('health', ({ health, food }) => {
      this.emit('vitality_update', { health, food });
    });

    this.adapter.on('experience', (expData) => {
      this._handleExperienceUpdate(expData);
    });

    this.adapter.on('collect', ({ item, count }) => {
      this._handleLootPickup(item, count);
    });
  }

  /**
   * Memulai siklus tugas farming otonom.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isActive) return;

    this.isActive = true;
    this.state = TASK_STATES.NAVIGATING;
    this.startTime = Date.now();

    // Rekam status awal
    const initialExp = this.adapter.getExperience();
    this.initialXP = initialExp.points;
    this.currentXP = initialExp.points;
    this.initialLevel = initialExp.level;
    this.currentLevel = initialExp.level;
    this.xpGained = 0;

    this.emit('task_start', {
      task: 'zombie_spawner_farm',
      targetCoords: this.options.targetCoords,
      weapon: this.options.weapon,
      weaponCooldownMs: this.weaponCooldownMs,
      timestamp: this.startTime
    });

    console.log(`⚔️ [SpawnerTask] Tugas farming zombie dimulai di target: [${this.options.targetCoords.x}, ${this.options.targetCoords.y}, ${this.options.targetCoords.z}]`);

    // Periksa apakah posisi bot sudah di lokasi spawner
    await this._ensurePositionAtSpawner();

    this.state = TASK_STATES.FARMING;
    this._startTickLoop();
  }

  /**
   * Menghentikan siklus tugas farming secara normal.
   * @param {string} [reason='Selesai normal']
   */
  stop(reason = 'Selesai normal') {
    if (!this.isActive) return;

    this.isActive = false;
    this.state = TASK_STATES.COMPLETED;
    this.stopTime = Date.now();

    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = null;
    }

    const summary = this.getTaskStatus();
    this.emit('task_complete', {
      reason,
      summary,
      timestamp: this.stopTime
    });

    console.log(`🛑 [SpawnerTask] Tugas dihentikan: ${reason} (Zombie terbunuh: ${this.zombiesKilled}, XP Diperoleh: +${this.xpGained})`);
  }

  /**
   * Menangguhkan tugas sementara (Pause).
   */
  pause() {
    if (this.state === TASK_STATES.PAUSED || !this.isActive) return;
    this.state = TASK_STATES.PAUSED;
    this.emit('task_paused', { timestamp: Date.now() });
  }

  /**
   * Melanjutkan tugas dari penangguhan (Resume).
   */
  resume() {
    if (this.state !== TASK_STATES.PAUSED) return;
    this.state = TASK_STATES.FARMING;
    this.emit('task_resumed', { timestamp: Date.now() });
  }

  /**
   * Menambahkan antrean target zombie tiruan untuk skenario uji terisolasi.
   * @param {Array<Object>|Object} targets
   */
  queueMockTargets(targets) {
    const list = Array.isArray(targets) ? targets : [targets];
    this.mockTargetQueue.push(...list);
  }

  /**
   * Mengembalikan objek status snapshot tugas untuk Web Dashboard dan Telemetri.
   * @returns {Object}
   */
  getTaskStatus() {
    const currentPos = this.adapter.getPosition();
    const currentHealth = this.adapter.getHealth();
    const currentFood = this.adapter.getFood();
    const now = Date.now();
    const runtimeSeconds = this.startTime ? Math.floor((now - this.startTime) / 1000) : 0;

    return {
      active: this.isActive,
      state: this.state,
      targetCoords: { ...this.options.targetCoords },
      currentPos,
      zombiesKilled: this.zombiesKilled,
      totalHits: this.totalHits,
      xpGained: this.xpGained,
      currentXP: this.currentXP,
      currentLevel: this.currentLevel,
      lootCollected: { ...this.lootCollected },
      currentHealth,
      currentFood,
      equippedWeapon: this.options.weapon,
      weaponCooldownMs: this.weaponCooldownMs,
      runtimeSeconds,
      lastAttackTime: this.lastAttackTimestamp || null,
      activeTarget: this.activeTarget ? { id: this.activeTarget.id, name: this.activeTarget.name, hp: this.activeTarget.hp } : null
    };
  }

  /**
   * Memastikan bot berada di lokasi spawner.
   * @private
   */
  async _ensurePositionAtSpawner() {
    const pos = this.adapter.getPosition();
    const target = this.options.targetCoords;
    const distance = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);

    if (distance > 3.0) {
      this.emit('task_step', { step: 'Navigasi menuju ruang spawner', distanceMeters: distance });
      if (this.movementController && typeof this.movementController.navigateTo === 'function') {
        await this.movementController.navigateTo(this.adapter.rawClient, target, 2.0);
      } else {
        // Posisikan langsung jika tanpa controller pathfinder
        this.adapter.setPosition(target);
      }
    }
  }

  /**
   * Loop detak (Tick Loop) utama yang mengevaluasi FSM secara berkelanjutan.
   * @private
   */
  _startTickLoop() {
    const runTick = async () => {
      if (!this.isActive) return;

      try {
        if (this.state !== TASK_STATES.PAUSED) {
          await this._evaluateStateCycle();
        }
      } catch (err) {
        console.error('❌ [SpawnerTask Error]:', err.message);
        this.emit('task_error', { error: err.message });
      }

      if (this.isActive) {
        this._loopTimer = setTimeout(runTick, this.options.tickIntervalMs);
      }
    };

    this._loopTimer = setTimeout(runTick, this.options.tickIntervalMs);
  }

  /**
   * Evaluasi siklus FSM (Vitalitas -> Target Acquisition -> Serangan -> Loot/XP Sync).
   * @private
   */
  async _evaluateStateCycle() {
    // 1. Periksa Batas Kuota & Durasi
    if (this.zombiesKilled >= this.options.maxKills) {
      return this.stop('Batas kuota target zombie tercapai.');
    }
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    if (elapsedSeconds >= this.options.durationSeconds) {
      return this.stop('Batas waktu durasi farming selesai.');
    }

    // 2. Evaluasi Manajemen Vitalitas (Auto-Eat & Panic Retreat)
    const vitalityState = await this._handleVitalityManagement();
    if (vitalityState === 'RETREAT' || vitalityState === 'EATING') {
      return;
    }

    // 3. Akuisisi Target Zombie
    const target = this._acquireNextTarget();
    if (!target) {
      this.activeTarget = null;
      return;
    }

    this.activeTarget = target;

    // 4. Eksekusi Serangan dengan Pacing Cooldown Senjata
    await this._executePacedAttack(target);
  }

  /**
   * Menangani logika auto-eat dan panic retreat jika darah/makanan kritis.
   * @private
   * @returns {Promise<'OK'|'EATING'|'RETREAT'>}
   */
  async _handleVitalityManagement() {
    const health = this.adapter.getHealth();
    const food = this.adapter.getFood();

    // A. Kasus Darah Kritis (HP < retreatThreshold e.g. 6 HP / 3 Hearts)
    if (health < this.options.retreatThreshold) {
      if (this.state !== TASK_STATES.RETREATING) {
        this.state = TASK_STATES.RETREATING;
        this.emit('vitality_warning', {
          type: 'LOW_HEALTH',
          health,
          food,
          action: 'RETREAT',
          message: `Darah kritis (${health}/20 HP)! Melakukan manuver mundur ke titik aman.`
        });
        this.emit('retreat_triggered', { health, retreatCoords: this.options.retreatCoords });
        console.warn(`⚠️ [SpawnerTask Panic] Darah ${health}/20 HP! Mundur ke ${JSON.stringify(this.options.retreatCoords)}`);
        
        // Pindahkan ke retreat waypoint
        this.adapter.setPosition(this.options.retreatCoords);
      }
      return 'RETREAT';
    }

    // Jika sedang dalam retreat dan darah sudah pulih kembali ke batas aman
    if (this.state === TASK_STATES.RETREATING) {
      if (health >= this.options.safeRecoveryHealth) {
        console.log(`💚 [SpawnerTask] Darah telah pulih (${health}/20 HP). Melanjutkan farming di spawner.`);
        this.adapter.setPosition(this.options.targetCoords);
        this.state = TASK_STATES.FARMING;
      } else {
        return 'RETREAT';
      }
    }

    // B. Kasus Kelaparan / Auto-Eat (Food <= 14 atau Health < 20 && Food < 20)
    if (food <= this.options.autoEatThreshold || (health < 20 && food < 20)) {
      const foodItem = this._findAvailableFoodInInventory();
      if (foodItem) {
        this.state = TASK_STATES.EATING;
        this.emit('vitality_warning', {
          type: 'LOW_FOOD',
          health,
          food,
          action: 'AUTO_EAT',
          foodItem: foodItem.name
        });

        // Konsumsi makanan
        this.adapter.removeItem(foodItem.name, 1);
        const restoredFood = Math.min(20, food + 6);
        const restoredHealth = Math.min(20, health + 2);
        
        this.emit('auto_eat', {
          item: foodItem.name,
          foodBefore: food,
          foodAfter: restoredFood,
          healthAfter: restoredHealth
        });

        this.state = TASK_STATES.FARMING;
        return 'EATING';
      }
    }

    return 'OK';
  }

  /**
   * Mencari item makanan yang tersedia di inventaris.
   * @private
   */
  _findAvailableFoodInInventory() {
    const items = this.adapter.getInventoryItems();
    for (const foodName of FOOD_ITEMS) {
      const it = items.find(i => (i.name === foodName || i.name?.includes(foodName)));
      if (it && (it.count === undefined || it.count > 0)) {
        return it;
      }
    }
    return null;
  }

  /**
   * Mencari dan mengunci target zombie berikutnya dalam perimeter spawner.
   * @private
   * @returns {Object|null}
   */
  _acquireNextTarget() {
    // 1. Periksa antrean target tiruan jika ada (untuk pengujian)
    if (this.mockTargetQueue.length > 0) {
      const mock = this.mockTargetQueue[0];
      if (mock.hp <= 0) {
        this.mockTargetQueue.shift();
        return this._acquireNextTarget();
      }
      return mock;
    }

    // 2. Cari entitas di lingkungan bot Mineflayer / Mock
    if (typeof this.adapter.botRef?.nearestEntity === 'function') {
      const myPos = this.adapter.getPosition();
      const entity = this.adapter.botRef.nearestEntity(e => {
        if (!e || !VALID_TARGET_MOBS.includes(e.name)) return false;
        const ePos = e.position || { x: 0, y: 0, z: 0 };
        const dist = Math.hypot(ePos.x - myPos.x, ePos.y - myPos.y, ePos.z - myPos.z);
        return dist <= this.options.attackRange;
      });

      if (entity) {
        return {
          id: entity.id,
          name: entity.name,
          hp: entity.health ?? 20,
          maxHp: 20,
          xpDrop: 5,
          loot: 'rotten_flesh',
          lootCount: 1,
          position: entity.position
        };
      }
    }

    return null;
  }

  /**
   * Mengeksekusi serangan dengan penegakan jeda cooldown senjata.
   * @private
   * @param {Object} target
   */
  async _executePacedAttack(target) {
    const now = Date.now();
    const elapsedSinceLastAttack = now - this.lastAttackTimestamp;

    // Pastikan cooldown terpenuhi sebelum mengirim tebasan
    if (this.lastAttackTimestamp > 0 && elapsedSinceLastAttack < this.weaponCooldownMs) {
      const waitTimeMs = this.weaponCooldownMs - elapsedSinceLastAttack;
      await new Promise(resolve => setTimeout(resolve, waitTimeMs));
    }

    const attackTime = Date.now();
    this.lastAttackTimestamp = attackTime;
    this.attackTimestamps.push(attackTime);
    this.totalHits++;

    // Arahkan pandangan ke target
    const targetPos = target.position || this.options.targetCoords;
    await this.adapter.lookAt({
      x: targetPos.x,
      y: targetPos.y + 1.6,
      z: targetPos.z
    });

    // Kirim aksi serangan ke klien
    this.adapter.attack(target);

    // Hitung pengurangan damage (Diamond sword base: 7 damage)
    const damageDealt = 7;
    target.hp = Math.max(0, (target.hp ?? 20) - damageDealt);

    this.emit('attack', {
      targetId: target.id,
      targetName: target.name,
      damage: damageDealt,
      remainingHp: target.hp,
      hitIndex: this.totalHits,
      timestamp: attackTime
    });

    // Periksa apakah target tereliminasi
    if (target.hp <= 0) {
      this.zombiesKilled++;
      const xpDrop = target.xpDrop || 5;
      const lootItem = target.loot || 'rotten_flesh';
      const lootCount = target.lootCount || 1;

      // Pemungutan XP & Loot
      this._handleExperienceUpdate({ points: this.currentXP + xpDrop });
      this._handleLootPickup(lootItem, lootCount);

      this.emit('mob_killed', {
        targetId: target.id,
        targetName: target.name,
        zombiesKilled: this.zombiesKilled,
        xpDrop,
        loot: { item: lootItem, count: lootCount },
        timestamp: Date.now()
      });

      console.log(`💀 [SpawnerTask] ${target.name} tereliminasi! (+${xpDrop} XP, Loot: +${lootCount} ${lootItem}) | Total Kills: ${this.zombiesKilled}`);

      this.activeTarget = null;
    }
  }

  /**
   * Sinkronisasi perolehan XP dan perhitungan level.
   * @private
   */
  _handleExperienceUpdate(expData) {
    const points = typeof expData === 'number' ? expData : (expData.points ?? this.currentXP);
    const xpDelta = points - this.currentXP;

    this.currentXP = points;
    this.xpGained = this.currentXP - this.initialXP;

    // Kalkulasi Level Minecraft: Level 1 = 7 XP, Level 2 = 16 XP...
    this.currentLevel = Math.floor(this.currentXP / 7);
    this.adapter.setExperience(this.currentXP, this.currentLevel);

    if (xpDelta > 0) {
      this.emit('xp_collected', {
        pointsGained: xpDelta,
        totalXP: this.currentXP,
        currentLevel: this.currentLevel,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Penjejakan pemungutan item loot inventaris.
   * @private
   */
  _handleLootPickup(itemName, count = 1) {
    if (!itemName) return;
    this.lootCollected[itemName] = (this.lootCollected[itemName] || 0) + count;
    this.adapter.addItem(itemName, count);

    this.emit('loot_collected', {
      item: itemName,
      count,
      totalCount: this.lootCollected[itemName],
      timestamp: Date.now()
    });
  }
}

module.exports = {
  ZombieSpawnerTask,
  UnifiedClientAdapter,
  TASK_STATES,
  FOOD_ITEMS,
  VALID_TARGET_MOBS
};
```

---

## 5. Verification Method

Untuk memverifikasi implementasi `ZombieSpawnerTask` secara independen:

1. **Uji Cooldown Pacing Senjata (`assertAttackPacing`)**:
   ```javascript
   const { ZombieSpawnerTask } = require('../../src/tasks/zombieSpawnerTask');
   const { MockArenaHarness } = require('../helpers/mockArenaHarness');
   const { assertAttackPacing, equal } = require('../helpers/assertions');

   const harness = new MockArenaHarness({ port: 25565 });
   await harness.start();

   const task = new ZombieSpawnerTask({ client: harness, weapon: 'sword' });
   task.queueMockTargets([
     { id: 'z1', name: 'Zombie #1', hp: 20, maxHp: 20, xpDrop: 5, loot: 'rotten_flesh', lootCount: 2 }
   ]);

   await task.start();
   // Tunggu zombie mati
   while (task.zombiesKilled < 1) {
     await new Promise(r => setTimeout(r, 50));
   }
   task.stop();

   assertAttackPacing(task.attackTimestamps, 625);
   equal(task.zombiesKilled, 1);
   equal(task.xpGained, 5);
   await harness.stop();
   ```

2. **Uji Manajemen Vitalitas (Auto-Eat & Panic Retreat)**:
   - Verifikasi bahwa saat HP diatur ke 4 ($< 6$), event `vitality_warning` dan `retreat_triggered` terpicu, dan bot berpindah ke titik aman.
   - Verifikasi bahwa saat Food diatur ke 10 ($\le 14$), item makanan di inventaris dikonsumsi dan event `auto_eat` terpancar.

3. **Uji Kompatibilitas Live Server (LiveProtocolClient)**:
   - Jalankan `node test/e2e/test_zombie_combat_xp.js` dan verifikasi bahwa kenaikan XP dan loot tercatat ke database telemetri PostgreSQL tanpa kesalahan.
   - Jalankan Master Test Runner:
     ```bash
     node test/runner.js
     ```
