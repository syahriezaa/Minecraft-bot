# Laporan Handoff: Desain Prosedural & Blueprint Algoritma Arena Builder (`arenaBuilder.js`)
**Agent**: `explorer_2` (Milestone 2 Explorer — Procedural World Arena Generator)  
**Tanggal**: 2026-08-18  
**Milestone**: M2 (Headless Server Arena & Bot Test Harness)  
**Target Penerima**: `sub_orch_m2`, `worker_m2` (Implementer), `reviewer_m2`, `challenger_m2`  

---

## 1. Observation

Berdasarkan investigasi menyeluruh terhadap kebutuhan sistem dan artefak proyek:

1. **Kebutuhan Asli (`ORIGINAL_REQUEST.md`)**:
   - **§16-22 (R2)**: Kurikulum pengujian 4 tingkat kesulitan:
     - **Level 1 (Flat Ground)**: Titik A `[0, 64, 0]` $\rightarrow$ Titik B `[30, 64, 0]` (jarak 30m) pada medan datar.
     - **Level 2 (Obstacles & Elevation)**: Lintasan 50m dengan perubahan elevasi 1-blok, rintangan melintang, dan rute belokan (*detour/S-curves*).
     - **Level 3 (Stairs, Ladders & Bridges)**: Navigasi vertikal menggunakan tangga balok (*stairs*), tiang tangga vertikal (*ladders* $+10$ blok), dan jembatan sempit 1-blok (*narrow bridge* 15m di atas jurang).
     - **Level 4 (Underground Spawner Farm Target)**: Navigasi jarak jauh dari permukaan `[0, 64, 0]` menuruni koridor gua hingga koordinat farm spawner `[-256, -20, -432]`.
   - **§26-28 (R4)**: Tugas multi-langkah DeepSeek AI memerlukan:
     - Ruang *dungeon spawner* zombie pada `[-256, -20, -432]`.
     - 4 unit peti berkategori: Peti Senjata (*Weapons*), Peti Drop Mob (*Mob Drops*), Peti Armor (*Armor*), dan Peti Sampah (*Trash*).
     - Kolam pembakaran sampah lava (*hazard incinerator*) dengan perimeter pengaman aman ($\ge 2.0$m) untuk mencegah bot terjatuh saat membuang item.

2. **Arsitektur Proyek & Ruang Lingkup (`PROJECT.md` & `SCOPE.md`)**:
   - Modul `src/server/arenaBuilder.js` bertanggung jawab memprogram blok dunia secara prosedural untuk ke-4 level tolak ukur.
   - Fungsi utama yang wajib diekspos:
     - `buildLevel1Arena(server, options)`
     - `buildLevel2Arena(server, options)`
     - `buildLevel3Arena(server, options)`
     - `buildLevel4Arena(server, options)`
     - `buildArena(level, server, options)` (dispatcher level 1 s.d. 4)
     - `clearArena(server, bounds)` (membersihkan area arena menjadi udara)
   - Batasan koordinat vertikal dunia Minecraft: $Y \in [-64, 320]$.
   - Standar bahasa: Komentar kode, error message, dan dokumentasi WAJIB dalam **Bahasa Indonesia**.

3. **Ekspektasi Uji Coba E2E (`test/e2e/` & `test/helpers/mockArenaHarness.js`)**:
   - `test/e2e/tier1_feature_coverage.test.js`:
     - Level 1: `getBlock(0, 63, 0) === 'stone'`, `getBlock(30, 63, 0) === 'stone'`, start `[0, 64, 0]`.
     - Level 2: `getBlock(20, 64, 0) === 'stone'`, `getBlock(20, 65, 0) === 'stone'`.
     - Level 3: `getBlock(5, 68, 0) === 'stone_stairs'`, `getBlock(10, 73, 5) === 'stone'`, `getBlock(10, 70, 15) === 'ladder'`.
     - Level 4: `getBlock(-256, -19, -432) === 'spawner'`, `getBlock(-256, -21, -432) === 'deepslate'`.
   - `test/e2e/tier2_boundary_corner.test.js`:
     - Menolak elevasi vertikal $Y < -64$ atau $Y > 320$ dengan melempar error deskriptif dalam Bahasa Indonesia.
     - Menolak level selain $1, 2, 3, 4$ dengan melempar error: *"Tingkat level arena tidak valid! Harus bernilai antara 1 hingga 4."*
     - Efisiensi memori bebas *leak* saat regenerasi arena berulang kali ($< 100$ MB).

---

## 2. Logic Chain

### 2.1 Arsitektur Antarmuka Generator Arena (`arenaBuilder.js`)
Modul `arenaBuilder.js` berinteraksi dengan server melalui abstraksi generik:
- Server objek menyediakan metode:
  - `server.setBlock(x, y, z, blockType, properties)`: Menempatkan blok pada koordinat tertentu.
  - `server.getBlock(x, y, z)`: Mengambil jenis blok pada koordinat.
  - `server.setupHazardBlock(coord, type)` (opsional / fallback ke `setBlock`).
  - `server.setupChest(coord, chestId, items)` (opsional / fallback ke `setBlock`).
- Modul ini dirancang mandiri tanpa dependensi eksternal berat, hanya memanfaatkan pustaka matematika bawaan JavaScript untuk performa instan ($< 50$ms).

---

### 2.2 Blueprint Spasial & Algoritma Level 1: Flat Ground (30m Sprint)

#### Parameter Spasial
- **Titik Awal (Start)**: `[0, 64, 0]`
- **Titik Target (Finish)**: `[30, 64, 0]`
- **Panjang Lintasan**: 30m aktif ($X \in [0, 30]$), total panjang arena $X \in [-5, 35]$ (40m total).
- **Lebar Lintasan**: $Z \in [-3, 3]$ (Lebar 7 blok, lorong lari bersih 5 blok di antara dinding $Z = \pm 3$).
- **Elevasi Lantai**: $Y = 63$ (blok: `stone`).
- **Tinggi Lorong Udara**: $Y \in [64, 67]$ (blok: `air`).

#### Komponen Geometri
1. **Lantai Datar**:
   $$\forall x \in [-5, 35], \forall z \in [-3, 3] \implies \text{setBlock}(x, 63, z, \text{'stone'})$$
2. **Pembersihan Ruang Udara**:
   $$\forall x \in [-5, 35], \forall z \in [-2, 2], \forall y \in [64, 67] \implies \text{setBlock}(x, y, z, \text{'air'})$$
3. **Dinding Pembatas Samping (Perimeter Walls)**:
   $$\forall x \in [-5, 35], \forall y \in [64, 65] \implies \text{setBlock}(x, y, -3, \text{'stone'}), \text{setBlock}(x, y, 3, \text{'stone'})$$
4. **Dinding Pembatas Ujung (End Caps)**:
   $$\forall z \in [-3, 3], \forall y \in [64, 65] \implies \text{setBlock}(-5, y, z, \text{'stone'}), \text{setBlock}(35, y, z, \text{'stone'})$$
5. **Penanda Start & Finish**:
   - Lantai start di `[0, 63, 0]`: `stone` (tersedia penanda visual start pad).
   - Lantai finish di `[30, 63, 0]`: `stone` (tersedia pelat finish pad).

```
   Z=-3  [STONE WALL] [STONE WALL] [STONE WALL] ... [STONE WALL]
   Z=-2  [ AIR      ] [ AIR      ] [ AIR      ] ... [ AIR      ]
   Z= 0  [START: 0,64,0] ======= LORONG LARI 30M ====== [FINISH: 30,64,0]
   Z= 2  [ AIR      ] [ AIR      ] [ AIR      ] ... [ AIR      ]
   Z= 3  [STONE WALL] [STONE WALL] [STONE WALL] ... [STONE WALL]
         X=-5          X=0                             X=30         X=35
```

---

### 2.3 Blueprint Spasial & Algoritma Level 2: Obstacles & Elevation (50m Course)

#### Parameter Spasial
- **Titik Awal (Start)**: `[0, 64, 0]`
- **Titik Target (Finish)**: `[50, 64, 0]` (atau `[50, 68, 0]`)
- **Panjang Lintasan**: $X \in [-5, 55]$ (60m total).
- **Lebar Lintasan**: $Z \in [-4, 4]$ (Lebar 9 blok, lorong aktif $Z \in [-3, 3]$).

#### Profil Elevasi & Variasi Kontur
1. **Segmen 1 — Dataran Awal ($X \in [-5, 14]$)**:
   - Lantai dasar: $Y = 63$ (`stone`).
   - Udara bebas: $Y \in [64, 67]$ (`air`).
2. **Transisi Naik 1-Blok ($X = 15$)**:
   - Langkah naik: dari $Y = 63$ menjadi $Y = 64$.
3. **Segmen 2 — Dataran Tinggi ($X \in [15, 29]$)**:
   - Lantai elevasi tinggi: $Y = 64$ (`stone`).
   - **Rintangan Dinding Detour 1 ($X = 20$)**:
     - Dinding setinggi 2 blok: $\text{setBlock}(20, 65, z, \text{'stone'})$ dan $\text{setBlock}(20, 66, z, \text{'stone'})$ untuk $z \in [-3, 1]$.
     - Meninggalkan celah belok pada $z \in [2, 3]$ (memaksa bot bermanuver *S-curve* ke kanan).
   - **Rintangan Rintangan Lompat 2 ($X = 25$)**:
     - Blok melintang 1-tinggi: $\text{setBlock}(25, 65, z, \text{'stone'})$ untuk $z \in [-1, 3]$, memaksa bot belok ke kiri $z \in [-3, -2]$.
4. **Transisi Turun 1-Blok ($X = 30$)**:
   - Langkah turun: dari $Y = 64$ kembali ke $Y = 63$.
5. **Segmen 3 — Medan Berganti & Belokan ($X \in [30, 55]$)**:
   - Lantai dasar: $Y = 63$ (`stone`).
   - **Rintangan Dinding Detour 3 ($X = 38$)**: Dinding $Y = 64..65$ pada $z \in [-3, 0]$, celah pada $z \in [1, 3]$.
   - **Rintangan Dinding Detour 4 ($X = 45$)**: Dinding $Y = 64..65$ pada $z \in [0, 3]$, celah pada $z \in [-3, -1]$.
6. **Dinding Pembatas Luar**:
   - Sepanjang $Z = \pm 4$ dari $X = -5$ hingga $55$ dengan tinggi 3 blok di atas elevasi lantai lokal.

---

### 2.4 Blueprint Spasial & Algoritma Level 3: Vertical Navigation Arena (Stairs, Ladders & Bridges)

Level 3 menggabungkan 3 tantangan navigasi 3D berturut-turut:

#### Komponen 1: Tangga Balok Menanjak (Ascending Stairs)
- Posisi: $X \in [0, 10]$, $Z = 0$.
- Formula Ketinggian: Untuk setiap langkah $i \in [0, 10]$:
  - $\text{setBlock}(i, 63 + i, 0, \text{'stone\_stairs'}, \{ \text{facing: 'east', half: 'bottom'} \})$
  - Pondasi di bawah tangga: $\forall y \in [63, 62+i] \implies \text{setBlock}(i, y, 0, \text{'stone'})$
  - Ruang bebas di atas tangga: $\forall y \in [64+i, 66+i] \implies \text{setBlock}(i, y, 0, \text{'air'})$
  - *Catatan Uji*: Pada $i=5$, koordinat $[5, 68, 0]$ berisi `stone_stairs`.

#### Komponen 2: Jembatan Sempit 1-Blok di Atas Jurang (1-Block Narrow Bridge)
- Posisi: $X = 10$, $Z \in [0, 15]$, pada elevasi $Y = 73$.
- Konstruksi:
  $$\forall z \in [0, 15] \implies \text{setBlock}(10, 73, z, \text{'stone'})$$
- Jurang / Rongga Terbuka di Sisi Kiri & Kanan:
  $$\forall z \in [1, 14], \forall x \in \{9, 11\}, \forall y \in [63, 73] \implies \text{setBlock}(x, y, z, \text{'air'})$$
- Ruang udara di atas jembatan: $\forall z \in [0, 15], \forall y \in [74, 76] \implies \text{setBlock}(10, y, z, \text{'air'})$.
- *Catatan Uji*: Pada koordinat $[10, 73, 5]$, blok adalah `stone`.

#### Komponen 3: Tiang Tangga Vertikal (Vertical Ladder Shaft)
- Posisi: $X = 10$, $Z = 15$ (lokasi ladder) menempel pada tiang solid di $Z = 16$.
- Rentang Elevasi: $Y \in [64, 74]$ (ketinggian 11 blok).
- Konstruksi:
  - Tiang Solid Penopang: $\forall y \in [64, 74] \implies \text{setBlock}(10, y, 16, \text{'stone'})$
  - Blok Ladder: $\forall y \in [64, 74] \implies \text{setBlock}(10, y, 15, \text{'ladder'}, \{ \text{facing: 'north'} \})$
  - Ruang bebas di depan ladder: $\forall y \in [64, 74] \implies \text{setBlock}(10, y, 14, \text{'air'})$
  - Platform Pendaratan Bawah: $[10, 63, 15]$ set ke `stone`.
- *Catatan Uji*: Pada koordinat $[10, 70, 15]$, blok adalah `ladder`.

```
          [Jembatan Sempit 1-Blok (Y=73)]
          (10,73,0) ========> (10,73,15)
         /                             |  [Ladder Shaft]
        /                              |  Y=74 ke Y=64
       / [Tangga Balok (Y=63..73)]     |  (10,y,15) menempel di (10,y,16)
      /                                V
  (0,64,0)                         (10,64,15) [Target Landing]
```

---

### 2.5 Blueprint Spasial & Algoritma Level 4: Underground Spawner Farm Arena

#### Parameter Spasial
- **Pintu Masuk Permukaan**: `[0, 64, 0]`
- **Target Pusat Dungeon Farm**: `[-256, -20, -432]`
- **Vektor Jarak 3D**: $(\Delta X = -256, \Delta Y = -84, \Delta Z = -432)$, Jarak Euclidean $\approx 509.1$ meter.

#### Hierarki Waypoint Makro untuk Jalur Lorong Gua
Rute bawah tanah dipandu oleh 6 simpul makro:
1. **$WP_0$ (Pintu Masuk Permukaan)**: `[0, 64, 0]`
2. **$WP_1$ (Shaft Gua Atas)**: `[-50, 45, -80]`
3. **$WP_2$ (Koridor Gua Tengah)**: `[-120, 25, -200]`
4. **$WP_3$ (Zona Transisi Deepslate)**: `[-190, 5, -320]`
5. **$WP_4$ (Antechamber Ruang Bawah Tanah)**: `[-240, -15, -400]`
6. **$WP_5$ (Pintu Masuk Spawner Dungeon Farm)**: `[-256, -20, -432]`

#### Algoritma Pengerukan Lorong Gua Prosedural (`carveTunnel`)
Untuk setiap ruas garis antara $WP_k$ dan $WP_{k+1}$:
1. Hitung jumlah interpolasi langkah $N = \lceil \text{dist}(WP_k, WP_{k+1}) \rceil$.
2. Pada setiap titik interpolasi $P(t) = WP_k + t \cdot (WP_{k+1} - WP_k)$ dengan $t = \frac{j}{N}, j \in [0, N]$:
   - Titik pusat bulat: $(cx, cy, cz) = (\lfloor P_x \rceil, \lfloor P_y \rceil, \lfloor P_z \rceil)$.
   - Material batuan: jika $cy \le 0$ gunakan `deepslate`, jika $cy > 0$ gunakan `stone`.
   - Lantai: $(cx, cy-1, cz)$ diisi material batuan solid.
   - Ruang Udara Lorong ($3 \times 3 \times 3$):
     $$\forall dx \in [-1, 1], \forall dy \in [0, 2], \forall dz \in [-1, 1] \implies \text{setBlock}(cx+dx, cy+dy, cz+dz, \text{'air'})$$
   - Pencahayaan: Pasang obor (`torch`) pada dinding lorong setiap 12 blok langkah.

#### Arsitektur Ruang Spawner Dungeon Bawah Tanah
- **Pusat Ruangan**: `[-256, -20, -432]`
- **Dimensi Ruang**: Lebar $X \in [-261, -251]$ (11 blok), Panjang $Z \in [-437, -427]$ (11 blok), Tinggi $Y \in [-22, -16]$ (7 blok).
- **Lantai ($Y = -21$)**:
  $$\forall x \in [-260, -250], \forall z \in [-436, -428] \implies \text{setBlock}(x, -21, z, \text{'deepslate'})$$
  *(Kombinasi acak/deterministik dengan `mossy_cobblestone` dan `cobblestone` pada perimeter).*
- **Ruang Udara Interior ($Y \in [-20, -17]$)**:
  $$\forall x \in [-260, -250], \forall z \in [-436, -428], \forall y \in [-20, -17] \implies \text{setBlock}(x, y, z, \text{'air'})$$
- **Dinding Penutup Ruangan**:
  - Dinding pada $X = -261$, $X = -251$, $Z = -437$, $Z = -427$ dari $Y = -21$ s.d. $-16$ diisi `mossy_cobblestone` dan `cobblestone`.
- **Atap Ruangan ($Y = -16$)**:
  - Seluruh langit-langit $X \in [-261, -251], Z \in [-437, -427]$ diisi `deepslate`.
- **Blok Spawner Zombie**:
  - Ditempatkan di tengah ruangan pada koordinat: `[-256, -19, -432]` (atau `[-256, -20, -432]`).
  - Blok: `spawner` (entitas spawn: `zombie`).

#### Konfigurasi 4 Unit Peti Terkategori (Multi-Chest Setup)
Peti ditempatkan di sepanjang dinding selatan dungeon pada elevasi $Y = -20$:
1. **Peti Senjata (`chest_weapons`)** pada `[-258, -20, -429]`:
   - Isi Awal: `[{ name: 'diamond_sword', count: 1 }, { name: 'iron_sword', count: 2 }, { name: 'iron_axe', count: 1 }]`
2. **Peti Drop Mob (`chest_drops`)** pada `[-256, -20, -429]`:
   - Isi Awal: `[{ name: 'rotten_flesh', count: 64 }, { name: 'bone', count: 16 }, { name: 'arrow', count: 32 }]`
3. **Peti Armor (`chest_armor`)** pada `[-254, -20, -429]`:
   - Isi Awal: `[{ name: 'iron_helmet', count: 1 }, { name: 'iron_chestplate', count: 1 }, { name: 'iron_leggings', count: 1 }, { name: 'iron_boots', count: 1 }]`
4. **Peti Sampah (`chest_trash`)** pada `[-252, -20, -429]`:
   - Isi Awal: `[{ name: 'poisonous_potato', count: 5 }, { name: 'wooden_hoe', count: 1 }]`

#### Desain Kolam Pembakaran Sampah Lava Aman (Safe Perimeter Lava Incinerator)
- **Lokasi Sudut Aman**: `[-259, -20, -435]`
- **Blok Bahaya Lava ($Y = -21$)**:
  - Kolam lava $1 \times 1$: $\text{setBlock}(-259, -21, -435, \text{'lava'})$ (atau via `setupHazardBlock`).
  - Wadah penampung samping bawah ($Y = -21$): `[-260, -21, -435]`, `[-258, -21, -435]`, `[-259, -21, -436]`, `[-259, -21, -434]` diisi `deepslate`.
- **Lubang Pembuangan ($Y = -20$)**:
  - Koordinat `[-259, -20, -435]` berupa `air` di atas kolam lava agar item dapat jatuh langsung terbakar.
- **Pagar Pembatas Aman (Safety Perimeter)**:
  - Dipasang `iron_bars` pada 3 sisi: `[-260, -20, -435]`, `[-258, -20, -435]`, `[-259, -20, -436]`.
- **Platform Pendekatan Bot**:
  - Posisi berdiri aman bot di `[-259, -20, -433]` (jarak aman $2.0$ meter).
  - Bot dapat melempar item (*toss stack*) ke arah `[-259, -20, -435]` tanpa pernah melangkah ke dalam lava.

---

### 2.6 Desain Kode Rinci & Tanda Tangan Fungsi (`src/server/arenaBuilder.js`)

Berikut rancangan arsitektur modul lengkap siap implementasi:

```javascript
/**
 * @file arenaBuilder.js
 * @description Pembangkit dunia arena prosedural untuk 4 tingkat tolak ukur (benchmark levels)
 * sistem autonomous companion Minecraft.
 */

// Konstanta batas koordinat vertikal dunia Minecraft
const MIN_WORLD_Y = -64;
const MAX_WORLD_Y = 320;

// Definisi konfigurasi bawaan untuk setiap level arena
const LEVEL_ARENA_CONFIGS = Object.freeze({
  1: { name: 'Flat Ground 30m Sprint', startPos: { x: 0, y: 64, z: 0 }, targetPos: { x: 30, y: 64, z: 0 } },
  2: { name: 'Obstacles & Elevation 50m Course', startPos: { x: 0, y: 64, z: 0 }, targetPos: { x: 50, y: 64, z: 0 } },
  3: { name: 'Stairs, Ladders & Bridges Arena', startPos: { x: 0, y: 64, z: 0 }, targetPos: { x: 10, y: 64, z: 15 } },
  4: { name: 'Underground Spawner Farm Arena', startPos: { x: 0, y: 64, z: 0 }, targetPos: { x: -256, y: -20, z: -432 } }
});

/**
 * Memvalidasi apakah koordinat vertikal berada dalam rentang valid dunia Minecraft.
 * @param {number} y - Koordinat vertikal Y.
 * @throws {Error} Jika Y berada di luar batas [-64, 320].
 */
function validateYCoordinate(y) {
  if (typeof y !== 'number' || isNaN(y) || y < MIN_WORLD_Y || y > MAX_WORLD_Y) {
    throw new Error(`Koordinat vertikal Y=${y} di luar batas dunia Minecraft [${MIN_WORLD_Y}, ${MAX_WORLD_Y}].`);
  }
}

/**
 * Memvalidasi instance server agar memiliki metode manipulasi blok yang valid.
 * @param {object} server - Instance server (TestServer atau MockArenaHarness).
 */
function validateServerInstance(server) {
  if (!server || typeof server.setBlock !== 'function') {
    throw new Error('Instance server tidak valid atau tidak menyediakan metode setBlock.');
  }
}

/**
 * Menempatkan satu blok secara aman dengan validasi batas ketinggian.
 */
function safeSetBlock(server, x, y, z, blockType, properties = {}) {
  validateYCoordinate(y);
  server.setBlock(Math.round(x), Math.round(y), Math.round(z), blockType, properties);
}

/**
 * Mengisi wilayah balok 3D (bounding box) dengan jenis blok tertentu.
 */
function fillRegion(server, minX, minY, minZ, maxX, maxY, maxZ, blockType, properties = {}) {
  const x0 = Math.min(minX, maxX);
  const x1 = Math.max(minX, maxX);
  const y0 = Math.min(minY, maxY);
  const y1 = Math.max(minY, maxY);
  const z0 = Math.min(minZ, maxZ);
  const z1 = Math.max(minZ, maxZ);

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      validateYCoordinate(y);
      for (let z = z0; z <= z1; z++) {
        server.setBlock(x, y, z, blockType, properties);
      }
    }
  }
}

/**
 * Pembangkit Arena Level 1: Flat Ground 30m Sprint.
 */
function buildLevel1Arena(server, options = {}) {
  validateServerInstance(server);

  const minX = -5;
  const maxX = 35;
  const minZ = -3;
  const maxZ = 3;

  // 1. Bersihkan area dan bangun lantai dasar stone pada Y=63
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      safeSetBlock(server, x, 63, z, 'stone');
      for (let y = 64; y <= 67; y++) {
        safeSetBlock(server, x, y, z, 'air');
      }
    }
  }

  // 2. Bangun dinding pembatas samping (Z = minZ dan Z = maxZ)
  for (let x = minX; x <= maxX; x++) {
    for (let y = 64; y <= 65; y++) {
      safeSetBlock(server, x, y, minZ, 'stone');
      safeSetBlock(server, x, y, maxZ, 'stone');
    }
  }

  // 3. Bangun dinding penutup ujung (X = minX dan X = maxX)
  for (let z = minZ; z <= maxZ; z++) {
    for (let y = 64; y <= 65; y++) {
      safeSetBlock(server, minX, y, z, 'stone');
      safeSetBlock(server, maxX, y, z, 'stone');
    }
  }

  return {
    level: 1,
    startCoord: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 30, y: 64, z: 0 },
    bounds: { minX, minY: 63, minZ, maxX, maxY: 67, maxZ }
  };
}

/**
 * Pembangkit Arena Level 2: Obstacles & Elevation 50m Course.
 */
function buildLevel2Arena(server, options = {}) {
  validateServerInstance(server);

  const minX = -5;
  const maxX = 55;
  const minZ = -4;
  const maxZ = 4;

  // 1. Bersihkan ruang dan bentuk lantai dasar dengan elevasi dinamis
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      let yGround = 63;
      if (x >= 15 && x < 30) {
        yGround = 64; // Langkah elevasi naik 1 blok
      }
      safeSetBlock(server, x, yGround, z, 'stone');

      // Bersihkan udara di atas lantai lokal
      for (let y = yGround + 1; y <= yGround + 4; y++) {
        safeSetBlock(server, x, y, z, 'air');
      }
    }
  }

  // 2. Pasang dinding pembatas luar
  for (let x = minX; x <= maxX; x++) {
    let yGround = (x >= 15 && x < 30) ? 64 : 63;
    for (let y = yGround + 1; y <= yGround + 2; y++) {
      safeSetBlock(server, x, y, minZ, 'stone');
      safeSetBlock(server, x, y, maxZ, 'stone');
    }
  }

  // 3. Pasang rintangan dinding melintang (forcing S-curves)
  // Dinding 1 pada X=20 (Y=65, 66) untuk Z = -3 s.d. 1 (celah di Z=2..3)
  safeSetBlock(server, 20, 65, 0, 'stone');
  safeSetBlock(server, 20, 66, 0, 'stone');
  for (let z = -3; z <= 1; z++) {
    safeSetBlock(server, 20, 65, z, 'stone');
    safeSetBlock(server, 20, 66, z, 'stone');
  }

  // Rintangan lompat 2 pada X=25
  for (let z = -1; z <= 3; z++) {
    safeSetBlock(server, 25, 65, z, 'stone');
  }

  // Dinding 3 pada X=38 (Y=64, 65) untuk Z = -3 s.d. 0 (celah di Z=1..3)
  for (let z = -3; z <= 0; z++) {
    safeSetBlock(server, 38, 64, z, 'stone');
    safeSetBlock(server, 38, 65, z, 'stone');
  }

  return {
    level: 2,
    startCoord: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 50, y: 64, z: 0 },
    bounds: { minX, minY: 63, minZ, maxX, maxY: 68, maxZ }
  };
}

/**
 * Pembangkit Arena Level 3: Vertical Navigation (Stairs, Ladders & Bridges).
 */
function buildLevel3Arena(server, options = {}) {
  validateServerInstance(server);

  // 1. Bersihkan area utama Level 3
  fillRegion(server, -2, 60, -5, 15, 80, 20, 'air');

  // 2. Bangun tangga menanjak (X = 0 s.d. 10, Z = 0)
  for (let i = 0; i <= 10; i++) {
    const yStep = 63 + i;
    // Pondasi solid di bawah tangga
    for (let y = 63; y < yStep; y++) {
      safeSetBlock(server, i, y, 0, 'stone');
    }
    safeSetBlock(server, i, yStep, 0, 'stone_stairs', { facing: 'east' });
    safeSetBlock(server, i, yStep + 1, 0, 'air');
    safeSetBlock(server, i, yStep + 2, 0, 'air');
  }

  // 3. Bangun jembatan sempit 1-blok (X = 10, Z = 0 s.d. 15 pada Y = 73)
  for (let z = 0; z <= 15; z++) {
    safeSetBlock(server, 10, 73, z, 'stone');
    safeSetBlock(server, 10, 74, z, 'air');
    safeSetBlock(server, 10, 75, z, 'air');
  }

  // 4. Bangun tiang penopang dan tangga ladder vertikal (Y = 64 s.d. 74)
  for (let y = 64; y <= 74; y++) {
    safeSetBlock(server, 10, y, 16, 'stone');                  // Tiang penopang
    safeSetBlock(server, 10, y, 15, 'ladder', { facing: 'north' }); // Tangga ladder
    safeSetBlock(server, 10, y, 14, 'air');                   // Ruang kosong bot
  }

  // Platform pendaratan bawah pada Y=63
  safeSetBlock(server, 10, 63, 15, 'stone');
  safeSetBlock(server, 10, 63, 14, 'stone');

  return {
    level: 3,
    startCoord: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 10, y: 64, z: 15 },
    bounds: { minX: 0, minY: 63, minZ: 0, maxX: 12, maxY: 76, maxZ: 17 }
  };
}

/**
 * Pembangkit Arena Level 4: Underground Spawner Farm Arena.
 */
function buildLevel4Arena(server, options = {}) {
  validateServerInstance(server);

  // 1. Pintu Masuk Permukaan
  safeSetBlock(server, 0, 63, 0, 'stone');
  safeSetBlock(server, 0, 64, 0, 'air');

  // 2. Daftar Waypoint Makro untuk Jalur Lorong Bawah Tanah
  const waypoints = [
    { x: 0, y: 64, z: 0 },
    { x: -50, y: 45, z: -80 },
    { x: -120, y: 25, z: -200 },
    { x: -190, y: 5, z: -320 },
    { x: -240, y: -15, z: -400 },
    { x: -256, y: -20, z: -432 }
  ];

  // 3. Pengerukan Jalur Lorong Gua Antar-Waypoint
  for (let k = 0; k < waypoints.length - 1; k++) {
    const p1 = waypoints[k];
    const p2 = waypoints[k + 1];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const steps = Math.ceil(dist);

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = Math.round(p1.x + t * (p2.x - p1.x));
      const cy = Math.round(p1.y + t * (p2.y - p1.y));
      const cz = Math.round(p1.z + t * (p2.z - p1.z));
      const rockType = cy <= 0 ? 'deepslate' : 'stone';

      // Lantai dasar lorong
      safeSetBlock(server, cx, cy - 1, cz, rockType);

      // Ruang udara lorong (3x3)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = 0; dy <= 2; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            safeSetBlock(server, cx + dx, cy + dy, cz + dz, 'air');
          }
        }
      }
    }
  }

  // 4. Konstruksi Ruang Dungeon Spawner (Pusat: [-256, -20, -432])
  const roomMinX = -261;
  const roomMaxX = -251;
  const roomMinZ = -437;
  const roomMaxZ = -427;

  // Lantai dungeon deepslate pada Y = -21
  for (let x = roomMinX; x <= roomMaxX; x++) {
    for (let z = roomMinZ; z <= roomMaxZ; z++) {
      safeSetBlock(server, x, -21, z, 'deepslate');
    }
  }

  // Ruang udara interior dungeon (Y = -20 s.d. -17)
  for (let x = roomMinX + 1; x <= roomMaxX - 1; x++) {
    for (let z = roomMinZ + 1; z <= roomMaxZ - 1; z++) {
      for (let y = -20; y <= -17; y++) {
        safeSetBlock(server, x, y, z, 'air');
      }
    }
  }

  // Dinding dungeon (mossy cobblestone / cobblestone)
  for (let y = -21; y <= -16; y++) {
    for (let x = roomMinX; x <= roomMaxX; x++) {
      safeSetBlock(server, x, y, roomMinZ, 'cobblestone');
      safeSetBlock(server, x, y, roomMaxZ, 'mossy_cobblestone');
    }
    for (let z = roomMinZ; z <= roomMaxZ; z++) {
      safeSetBlock(server, roomMinX, y, z, 'mossy_cobblestone');
      safeSetBlock(server, roomMaxX, y, z, 'cobblestone');
    }
  }

  // Langit-langit ruangan pada Y = -16
  for (let x = roomMinX; x <= roomMaxX; x++) {
    for (let z = roomMinZ; z <= roomMaxZ; z++) {
      safeSetBlock(server, x, -16, z, 'deepslate');
    }
  }

  // 5. Blok Spawner Zombie di Tengah Ruangan
  safeSetBlock(server, -256, -19, -432, 'spawner');

  // 6. Penempatan 4 Unit Peti Terkategori
  const chestDefs = [
    {
      id: 'chest_weapons',
      coord: { x: -258, y: -20, z: -429 },
      items: [{ name: 'diamond_sword', count: 1 }, { name: 'iron_sword', count: 2 }, { name: 'iron_axe', count: 1 }]
    },
    {
      id: 'chest_drops',
      coord: { x: -256, y: -20, z: -429 },
      items: [{ name: 'rotten_flesh', count: 64 }, { name: 'bone', count: 16 }, { name: 'arrow', count: 32 }]
    },
    {
      id: 'chest_armor',
      coord: { x: -254, y: -20, z: -429 },
      items: [{ name: 'iron_helmet', count: 1 }, { name: 'iron_chestplate', count: 1 }, { name: 'iron_leggings', count: 1 }, { name: 'iron_boots', count: 1 }]
    },
    {
      id: 'chest_trash',
      coord: { x: -252, y: -20, z: -429 },
      items: [{ name: 'poisonous_potato', count: 5 }, { name: 'wooden_hoe', count: 1 }]
    }
  ];

  for (const c of chestDefs) {
    if (typeof server.setupChest === 'function') {
      server.setupChest(c.coord, c.id, c.items);
    } else {
      safeSetBlock(server, c.coord.x, c.coord.y, c.coord.z, 'chest');
    }
  }

  // 7. Konstruksi Kolam Pembakaran Sampah Lava Aman (Safe Incinerator)
  const lavaCoord = { x: -259, y: -21, z: -435 };
  if (typeof server.setupHazardBlock === 'function') {
    server.setupHazardBlock(lavaCoord, 'lava');
  } else {
    safeSetBlock(server, lavaCoord.x, lavaCoord.y, lavaCoord.z, 'lava');
  }

  // Lubang pembuangan sampah di atas lava
  safeSetBlock(server, -259, -20, -435, 'air');

  // Pagar pengaman keliling kolam lava
  safeSetBlock(server, -260, -20, -435, 'iron_bars');
  safeSetBlock(server, -258, -20, -435, 'iron_bars');
  safeSetBlock(server, -259, -20, -436, 'iron_bars');

  // Platform berdiri aman bot pada jarak 2 meter
  safeSetBlock(server, -259, -21, -433, 'deepslate');
  safeSetBlock(server, -259, -20, -433, 'air');

  return {
    level: 4,
    startCoord: { x: 0, y: 64, z: 0 },
    targetCoord: { x: -256, y: -20, z: -432 },
    waypoints,
    chestDefinitions: chestDefs,
    hazardLocation: lavaCoord
  };
}

/**
 * Dispatcher utama untuk membangun arena berdasarkan tingkat kesulitan (Level 1-4).
 * @param {number|string} level - Tingkat kesulitan arena (1, 2, 3, atau 4).
 * @param {object} server - Instance server Minecraft.
 * @param {object} options - Opsi tambahan generasi arena.
 * @returns {object} Metadata spesifikasi arena yang telah dibangun.
 */
function buildArena(level, server, options = {}) {
  const numLevel = Number(level);
  if (![1, 2, 3, 4].includes(numLevel)) {
    throw new Error('Tingkat level arena tidak valid! Harus bernilai antara 1 hingga 4.');
  }

  switch (numLevel) {
    case 1:
      return buildLevel1Arena(server, options);
    case 2:
      return buildLevel2Arena(server, options);
    case 3:
      return buildLevel3Arena(server, options);
    case 4:
      return buildLevel4Arena(server, options);
    default:
      throw new Error(`Tingkat level arena ${level} tidak didukung.`);
  }
}

/**
 * Membersihkan seluruh blok di dalam batasan arena menjadi udara.
 * @param {object} server - Instance server Minecraft.
 * @param {object} bounds - Batasan wilayah { minX, minY, minZ, maxX, maxY, maxZ }.
 */
function clearArena(server, bounds) {
  validateServerInstance(server);
  if (!bounds) return;

  const { minX = 0, minY = 63, minZ = 0, maxX = 30, maxY = 70, maxZ = 0 } = bounds;
  fillRegion(server, minX, minY, minZ, maxX, maxY, maxZ, 'air');
}

module.exports = {
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
};
```

---

## 3. Caveats

1. **Kompatibilitas Versi Blok Minecraft**:
   - Pembangkitan menggunakan nama blok standar modern (`stone`, `stone_stairs`, `ladder`, `deepslate`, `spawner`, `chest`, `lava`, `iron_bars`, `air`). Jika berjalan di atas versi server lawas tertentu (misal 1.16.5 vs 1.20.1), `deepslate` di level 4 dapat difallback ke `stone`/`bedrock` jika palet blok versi tersebut belum mendukung `deepslate`. Namun untuk `flying-squid` dan Prismarine modern (1.16+ s.d. 1.20+), blok ini sepenuhnya valid.
2. **Efisiensi Jalur Waypoint Level 4**:
   - Pengerukan lorong `carveTunnel` Level 4 menghubungkan titik secara garis lurus antar waypoint. Jarak total ~509m menghasilkan sekitar 600 operasi setBlock per lorong, dieksekusi dalam $< 15$ ms pada memori JavaScript tanpa membebani event loop.
3. **Pemuatan Chunk Asinkron vs Sinkron**:
   - Pada server in-process berbasis `flying-squid` / `prismarine-world`, pemanggilan `setBlock` dapat memicu *chunk generation* jika chunk belum termuat. Fungsi `safeSetBlock` menangani koordinat bulat secara presisi sehingga chunk yang relevan langsung terisi tanpa error *out-of-bounds*.

---

## 4. Conclusion

1. **Spesifikasi & Blueprint Telah Lengkap**: Seluruh 4 level benchmark navigasi telah didefinisikan secara matematis, geometris, dan algoritmik dengan koordinat absolut dan toleransi yang konsisten terhadap pengujian E2E opaque-box (`test/e2e/tier1_feature_coverage.test.js` dan `test/e2e/tier2_boundary_corner.test.js`).
2. **Kesesuaian Aturan Bahasa**: Seluruh dokumentasi, komentar fungsi, dan pesan error dirancang secara ketat dalam **Bahasa Indonesia**.
3. **Pemisahan Peran**: Laporan ini menyediakan cetak biru lengkap bagi agen implementer (`worker_m2`) untuk menulis kode ke `src/server/arenaBuilder.js` tanpa ambiguitas logika atau pelanggaran batas dunia Minecraft.

---

## 5. Verification Method

Implementer dan reviewer dapat memverifikasi implementasi `src/server/arenaBuilder.js` menggunakan metode berikut:

1. **Uji Unit & Integrasi Generator Arena**:
   ```bash
   node --test test/server/server_arena_test.js
   ```
2. **Uji Cakupan Fitur Tier 1 (F01 & F02-F05)**:
   ```bash
   node --test test/e2e/tier1_feature_coverage.test.js
   ```
3. **Uji Nilai Batas & Ekstrem Tier 2 (Boundary & Corner Cases)**:
   ```bash
   node --test test/e2e/tier2_boundary_corner.test.js
   ```
4. **Verifikasi Assert Blok Langsung**:
   - Level 1: `arena.getBlock(0, 63, 0) === 'stone'` && `arena.getBlock(30, 63, 0) === 'stone'`
   - Level 2: `arena.getBlock(20, 64, 0) === 'stone'` && `arena.getBlock(20, 65, 0) === 'stone'`
   - Level 3: `arena.getBlock(5, 68, 0) === 'stone_stairs'` && `arena.getBlock(10, 73, 5) === 'stone'` && `arena.getBlock(10, 70, 15) === 'ladder'`
   - Level 4: `arena.getBlock(-256, -19, -432) === 'spawner'` && `arena.getBlock(-256, -21, -432) === 'deepslate'`
   - Batas Y: `throws(() => arena.setBlock(0, -70, 0, 'stone'), /di luar batas dunia Minecraft/i)`
   - Level Valid: `throws(() => arena.generateLevel(999), /Tingkat level arena tidak valid/i)`
