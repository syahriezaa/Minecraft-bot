# Survey & Technical Architecture: DeepSeek AI Brain & Multi-Step Task Execution

**Project**: Minecraft Autonomous Companion  
**Author**: Survey Explorer 3 (AI Brain & Multi-Step Task Execution)  
**Date**: 2026-08-18  
**Status**: COMPLETED  

---

## 1. Ringkasan Eksekutif (Executive Summary)

Sistem **Minecraft Autonomous Companion** membutuhkan integrasi kecerdasan buatan berbasis **DeepSeek AI (`deepseek-chat`)** yang bertindak sebagai *cognitive brain* tingkat tinggi untuk memproses instruksi bahasa alami (*natural language commands*) dari Web Terminal dan merencanakannya menjadi urutan tindakan multi-langkah (*multi-step task plans*).

Untuk menjamin keandalan dan performa real-time, arsitektur memisahkan secara tegas antara:
1. **High-Level Cognitive Planner (DeepSeek AI)**: Bertanggung jawab atas penalaran linguistik, dekomposisi misi, pemilihan alat (*tool/action calling*), dan evaluasi strategi global.
2. **Deterministic Task Execution Layer (Mineflayer Primitives & State Machines)**: Bertanggung jawab mengeksekusi aksi secara deterministik, mengelola fisika pergerakan, timing *weapon attack cooldown* (1.6s / 1.9s), manajemen container peti (*chest sorting*), serta protokol keselamatan saat membakar sampah (*trash incineration*).
3. **Resilience & Fallback Engine**: Mekanisme fallback otomatis jika API LLM mengalami timeout atau error (beralih ke *rule-based heuristic parser*), penanganan *world state mismatch* (target mati/hilang, inventaris penuh, jalur terblokir), dan pemulihan interupsi darurat (kesehatan rendah, lapar).

---

## 2. Arsitektur Integrasi DeepSeek AI (`deepseek-chat`)

```
+-------------------------------------------------------------------------------+
|                             WEB TERMINAL UI                                  |
|            User Input (Bahasa Alami) <----> Telemetry & Status Logs          |
+---------------------------------------+---------------------------------------+
                                        | HTTP / WebSocket
                                        v
+-------------------------------------------------------------------------------+
|                    AI BRAIN CONTROLLER (Node.js Service)                      |
|                                                                               |
|  +-------------------------------------------------------------------------+  |
|  | Context Builder (Bot Status, Inventory, Nearby Blocks/Entities, Health) |  |
|  +------------------------------------+------------------------------------+  |
|                                       |                                       |
|                                       v                                       |
|  +-------------------------------------------------------------------------+  |
|  | DeepSeek Client (`deepseek-chat` / OpenAI-Compatible API)               |  |
|  | - System Prompt Injection                                               |  |
|  | - Structured Tool Calling (Function Definition)                         |  |
|  +-------------------+---------------------------------+-------------------+  |
|                      | Success                         | Timeout / Offline    |
|                      v                                 v                      |
|  +------------------------------------+  +---------------------------------+  |
|  | Structured Plan & Action Parser    |  | Rule-Based Intent Fallback      |  |
|  +-------------------+----------------+  +----------------+----------------+  |
|                      |                                    |                   |
|                      +-----------------+------------------+                   |
|                                        |                                      |
|                                        v                                      |
|  +-------------------------------------------------------------------------+  |
|  | Multi-Step Task Orchestrator & Priority Queue                           |  |
|  +------------------------------------+------------------------------------+  |
+---------------------------------------+---------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
|                     MINEFLAYER DETERMINISTIC EXECUTION LAYER                  |
|  - Combat Engine (Zombie Farming & Cooldown 1.6s/1.9s)                        |
|  - Chest Sorting Engine (Multi-Chest Categorizer & Transfer)                  |
|  - Incinerator Engine (Hazard Safety & Item Tossing)                          |
|  - Pathfinder & Stuck Recovery Engine                                         |
+-------------------------------------------------------------------------------+
```

### 2.1. Konfigurasi Client DeepSeek API

DeepSeek API sepenuhnya kompatibel dengan spesifikasi OpenAI API v1. Integrasi dapat menggunakan library resmi `openai` di Node.js atau klien kustom `fetch`/`axios` dengan konfigurasi:
- **Base URL**: `https://api.deepseek.com` (atau `https://api.deepseek.com/v1`)
- **Model**: `deepseek-chat` (DeepSeek-V3)
- **Authentication**: `Bearer ${process.env.DEEPSEEK_API_KEY}`
- **Temperature**: `0.1` - `0.3` (suhu rendah untuk eksekusi terstruktur yang deterministik)
- **Response Format**: `tools` & `tool_choice` (JSON Function Calling) atau `json_object` mode.

```javascript
// Inisialisasi Klien DeepSeek AI
const OpenAI = require('openai');

const deepseekClient = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'mock-key',
  baseURL: 'https://api.deepseek.com/v1',
  timeout: 10000, // 10 detik batas waktu
  maxRetries: 2
});
```

### 2.2. Prompt Engineering & System Instructions

System prompt harus memposisikan model sebagai asisten companion Minecraft yang cerdas, taat keselamatan, dan efisien.

```markdown
Anda adalah otak AI otonom untuk Minecraft Companion Bot.
Tugas utama Anda adalah menerjemahkan instruksi pengguna ke dalam serangkaian rencana tindakan (task plan) terstruktur yang aman dan efisien.

Konteks Bot saat ini akan diberikan pada setiap permintaan:
- Posisi koordinat (x, y, z)
- Status Kesehatan (Health / Food)
- Item di tangan utama (mainHand) dan armor yang dipakai
- Isi ringkas inventaris (daftar item, slot kosong)
- Entitas terdekat (nama, jarak, posisi)
- Blok container/interaktif terdekat (chest, furnace, lava, fire)
- Tugas aktif saat ini

Aturan Operasional:
1. Selalu periksa apakah bot memiliki alat/senjata yang memadai sebelum memulai tugas berbahaya.
2. Jika inventaris penuh, rencanakan aksi penyimpanan ke peti (chest sorting) atau pembuangan sampah (incineration).
3. Jangan pernah merencanakan aksi bunuh diri (seperti berjalan langsung ke dalam lava/api).
4. Kembalikan rencana dalam bentuk pemanggilan tool (tool_calls) yang valid dan urutan logis.
```

### 2.3. Skema Tool Calling Terstruktur (JSON Schema)

DeepSeek API mendukung format `tools` yang memungkinkan definisi fungsi terstruktur. Berikut adalah daftar canonical tools yang didukung:

```json
[
  {
    "type": "function",
    "function": {
      "name": "farm_mobs",
      "description": "Menjalankan rutinitas farming mob (misal: zombie) di area spawner atau sekitar bot dengan weapon cooldown timing.",
      "parameters": {
        "type": "object",
        "properties": {
          "mobType": { "type": "string", "enum": ["zombie", "skeleton", "spider"], "description": "Tipe mob target" },
          "targetCount": { "type": "integer", "description": "Jumlah target yang ingin dieliminasi sebelum selesai", "default": 10 },
          "maxRadius": { "type": "number", "description": "Radius pencarian mob dari posisi bot", "default": 16.0 },
          "retreatHealth": { "type": "integer", "description": "Batas minimal HP untuk mundur dan makan", "default": 8 }
        },
        "required": ["mobType"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "sort_chests",
      "description": "Memindai peti di sekitar dan memindahkan item dari inventaris bot ke peti berdasarkan kategori.",
      "parameters": {
        "type": "object",
        "properties": {
          "searchRadius": { "type": "number", "description": "Radius pencarian peti di sekitar bot", "default": 12.0 },
          "categories": {
            "type": "array",
            "items": { "type": "string", "enum": ["weapons", "armor", "minerals", "mob_drops", "food", "trash", "all"] },
            "description": "Daftar kategori item yang akan disortir"
          }
        },
        "required": ["categories"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "incinerate_trash",
      "description": "Membuang item sampah yang ditentukan ke dalam insinerator aman (lava, api, kaktus, atau dispenser).",
      "parameters": {
        "type": "object",
        "properties": {
          "incineratorType": { "type": "string", "enum": ["lava", "fire", "cactus", "dispenser", "auto"], "default": "auto" },
          "itemTypes": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Daftar nama item sampah yang akan dibakar (misal: poisonous_potato, rotten_flesh)"
          },
          "keepSurplusThreshold": { "type": "integer", "description": "Jumlah sisa item yang boleh disimpan di tas", "default": 0 }
        },
        "required": ["itemTypes"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "navigate_to",
      "description": "Menggerakkan bot ke koordinat tujuan tertentu menggunakan pathfinder.",
      "parameters": {
        "type": "object",
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" },
          "z": { "type": "number" },
          "reachRange": { "type": "number", "default": 1.0 },
          "taskLabel": { "type": "string" }
        },
        "required": ["x", "y", "z"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "stop_all_tasks",
      "description": "Menghentikan semua tugas aktif dan mengembalikan bot ke status siaga (idle).",
      "parameters": {
        "type": "object",
        "properties": {
          "reason": { "type": "string" }
        }
      }
    }
  }
]
```

---

## 3. Investigasi Kemampuan Eksekusi Multi-Step Task

Setiap tugas tingkat tinggi didekomposisi menjadi urutan state machine deterministik yang menjamin keamanan bot dan keberhasilan tugas.

### 3.1. Sub-Task 1: Zombie Farming Engine

#### A. Deteksi Target & Pemilihan Senjata
1. **Pemindaian Entitas**:
   ```javascript
   const target = bot.nearestEntity(e => 
     e.name === 'zombie' && 
     e.isValid && 
     bot.entity.position.distanceTo(e.position) <= maxRadius
   );
   ```
2. **Auto-Equip Senjata Terbaik**:
   Sistem mengevaluasi nilai efektivitas senjata dalam inventaris dengan ranking prioritas:
   `netherite_sword` > `diamond_sword` > `iron_sword` > `stone_sword` > `golden_sword` > `wooden_sword` > `diamond_axe` > `iron_axe`.
   Bot memanggil `bot.equip(bestWeapon, 'hand')`.

#### B. Perhitungan Jarak Serang (Attack Reach)
- Hitbox zombie: lebar 0.6 blok, tinggi 1.95 blok.
- Jarak serang optimal: **2.2 - 2.8 blok**.
- Bot menjaga jarak agar tidak terkena *contact damage* (jarak < 1.5 blok) namun tetap berada dalam jangkauan melee attack (jarak <= 3.0 blok).

#### C. Penanganan Cooldown Serangan (Attack Cooldown Timing)
- Di Minecraft 1.9+ (Combat Update), senjata memiliki kecepatan serangan (*attack speed*):
  - **Pedang (Sword)**: Kecepatan 1.6 serangan/detik $\rightarrow$ Cooldown penuh = $\frac{1000\text{ ms}}{1.6} \approx 625\text{ ms}$.
  - **Kapak (Axe)**: Kecepatan 0.8 - 1.0 serangan/detik $\rightarrow$ Cooldown penuh = $1000 - 1250\text{ ms}$.
  - **Pukulan Kosong / Lainnya**: $250 - 500\text{ ms}$.
- Sistem mengimplementasikan **Attack Pacer** menggunakan timestamp:
  ```javascript
  const now = Date.now();
  if (now - lastAttackTime >= weaponCooldownMs) {
    bot.lookAt(target.position.offset(0, target.height * 0.85, 0));
    bot.attack(target);
    lastAttackTime = now;
  }
  ```
- Opsi pacing konservatif: Konfigurasi safety padding (misal: 650ms untuk pedang atau 1600ms/1900ms jika disesuaikan dengan siklus aman) untuk memastikan 100% damage multiplier & sweeping edge trigger.

#### D. Penjemputan Drop Item & Proteksi Diri
- Setelah zombie mati, bot mendeteksi entitas drop item di tanah (`rotten_flesh`, `iron_ingot`, `carrot`, `potato`, armor) dan bergerak mendekat untuk mengambil loot.
- **Safety Interruption**: Jika `bot.health <= 8` (4 hati), bot otomatis beralih ke state `RETREAT_AND_EAT`, mencari lokasi aman sejauh 10 blok, mengonsumsi makanan, lalu kembali melanjutkan farming setelah darah pulih.

---

### 3.2. Sub-Task 2: Multi-Chest Item Sorting Engine

#### A. Pemindaian & Peta Lokasi Peti
1. Bot memindai blok di sekitar radius 12 blok yang bertipe `chest`, `trapped_chest`, atau `barrel`.
2. Setiap peti diberi ID dan dicatat koordinatnya. Jika ada papan nama (sign) atau konfigurasi zona, sistem dapat memetakan peti khusus (misal: "Peti Senjata", "Peti Mineral", "Peti Mob Drops").

#### B. Taksonomi & Kategorisasi Item
Sistem menggunakan modul kategorisasi item deterministik:

| Kategori | Item ID Pattern / Daftar |
| :--- | :--- |
| **Weapons** | `*_sword`, `*_bow`, `crossbow`, `trident`, `*_axe` |
| **Armor** | `*_helmet`, `*_chestplate`, `*_leggings`, `*_boots`, `shield`, `elytra` |
| **Minerals** | `coal`, `iron_ingot`, `gold_ingot`, `diamond`, `emerald`, `lapis_lazuli`, `redstone`, `copper_ingot`, `netherite_ingot`, `raw_iron`, `raw_gold`, `raw_copper` |
| **Mob Drops** | `rotten_flesh`, `bone`, `string`, `spider_eye`, `gunpowder`, `arrow`, `ender_pearl`, `slime_ball`, `feather` |
| **Food & Crops** | `bread`, `cooked_*`, `apple`, `wheat`, `carrot`, `potato`, `sweet_berries`, `golden_apple` |
| **Trash** | `poisonous_potato`, item durability < 5% tanpa enchant, batu/tanah berlebih jika tas penuh |

#### C. Alur Kerja Transfer Item (Opening, Depositing, Closing)
1. **Navigasi**: Bergerak ke posisi di samping peti (jarak interaksi 1.5 - 2.5 blok).
2. **Buka Peti**: `const chest = await bot.openContainer(chestBlock);`
3. **Pemeriksaan Slot**: Menghitung slot kosong di dalam peti.
4. **Deposit Item Sesuai Kategori**:
   ```javascript
   for (const item of bot.inventory.items()) {
     if (getItemCategory(item.name) === targetCategory) {
       await chest.deposit(item.type, null, item.count);
       await bot.waitForTicks(2); // Menghindari desync server
     }
   }
   ```
5. **Tutup Peti**: `chest.close();`
6. **Iterasi**: Melanjutkan ke peti berikutnya sampai seluruh item terpilah dengan rapi.

---

### 3.3. Sub-Task 3: Trash Incineration Engine

#### A. Identifikasi Item Sampah
Item diklasifikasikan sebagai sampah berdasarkan kriteria:
1. **Item Sampah Mutlak**: `poisonous_potato` (tidak berguna dan beracun).
2. **Surplus Mob Drops**: `rotten_flesh` jika jumlah dalam inventaris > kuota penyimpanan (misal: simpan maksimal 64 buah, sisanya dimusnahkan).
3. **Peralatan Rusak Rendah**: Senjata/armor kulit atau kayu dengan durabilitas < 10% dan tanpa enchantment.
4. **Blok Berlebih**: `dirt`, `cobblestone`, `gravel` jika tas bot mencapai kapasitas 90% dan sedang dalam mode farming.

#### B. Lokasi & Deteksi Insinerator
Sistem mencari salah satu dari 4 media insinerator terdekat:
1. **Lava Block** (`lava`): Media tercepat membakar item.
2. **Fire Block** (`fire`): Api di atas netherrack atau blok lain.
3. **Cactus Block** (`cactus`): Menghancurkan item yang bersentuhan dengannya.
4. **Automated Dispenser / Dropper**: Sistem redstone yang mengarah ke lava.

#### C. Protokol Keselamatan Pembuangan Item (Hazard Safety)
> ⚠️ **Prinsip Keselamatan Utama**: Bot DILARANG KERAS melangkah masuk ke dalam koordinat lava atau api.

```
       [Bot Stand Position]  <-- Jarak Aman (1.5 - 2.0 blok)
               |
               | (Mengarahkan pandangan ke pusat lava)
               v
         [Lava Block]
```

1. **Titik Berdiri Aman (Safe Standpoint)**:
   - Bot mencari blok solid yang bersebelahan dengan blok lava/api (bukan di atasnya).
   - Jarak berdiri diatur tepat 1.5 - 2.0 blok dari pusat bahaya.
2. **Arah Pandang (Pitch & Yaw)**:
   - Bot memutar pandangan tepat ke arah blok lava: `await bot.lookAt(lavaBlock.position.offset(0.5, 0.5, 0.5));`
3. **Toss Action**:
   - Membuang item satu per satu atau per stack:
     ```javascript
     const trashItem = bot.inventory.items().find(i => isTrashItem(i.name));
     if (trashItem) {
       await bot.toss(trashItem.type, null, trashItem.count);
       await bot.waitForTicks(5);
     }
     ```
4. **Verifikasi Penghancuran**:
   - Memeriksa bahwa item telah lenyap dari inventaris bot dan tidak terpental kembali ke tas bot.

---

## 4. Mekanisme Fallback, Verifikasi, dan Error Recovery

### 4.1. Penanganan Kegagalan & Timeout DeepSeek LLM
- **Timeout & Retry Strategy**: Jika request ke DeepSeek API tidak merespons dalam 10 detik, sistem melakukan retry maksimal 2 kali dengan *exponential backoff* (1s, 2s).
- **Offline / Deterministic Rule-Based Fallback**:
  Jika API key tidak tersedia atau API mengalami kendala jaringan, sistem secara otomatis mengaktifkan *heuristic intent matcher*:
  - Input: `"farm zombie"` / `"bunuh zombie"` $\rightarrow$ memanggil tool `farm_mobs({ mobType: 'zombie', targetCount: 10 })`.
  - Input: `"sort chest"` / `"rapikan peti"` $\rightarrow$ memanggil tool `sort_chests({ categories: ['all'] })`.
  - Input: `"bakar sampah"` / `"incinerate trash"` $\rightarrow$ memanggil tool `incinerate_trash({ itemTypes: ['poisonous_potato', 'rotten_flesh'] })`.
  - Input: `"pergi ke 100 64 -200"` $\rightarrow$ memanggil tool `navigate_to({ x: 100, y: 64, z: -200 })`.
- **Mock DeepSeek Provider untuk Headless Testing**:
  Untuk pengujian otomatis tanpa biaya API token dan tanpa ketergantungan internet, disediakan `MockDeepSeekClient` yang merespons secara instan dengan payload JSON terstruktur yang valid.

### 4.2. Penanganan Error World State Real-Time
1. **Target Zombie Mati / Hilang**:
   - Jika target zombie dieliminasi oleh sumber lain atau hilang saat bot mendekat, state machine tidak throw error, melainkan mencari target baru atau menyelesaikan sub-task.
2. **Peti Terhalang (Obstructed Chest)**:
   - Jika peti tidak dapat dibuka (misal ada kucing atau blok solid di atasnya), bot menangkap event error, mencatat log peringatan, dan beralih ke peti berikutnya.
3. **Jalur Terjebak / Buntet (Stuck Path)**:
   - Jika `bot.pathfinder` berhenti bergerak selama >3 detik, trigger *stuck recovery* (melompat, mundur 1 blok, atau menghitung ulang jalur alternatif).
4. **Inventaris Penuh Saat Farming (Inventory Full State)**:
   - Bot mendeteksi sisa slot kosong == 0 $\rightarrow$ menunda farming sementara (*pause*) $\rightarrow$ memicu sub-task `sort_chests` atau `incinerate_trash` $\rightarrow$ setelah tas lega, melanjutkan farming zombie kembali.

### 4.3. Hirarki Prioritas State & Interupsi Darurat

```
+-------------------------------------------------------------------+
| Prioritas 1: CRITICAL_SAFETY (HP <= 8, drowning, on fire, eating) |
+---------------------------------+---------------------------------+
                                  | Resume when safe
+---------------------------------v---------------------------------+
| Prioritas 2: INVENTORY_MAINTENANCE (Tas penuh, butuh sort/burn)  |
+---------------------------------+---------------------------------+
                                  | Resume when space available
+---------------------------------v---------------------------------+
| Prioritas 3: ACTIVE_TASK (Zombie farming, Chest sorting, Travel)  |
+---------------------------------+---------------------------------+
                                  | Complete / None
+---------------------------------v---------------------------------+
| Prioritas 4: IDLE_STANDBY (Menunggu perintah di Web Terminal)    |
+-------------------------------------------------------------------+
```

---

## 5. Rancangan Struktur Kode & Kontrak Antarmuka (Interface Contracts)

Struktur file yang direkomendasikan untuk modul AI Brain dan Task Execution:

```
src/
├── ai/
│   ├── DeepSeekClient.js        # Klien API DeepSeek dengan retry & mock mode
│   ├── PromptEngine.js          # Pembentuk konteks & system prompt builder
│   ├── ToolSchema.js            # Definisi JSON schema untuk tool calling
│   ├── IntentFallback.js        # Regex & heuristic rule-based fallback parser
│   └── TaskPlanner.js           # Pengubah LLM output menjadi urutan tugas
├── tasks/
│   ├── TaskManager.js           # Orkestrator task queue & interrupt controller
│   ├── BaseTask.js              # Kelas dasar task dengan lifecycle (start, tick, cancel)
│   ├── ZombieFarmingTask.js     # Logika farming, weapon equip, cooldown, reach
│   ├── ChestSortingTask.js      # Pemindaian peti, kategorisasi item, transfer
│   └── TrashIncinerationTask.js # Deteksi insinerator, safe stance, item tossing
└── utils/
    ├── ItemCategorizer.js       # Mapping kategori item Minecraft
    └── CombatCooldownPacer.js   # Perhitungan waktu cooldown 1.6s/1.9s
```

### 5.1. Spesifikasi Tipe & Kontrak API

```typescript
// Kontrak Input Perintah dari Web Terminal
export interface UserCommandRequest {
  command: string;          // Contoh: "Tolong bersihkan tas dan bakar poisonous potato"
  sessionId?: string;
  source: 'web_terminal' | 'automated_test';
}

// Kontrak Status Bot untuk Konteks LLM
export interface BotContextSnapshot {
  position: { x: number; y: number; z: number };
  health: number;
  food: number;
  heldItem: string | null;
  emptyInventorySlots: number;
  inventorySummary: { [itemName: string]: number };
  nearbyEntities: Array<{ name: string; distance: number }>;
  nearbyContainers: Array<{ type: string; position: { x: number; y: number; z: number } }>;
  activeTask: string | null;
}

// Kontrak Hasil Rencana Tindakan dari DeepSeek AI
export interface PlannedAction {
  tool: 'farm_mobs' | 'sort_chests' | 'incinerate_trash' | 'navigate_to' | 'stop_all_tasks';
  parameters: Record<string, any>;
  reasoning: string;
}

// Kontrak Hasil Eksekusi Tugas
export interface TaskExecutionResult {
  taskId: string;
  taskType: string;
  success: boolean;
  durationMs: number;
  metrics: {
    mobsDefeated?: number;
    itemsSorted?: number;
    itemsIncinerated?: number;
    traveledDistance?: number;
  };
  errorMessage?: string;
}
```

---

## 6. Rencana Pengujian & Kriteria Verifikasi

| ID Pengujian | Deskripsi Skenario | Kriteria Keberhasilan | Metode Verifikasi |
| :--- | :--- | :--- | :--- |
| **TEST-AI-01** | Parsing instruksi bahasa alami via DeepSeek API | DeepSeek menghasilkan function call `farm_mobs` dengan parameter valid saat menerima prompt "Tolong farming 5 zombie". | Unit test dengan `MockDeepSeekClient` & integrasi live |
| **TEST-AI-02** | Fallback otomatis saat API offline / timeout | Sistem mengeksekusi `IntentFallback` dan tetap menjalankan aksi tanpa crash saat API disimulasikan offline. | Unit test simulasi offline |
| **TEST-TASK-01** | Zombie Farming & Cooldown Pacing | Bot melengkapi pedang, menyerang dengan interval $\ge 625\text{ ms}$, membunuh zombie tanpa spam click, dan mengumpulkan loot. | Headless test dengan dummy entity zombie |
| **TEST-TASK-02** | Multi-Chest Sorting | Bot membuka peti, mentransfer mineral ke peti mineral dan mob drops ke peti drops sesuai kategori. | Headless test dengan container mock |
| **TEST-TASK-03** | Trash Incinerator Safety & Disposal | Bot berdiri pada jarak aman ($\ge 1.5\text{ blok}$) dari lava, melempar `poisonous_potato`, dan tidak terkena fire damage. | Headless test dengan blok lava |
| **TEST-RECOV-01** | Interupsi Darurat Kesehatan | Bot otomatis menghentikan tugas dan mundur untuk makan jika HP $\le 8$. | Headless test dengan manipulasi HP |

---

## 7. Kesimpulan & Rekomendasi Implementasi

1. **Pemisahan Peran yang Jelas**: DeepSeek AI bertindak sebagai perencana strategi (*strategic planner*), sedangkan Mineflayer dan task engine bertindak sebagai pelaksana fisik (*tactical executor*). Hal ini mencegah latensi API mengganggu kelancaran pergerakan bot di dalam game.
2. **Kesiapan Mode Offline**: Adanya `IntentFallback` dan `MockDeepSeekClient` memastikan bahwa benchmark otomatis dan pengujian headless dapat berjalan 100% lulus tanpa hambatan kuota API atau koneksi internet.
3. **Pemberlakuan Standar Bahasa**: Seluruh pesan feedback terminal, log kesalahan, dan komentar kode diimplementasikan dalam **Bahasa Indonesia** sesuai instruksi pengguna.
