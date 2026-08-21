/**
 * @file runStorageWorker.js
 * @description Pekerja gudang ("kuartermaster") otonom: kumpulkan isi semua chest DI LUAR rumah
 * dan bawa masuk ke chest gudang DI DALAM ruang penyimpanan rumah, lalu rapikan gudang dengan
 * membuka tiap chest di dalamnya untuk memeriksa isinya. Permintaan nyata pemilik: "give me one
 * worker for managing storage so it collect all the chest outside the hose and bring it to the
 * house storage room and tidy up storage room by opening all the chest and check the item".
 * Dibangun di atas mineflayer + mineflayer-pathfinder langsung (sama seperti worker lain).
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1.2';
patchMineflayerVersionGate(SERVER_VERSION);

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { StorageManagerEngine } = require('./storageManagerEngine');
const { walkToBase } = require('./walkToBase');

const TICK_INTERVAL_MS = Number(process.env.STORAGE_TICK_MS) || 2000;
// Memori "jenis item ini pergi ke chest itu" DISIMPAN KE DISK - supaya sortir tetap konsisten
// lintas restart worker (tanpa ini, StorageManagerEngine cuma ingat assignment SELAMA proses ini
// hidup - begitu dashboard di-restart, semua memori hilang dan chest bisa dipilih beda-beda lagi
// tiap kali) - ditemukan dari keluhan nyata pemilik: "does not have any memory about storage chest".
const ASSIGNMENTS_FILE = process.env.STORAGE_ASSIGNMENTS_FILE || path.join(__dirname, '..', '..', 'data', 'storageChestAssignments.json');

function loadAssignments(log) {
  try {
    if (!fs.existsSync(ASSIGNMENTS_FILE)) return {};
    return JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, 'utf8'));
  } catch (e) {
    log(`PERINGATAN: gagal memuat memori sortir gudang dari disk (${e.message}) - mulai dari kosong.`);
    return {};
  }
}

function saveAssignments(assignments, log) {
  try {
    fs.mkdirSync(path.dirname(ASSIGNMENTS_FILE), { recursive: true });
    fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2));
  } catch (e) {
    log(`PERINGATAN: gagal menyimpan memori sortir gudang ke disk (${e.message})`);
  }
}

// PENTING - koreksi besar setelah salah diagnosis sebelumnya: sesi ini pernah menganggap kolom
// z yang bersebelahan (mis. z=-353/-352) sebagai SATU Large Chest fisik yang sama, cuma karena
// dua blok chest berdiri berdampingan. Itu SALAH. Dicek langsung lewat blockstate ("type") tiap
// chest di dunia sungguhan: SEMUA chest di x=-181 ber-type "right", dan SEMUA chest di x=-180
// ber-type "left" pada z yang SAMA - pasangan double-chest sungguhan di gudang ini SELALU di
// sepanjang sumbu X (x=-181 dengan x=-180 pada z yang sama), BUKAN antar-z. Dua chest type
// "right" yang kebetulan bersebelahan sepanjang Z (mis. z=-353 dan z=-352, SAMA-SAMA "right")
// TIDAK PERNAH benar-benar terhubung - masing-masing punya pasangan SENDIRI di x=-180. Akibatnya
// SETIAP kolom z di sini adalah chest TERPISAH (bukan gabungan dgn z tetangga), ditemukan dari
// keluhan nyata pemilik: "nether_wart/sugar_cane/glow_berries bolak-balik tanpa henti" - root
// cause-nya persis alias yang salah ini. storageManagerEngine.js sekarang memvalidasi blockstate
// type (left+right, bukan sekadar bersebelahan) lewat getChestHalfType() - x=-180 otomatis
// tergabung dengan x=-181 pada z yang sama TANPA perlu didaftarkan eksplisit di sini.
//
// Rumah BAKU untuk ore/ingot/bahan berharga - dipetakan langsung dari isi gudang sungguhan (lihat
// layout yang sudah didokumentasikan). Dipaksa (override memori yang mungkin sudah keliru belajar
// sebelumnya) supaya barang seperti iron_ingot yang nyasar ke chest lain (mis. chest loot campuran)
// benar-benar DIPINDAHKAN ke rumah yang benar - permintaan nyata pemilik: "jika ada ore atau ingot
// di peti yang salah silahkan di pindahkan". Chest "Bahan Berharga" (y74,z-353) untuk barang yang
// SUDAH diproses (ingot/blok/permata); chest "Bijih Mentah" (y73,z-353) untuk bijih mentah/redstone.
const PROCESSED_ORE_CHEST = '-181,74,-353';
const RAW_ORE_CHEST = '-181,73,-353';
// Cadangan DARURAT untuk ore/ingot - dipakai HANYA kalau chest utama genuinely penuh (lihat
// OVERFLOW_CHESTS + resolveChestForItem di storageManagerEngine.js), BUKAN rumah kedua yang
// setara - permintaan nyata pemilik: "make the overflow chest is for emergency only when the
// actual cest is full". Semua ore/ingot TETAP terdaftar ke chest utama; overflow cuma jalan
// keluar sementara saat chest utama tidak bisa menerima. Kolom z=-344 dipakai sebagai kolom
// cadangan darurat (chest TERPISAH sendiri, bukan gabungan dengan z=-345 - lihat koreksi di atas).
const PROCESSED_ORE_OVERFLOW_CHEST = '-181,74,-344';
const CANONICAL_ORE_INGOT_ASSIGNMENTS = {
  coal: PROCESSED_ORE_CHEST,
  coal_block: PROCESSED_ORE_CHEST,
  iron_ingot: PROCESSED_ORE_CHEST,
  iron_block: PROCESSED_ORE_CHEST,
  copper_ingot: PROCESSED_ORE_CHEST,
  waxed_copper_block: PROCESSED_ORE_CHEST,
  lapis_lazuli: PROCESSED_ORE_CHEST,
  diamond: PROCESSED_ORE_CHEST,
  gold_ingot: PROCESSED_ORE_CHEST,
  emerald_block: PROCESSED_ORE_CHEST,
  netherite_ingot: PROCESSED_ORE_CHEST,
  redstone: RAW_ORE_CHEST,
  redstone_block: RAW_ORE_CHEST,
  raw_iron: RAW_ORE_CHEST,
  raw_iron_block: RAW_ORE_CHEST,
  raw_copper: RAW_ORE_CHEST,
  raw_copper_block: RAW_ORE_CHEST,
  raw_gold: RAW_ORE_CHEST,
  raw_gold_block: RAW_ORE_CHEST,
  gold_nugget: RAW_ORE_CHEST,
  crying_obsidian: RAW_ORE_CHEST
};

// Rancangan ulang MENYELURUH (permintaan nyata pemilik: "kategori nya lebih rapi terpisah pisah",
// versi 4-kategori sebelumnya dinilai "masih terlalu campur campur"). Semua double chest gudang
// punya SATU kategori jelas, bukan cuma 4 chest gear yang dirapikan sebelumnya - kategori lain
// (buku, mob drop, komponen redstone, bibit tanaman, benih, hasil sampingan panen, pernak-pernik,
// drop langka) masing-masing dapat rumah sendiri, dipetakan dari isi sungguhan gudang saat ini.
// Setiap kolom z di sini adalah chest TERPISAH (lihat koreksi besar di atas dekat PROCESSED_ORE_CHEST
// - pasangan double-chest sungguhan selalu sepanjang sumbu X dengan x=-180, bukan antar-kolom-z).
const NETHER_MATERIALS_CHEST = '-181,71,-353';
const STONE_COBBLE_CHEST = '-181,71,-352';
// Kolom z=-344 dipakai sebagai CADANGAN untuk 3 kategori yang paling sering "destination full":
// drop mob, benih, dan batu/cobble - chest TERPISAH sendiri (bukan gabungan dengan z=-345).
const MOB_DROPS_OVERFLOW_CHEST = '-181,71,-344';
const SEEDS_OVERFLOW_CHEST = '-181,72,-344';
const STONE_COBBLE_OVERFLOW_CHEST = '-181,73,-344';
// Armor, buku, dan perkakas SENGAJA disimpan di BARREL, bukan chest - permintaan nyata pemilik
// ("i think tools armor and book shoud be store in barel"). Posisi barel diambil dari barel
// sungguhan yang ditemukan di antara kolom chest (y71-73, z -351/-348) - barel TIDAK PERNAH
// bergabung dengan chest/barel lain apapun jaraknya, jadi masing-masing memang benar chest
// tunggal sungguhan.
const ARMOR_CHEST = '-181,71,-351'; // barrel
const MOB_DROPS_CHEST = '-181,71,-349';
const BOOKS_CHEST = '-181,72,-351'; // barrel
const TOOLS_CHEST = '-181,71,-348'; // barrel
const FOOD_CHEST = '-181,71,-345';

const RAILS_MINECART_CHEST = '-181,72,-353';
const WEAPONS_CHEST = '-181,72,-352';
const SEEDS_CHEST = '-181,72,-350';
const FARMING_BYPRODUCTS_CHEST = '-181,72,-349';
const SAPLINGS_PLANTS_CHEST = '-181,72,-347';
// Kolom z=-347 (SEMUA level y) SENGAJA dijadikan SATU tema besar "kayu & hasil olahannya" -
// permintaan nyata pemilik: "-347 dari atas ke bawah isi dengan wood dan hasilnya misal log
// sapling planks, pindahkan yang lainnya". y72(sapling)/y73(planks)/y74(log) sudah kayu; y71 baru
// bebas (dipindah dari buku ke barrel) - dipakai untuk kayu batang bercorak/olahan lain (stripped
// log, trapdoor kayu, dst) supaya seluruh kolom murni kayu.
const WOOD_BLOCKS_CHEST = '-181,71,-347';
// Cadangan DARURAT untuk WOOD_BLOCKS_CHEST - ditemukan dari keluhan nyata pemilik langsung lewat
// pemantauan live ("-181,71,-347 punya banyak item yang salah tempat itu juga harus menjadi
// pertimbangan algoritma kita"): chest ini kronis penuh ("destination full" berulang saat
// mengantar spruce_slab) - barel di z=-346 (standalone, tidak pernah menyatu dengan chest/barel
// lain) dipakai sebagai tempat daruratnya.
const WOOD_BLOCKS_OVERFLOW_CHEST = '-181,71,-346'; // barrel
const TRINKETS_CHEST = '-181,72,-345';

const BUILDING_MATERIALS_CHEST = '-181,73,-352';
const WHEAT_CHEST = '-181,73,-350';
const CARROT_CHEST = '-181,73,-349';
const PLANKS_CHEST = '-181,73,-347';
const UTILITY_BLOCKS_CHEST = '-181,73,-345';

const DIRT_SAND_CHEST = '-181,74,-352';
const POTATO_CHEST = '-181,74,-350';
// y74,-349 SENGAJA dibiarkan tanpa kategori baku - isinya kecil dan sudah ditangani kategori lain,
// jadi slot ini jadi ruang cadangan alami untuk kategori manapun yang kehabisan tempat.
const LOGS_CHEST = '-181,74,-347';
const RARE_DROPS_CHEST = '-181,74,-345';

const CANONICAL_GEAR_ASSIGNMENTS = {
  // Buku & catatan
  enchanted_book: BOOKS_CHEST, book: BOOKS_CHEST, bookshelf: BOOKS_CHEST,
  writable_book: BOOKS_CHEST, written_book: BOOKS_CHEST, knowledge_book: BOOKS_CHEST,

  // Armor & perisai
  leather_helmet: ARMOR_CHEST, leather_chestplate: ARMOR_CHEST, leather_leggings: ARMOR_CHEST, leather_boots: ARMOR_CHEST,
  golden_helmet: ARMOR_CHEST, golden_chestplate: ARMOR_CHEST, golden_leggings: ARMOR_CHEST, golden_boots: ARMOR_CHEST,
  iron_helmet: ARMOR_CHEST, iron_chestplate: ARMOR_CHEST, iron_leggings: ARMOR_CHEST, iron_boots: ARMOR_CHEST,
  diamond_helmet: ARMOR_CHEST, diamond_chestplate: ARMOR_CHEST, diamond_leggings: ARMOR_CHEST, diamond_boots: ARMOR_CHEST,
  netherite_helmet: ARMOR_CHEST, netherite_chestplate: ARMOR_CHEST, netherite_leggings: ARMOR_CHEST, netherite_boots: ARMOR_CHEST,
  chainmail_helmet: ARMOR_CHEST, chainmail_chestplate: ARMOR_CHEST, chainmail_leggings: ARMOR_CHEST, chainmail_boots: ARMOR_CHEST,
  turtle_helmet: ARMOR_CHEST, shield: ARMOR_CHEST,
  iron_horse_armor: ARMOR_CHEST, golden_horse_armor: ARMOR_CHEST, diamond_horse_armor: ARMOR_CHEST, leather_horse_armor: ARMOR_CHEST,
  elytra: ARMOR_CHEST,

  // Senjata (dipisah dari armor - kategori sendiri, slot baru hasil konsolidasi blok utilitas)
  wooden_sword: WEAPONS_CHEST, stone_sword: WEAPONS_CHEST, golden_sword: WEAPONS_CHEST, iron_sword: WEAPONS_CHEST, diamond_sword: WEAPONS_CHEST, netherite_sword: WEAPONS_CHEST,
  bow: WEAPONS_CHEST, crossbow: WEAPONS_CHEST, trident: WEAPONS_CHEST, arrow: WEAPONS_CHEST, spectral_arrow: WEAPONS_CHEST, tipped_arrow: WEAPONS_CHEST,

  // Perkakas (kapak/sekop/beliung/cangkul) - kategori SENDIRI di barrel, dipisah dari senjata
  // (permintaan nyata pemilik: "tools armor and book shoud be store in barel").
  wooden_axe: TOOLS_CHEST, stone_axe: TOOLS_CHEST, golden_axe: TOOLS_CHEST, iron_axe: TOOLS_CHEST, diamond_axe: TOOLS_CHEST, netherite_axe: TOOLS_CHEST,
  wooden_shovel: TOOLS_CHEST, stone_shovel: TOOLS_CHEST, golden_shovel: TOOLS_CHEST, iron_shovel: TOOLS_CHEST, diamond_shovel: TOOLS_CHEST, netherite_shovel: TOOLS_CHEST,
  wooden_pickaxe: TOOLS_CHEST, stone_pickaxe: TOOLS_CHEST, golden_pickaxe: TOOLS_CHEST, iron_pickaxe: TOOLS_CHEST, diamond_pickaxe: TOOLS_CHEST, netherite_pickaxe: TOOLS_CHEST,
  wooden_hoe: TOOLS_CHEST, stone_hoe: TOOLS_CHEST, golden_hoe: TOOLS_CHEST, iron_hoe: TOOLS_CHEST, diamond_hoe: TOOLS_CHEST, netherite_hoe: TOOLS_CHEST,
  fishing_rod: TOOLS_CHEST, shears: TOOLS_CHEST, flint_and_steel: TOOLS_CHEST,

  // Makanan
  cooked_chicken: FOOD_CHEST, chicken: FOOD_CHEST, cooked_beef: FOOD_CHEST, beef: FOOD_CHEST,
  cooked_porkchop: FOOD_CHEST, porkchop: FOOD_CHEST, mutton: FOOD_CHEST, cooked_mutton: FOOD_CHEST,
  baked_potato: FOOD_CHEST, bread: FOOD_CHEST, apple: FOOD_CHEST, golden_apple: FOOD_CHEST,
  enchanted_golden_apple: FOOD_CHEST, cooked_salmon: FOOD_CHEST, salmon: FOOD_CHEST, cooked_cod: FOOD_CHEST,
  cod: FOOD_CHEST, cake: FOOD_CHEST, cookie: FOOD_CHEST, pumpkin_pie: FOOD_CHEST, egg: FOOD_CHEST,

  // Drop mob (bahan mentah dari membunuh/menjarah mob, BUKAN makanan/armor/senjata) - SEMUA
  // terdaftar ke chest utama; MOB_DROPS_OVERFLOW_CHEST cuma dipakai DARURAT lewat OVERFLOW_CHESTS
  // (lihat di bawah) saat chest utama genuinely penuh - permintaan nyata pemilik: overflow hanya
  // untuk darurat, bukan rumah kedua yang setara.
  bone: MOB_DROPS_CHEST, string: MOB_DROPS_CHEST, spider_eye: MOB_DROPS_CHEST,
  leather: MOB_DROPS_CHEST, white_wool: MOB_DROPS_CHEST, black_wool: MOB_DROPS_CHEST, gray_wool: MOB_DROPS_CHEST,
  white_carpet: MOB_DROPS_CHEST,
  slime_ball: MOB_DROPS_CHEST, phantom_membrane: MOB_DROPS_CHEST,
  rotten_flesh: MOB_DROPS_CHEST, feather: MOB_DROPS_CHEST, gunpowder: MOB_DROPS_CHEST,
  ender_eye: MOB_DROPS_CHEST, glow_ink_sac: MOB_DROPS_CHEST, ink_sac: MOB_DROPS_CHEST,
  breeze_rod: MOB_DROPS_CHEST, wind_charge: MOB_DROPS_CHEST,

  // Bibit pohon (SAPLINGS_PLANTS_CHEST) - HANYA bibit pohon (bagian dari tema kayu kolom z=-347),
  // jamur/tanaman nether/kaktus DIKELUARKAN (bukan "hasil kayu") - permintaan nyata pemilik: kolom
  // -347 murni kayu saja, pindahkan yang lain.
  oak_sapling: SAPLINGS_PLANTS_CHEST, spruce_sapling: SAPLINGS_PLANTS_CHEST, birch_sapling: SAPLINGS_PLANTS_CHEST,
  jungle_sapling: SAPLINGS_PLANTS_CHEST, acacia_sapling: SAPLINGS_PLANTS_CHEST, dark_oak_sapling: SAPLINGS_PLANTS_CHEST,
  cherry_sapling: SAPLINGS_PLANTS_CHEST, mangrove_propagule: SAPLINGS_PLANTS_CHEST,

  // Benih murni (SEEDS_CHEST) - beda dari hasil panen utama dan hasil sampingan panen. SEMUA
  // terdaftar ke chest utama; overflow cuma darurat lewat OVERFLOW_CHESTS di bawah.
  wheat_seeds: SEEDS_CHEST,
  beetroot_seeds: SEEDS_CHEST, melon_seeds: SEEDS_CHEST, pumpkin_seeds: SEEDS_CHEST,
  torchflower_seeds: SEEDS_CHEST, pitcher_pod: SEEDS_CHEST,

  // Hasil sampingan bercocok tanam (bukan benih murni, bukan hasil panen utama wheat/carrot/potato)
  sugar_cane: FARMING_BYPRODUCTS_CHEST, sugar: FARMING_BYPRODUCTS_CHEST, glow_berries: FARMING_BYPRODUCTS_CHEST,
  melon_slice: FARMING_BYPRODUCTS_CHEST, nether_wart: FARMING_BYPRODUCTS_CHEST, cocoa_beans: FARMING_BYPRODUCTS_CHEST,
  pumpkin: FARMING_BYPRODUCTS_CHEST, glistering_melon_slice: FARMING_BYPRODUCTS_CHEST, bamboo: FARMING_BYPRODUCTS_CHEST,
  sand: DIRT_SAND_CHEST,

  // Pernak-pernik/curio biasa (dekorasi umum, bukan drop langka)
  dandelion: TRINKETS_CHEST, white_banner: TRINKETS_CHEST, glass_bottle: TRINKETS_CHEST, calcite: TRINKETS_CHEST,
  ender_pearl: TRINKETS_CHEST, flint: TRINKETS_CHEST, iron_nugget: TRINKETS_CHEST, cactus: TRINKETS_CHEST,

  // Bahan bangunan olahan (bata/tangga/lempeng/dinding/kaca)
  stone_bricks: BUILDING_MATERIALS_CHEST, deepslate: BUILDING_MATERIALS_CHEST, glowstone: NETHER_MATERIALS_CHEST,
  glowstone_dust: NETHER_MATERIALS_CHEST, blaze_rod: RARE_DROPS_CHEST,
  netherite_upgrade_smithing_template: RARE_DROPS_CHEST, obsidian: RAW_ORE_CHEST,

  // Tumbuhan/jamur nether (bukan kayu, bukan log/stem - ditemukan nyasar di chest bibit pohon
  // lewat pemantauan live: mushroom_stem, weeping_vines, warped_wart_block, crimson/warped
  // roots & fungus tidak pernah dikategorikan sebelumnya, jadi tidak pernah terdeteksi salah
  // tempat walau jelas bukan bibit pohon) - digabung dengan bahan nether lain (glowstone dst).
  mushroom_stem: NETHER_MATERIALS_CHEST, weeping_vines: NETHER_MATERIALS_CHEST,
  warped_wart_block: NETHER_MATERIALS_CHEST, crimson_roots: NETHER_MATERIALS_CHEST,
  warped_roots: NETHER_MATERIALS_CHEST, crimson_fungus: NETHER_MATERIALS_CHEST,
  warped_fungus: NETHER_MATERIALS_CHEST, nether_sprouts: NETHER_MATERIALS_CHEST,
  twisting_vines: NETHER_MATERIALS_CHEST,

  // Kayu batang (log) - dikunci eksplisit ke LOGS_CHEST supaya tidak nyasar lagi
  oak_log: LOGS_CHEST, spruce_log: LOGS_CHEST, birch_log: LOGS_CHEST, jungle_log: LOGS_CHEST,
  acacia_log: LOGS_CHEST, dark_oak_log: LOGS_CHEST, cherry_log: LOGS_CHEST, mangrove_log: LOGS_CHEST,
  crimson_stem: LOGS_CHEST, warped_stem: LOGS_CHEST,

  // Papan kayu (planks) - dikunci eksplisit ke PLANKS_CHEST
  oak_planks: PLANKS_CHEST, spruce_planks: PLANKS_CHEST, birch_planks: PLANKS_CHEST, jungle_planks: PLANKS_CHEST,
  acacia_planks: PLANKS_CHEST, dark_oak_planks: PLANKS_CHEST, cherry_planks: PLANKS_CHEST, mangrove_planks: PLANKS_CHEST,

  // Kayu olahan lain (WOOD_BLOCKS_CHEST) - log yang dikupas kulitnya (stripped) dan produk kayu
  // lain di luar log/planks/sapling mentah - melengkapi kolom z=-347 supaya murni tema kayu.
  stripped_oak_log: WOOD_BLOCKS_CHEST, stripped_spruce_log: WOOD_BLOCKS_CHEST, stripped_birch_log: WOOD_BLOCKS_CHEST,
  stripped_jungle_log: WOOD_BLOCKS_CHEST, stripped_acacia_log: WOOD_BLOCKS_CHEST, stripped_dark_oak_log: WOOD_BLOCKS_CHEST,
  stripped_cherry_log: WOOD_BLOCKS_CHEST, stripped_mangrove_log: WOOD_BLOCKS_CHEST,
  spruce_trapdoor: WOOD_BLOCKS_CHEST, oak_trapdoor: WOOD_BLOCKS_CHEST, spruce_slab: WOOD_BLOCKS_CHEST,
  oak_boat: WOOD_BLOCKS_CHEST, oak_stairs: WOOD_BLOCKS_CHEST,

  // Blok utilitas/workstation (konsolidasi dengan dispenser/observer/chest cadangan - membebaskan
  // 2 slot yang tadinya masing-masing cuma diisi satu jenis blok saja, dipakai untuk kategori baru
  // senjata & drop langka di atas)
  scaffolding: UTILITY_BLOCKS_CHEST, crafting_table: UTILITY_BLOCKS_CHEST, dispenser: UTILITY_BLOCKS_CHEST,
  observer: UTILITY_BLOCKS_CHEST, chest: UTILITY_BLOCKS_CHEST, lantern: UTILITY_BLOCKS_CHEST,
  sticky_piston: UTILITY_BLOCKS_CHEST, piston: UTILITY_BLOCKS_CHEST, redstone_torch: UTILITY_BLOCKS_CHEST,
  repeater: UTILITY_BLOCKS_CHEST, hopper: UTILITY_BLOCKS_CHEST,

  // Drop langka & curio bernilai (bukan pernak-pernik biasa)
  totem_of_undying: RARE_DROPS_CHEST, music_disc_cat: RARE_DROPS_CHEST, music_disc_otherside: RARE_DROPS_CHEST,
  name_tag: RARE_DROPS_CHEST, lead: RARE_DROPS_CHEST, saddle: RARE_DROPS_CHEST, emerald: RARE_DROPS_CHEST,

  // Rel & minecart
  rail: RAILS_MINECART_CHEST, powered_rail: RAILS_MINECART_CHEST, detector_rail: RAILS_MINECART_CHEST,
  activator_rail: RAILS_MINECART_CHEST, chest_minecart: RAILS_MINECART_CHEST,

  // Hasil panen utama - masing-masing chest sendiri, dikunci eksplisit supaya tidak nyasar lagi
  wheat: WHEAT_CHEST, carrot: CARROT_CHEST, potato: POTATO_CHEST, poisonous_potato: POTATO_CHEST,

  // Dirt/sand/gravel bulk
  dirt: DIRT_SAND_CHEST, grass_block: DIRT_SAND_CHEST,

  // Batu/cobble bulk - SEMUA terdaftar ke chest utama; overflow cuma darurat lewat
  // OVERFLOW_CHESTS di bawah.
  stone: STONE_COBBLE_CHEST, cobblestone: STONE_COBBLE_CHEST, mossy_cobblestone: STONE_COBBLE_CHEST,
  cobbled_deepslate: STONE_COBBLE_CHEST,
  gravel: STONE_COBBLE_CHEST, tuff: STONE_COBBLE_CHEST,
  granite: STONE_COBBLE_CHEST, diorite: STONE_COBBLE_CHEST, andesite: STONE_COBBLE_CHEST
};

// Pemetaan chest UTAMA -> chest CADANGAN DARURAT - dipakai StorageManagerEngine HANYA saat chest
// utama genuinely tidak bisa menerima (penuh/rusak), tidak pernah jadi rumah permanen item apapun
// (lihat resolveChestForItem) - permintaan nyata pemilik: "make the overflow chest is for
// emergency only when the actual cest is full".
const OVERFLOW_CHESTS = {
  [PROCESSED_ORE_CHEST]: PROCESSED_ORE_OVERFLOW_CHEST,
  [MOB_DROPS_CHEST]: MOB_DROPS_OVERFLOW_CHEST,
  [SEEDS_CHEST]: SEEDS_OVERFLOW_CHEST,
  [STONE_COBBLE_CHEST]: STONE_COBBLE_OVERFLOW_CHEST,
  [WOOD_BLOCKS_CHEST]: WOOD_BLOCKS_OVERFLOW_CHEST
};

const DEFAULT_BASE_GOAL = { x: -185, y: 71, z: -352 };
// Ruang penyimpanan di dalam rumah - dipakai StorageManagerEngine untuk membedakan chest gudang
// (tujuan pengantaran/rapi-rapi) dari chest lain di luar rumah (sumber koleksi). Perkiraan awal di
// sekitar base (-185,71,-352). Pemilik mengonfirmasi live: SEMUA chest pada RENTANG KETINGGIAN
// (y) ini adalah gudang, apapun posisi x/z-nya - bukan kotak x/z sempit seperti dugaan awal (yang
// justru salah mengira sebagian chest gudang sungguhan sebagai chest "di luar rumah", membuat
// isinya diambil & dipindah - bug nyata yang dilaporkan pemilik). x/z sengaja DIBIARKAN SANGAT
// LEBAR (praktis tak terbatas) - cuma y yang benar-benar membedakan gudang dari chest luar.
const DEFAULT_HOUSE_BOUNDS = {
  min: { x: Number(process.env.STORAGE_HOUSE_MIN_X) || -1000000, y: Number(process.env.STORAGE_HOUSE_MIN_Y) || 70, z: Number(process.env.STORAGE_HOUSE_MIN_Z) || -1000000 },
  max: { x: Number(process.env.STORAGE_HOUSE_MAX_X) || 1000000, y: Number(process.env.STORAGE_HOUSE_MAX_Y) || 76, z: Number(process.env.STORAGE_HOUSE_MAX_Z) || 1000000 }
};

function buildMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  // Pemilik mengonfirmasi live: setiap chest gudang bisa dijangkau jalan kaki biasa, TANPA perlu
  // menaruh blok tambahan (mis. bikin tower 1x1 buat naik). Matikan kemampuan menaruh blok sama
  // sekali - kalau pathfinder sampai butuh menaruh blok untuk mencapai suatu chest, itu tandanya
  // ada masalah lain (posisi/jalur salah), bukan sesuatu yang memang perlu "dipecahkan" dengan
  // membangun - jangan buang-buang blok inventaris atau membangun struktur yang tidak diminta.
  movements.scafoldingBlocks = [];
  movements.allow1by1towers = false;
  return movements;
}

function startStorageWorker({ host, port, botName, scanRadius = 48, baseGoal = DEFAULT_BASE_GOAL, houseBounds = DEFAULT_HOUSE_BOUNDS, log = (m) => console.log(m), onDisconnect = () => {}, onMisplaced = () => {}, onChestSnapshot = () => {} }) {
  const bot = mineflayer.createBot({
    host, port,
    username: botName || 'StorageWorker',
    version: SERVER_VERSION,
    auth: 'offline',
    plugins: { time: false }
  });

  let engine = null;
  let stopped = false;
  let timer = null;
  let lastAction = 'CONNECTING';

  bot.once('spawn', async () => {
    bot.loadPlugin(pathfinder);
    bot.pathfinder.setMovements(buildMovements(bot));
    bot.pathfinder.thinkTimeout = 20000;
    log(`Spawn di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) - menunggu chunk sekitar ter-load...`);

    const walkResult = await walkToBase({ bot, goal: baseGoal, range: 4, settleMs: 5000, log });
    if (!walkResult.success) {
      log(`PERINGATAN: gagal berjalan ke base (${walkResult.reason}) - tetap mulai bekerja di posisi sekarang.`);
    }
    // walkToBase() MENIMPA movements bot dengan miliknya sendiri (allow1by1towers:true, scaffolding
    // dirt/cobblestone default - sengaja, supaya perjalanan awal 350+ blok dari spawn bisa membangun
    // jalan kalau benar-benar buntu) - tapi timpaan itu TERUS BERLAKU untuk semua navigasi
    // SESUDAHNYA juga (termasuk ke chest gudang yang sebenarnya sudah terjangkau jalan kaki biasa)
    // kalau tidak dipulihkan di sini. Pasang lagi movements TANPA taruh blok milik worker ini -
    // ditemukan dari keluhan nyata pemilik: "storage worker tetap berusaha memasang block padahal
    // cest terjangkau" - root cause-nya persis ini, bukan buildMovements() yang salah.
    bot.pathfinder.setMovements(buildMovements(bot));

    const adapter = new MineflayerRoleAdapter(bot, { log });

    const bedResult = await adapter.setSpawnAtNearestBed();
    log(bedResult ? 'Spawn point diset di bed dekat base.' : 'Tidak ada bed dalam jangkauan - spawn point tidak diubah.');

    const initialAssignments = { ...loadAssignments(log), ...CANONICAL_ORE_INGOT_ASSIGNMENTS, ...CANONICAL_GEAR_ASSIGNMENTS };
    if (Object.keys(initialAssignments).length > 0) {
      log(`Muat memori sortir gudang: ${Object.keys(initialAssignments).length} jenis item sudah punya chest langganan (termasuk rumah baku ore/ingot dan gear/makanan/buku).`);
    }
    engine = new StorageManagerEngine({ adapter, scanRadius, houseBounds, initialAssignments, overflowChests: OVERFLOW_CHESTS });
    engine.on('collected', ({ position, count }) => log(`Ambil ${count} item dari chest luar di (${position.x},${position.y},${position.z})`));
    engine.on('delivered', ({ position, count, name }) => {
      log(`Antar ${count}x ${name} ke chest gudang di (${position.x},${position.y},${position.z})`);
      saveAssignments(engine.getChestAssignments(), log);
    });
    engine.on('inspected', ({ position, items }) => log(`Periksa chest gudang di (${position.x},${position.y},${position.z}) - isi: ${items.map((i) => `${i.name}x${i.count}`).join(', ') || '(kosong)'}`));
    engine.on('deliverFailed', ({ position, error, name }) => log(`Gagal antar ${name} ke chest gudang di (${position.x},${position.y},${position.z}) - ${error} - coba chest lain di tick berikutnya.`));
    engine.on('chestError', ({ position, error }) => log(`Chest di (${position.x},${position.y},${position.z}) gagal dibuka (${error}) - dilewati, lanjut ke chest lain.`));
    engine.on('misplaced', ({ position, item, count, correctPosition }) => {
      log(`Item SALAH TEMPAT: ${count}x ${item} di (${position.x},${position.y},${position.z}) - diambil, akan diantar ke (${correctPosition.x},${correctPosition.y},${correctPosition.z})`);
      // Dipakai panel "Kepatuhan Kategori Gudang" di dashboard - permintaan nyata pemilik: chest
      // yang belum sesuai aturan kategori harus tercatat, supaya terlihat tanpa perlu scan manual.
      onMisplaced({ botName: botName || 'StorageWorker', position, item, count, correctPosition, timestamp: Date.now() });
    });
    engine.on('chestSnapshot', ({ position, items, misplaced }) => {
      // Dipakai panel peta gudang di dashboard - permintaan nyata pemilik: "di ui web tampilkan
      // isi semua peti...dan bagaimana bot akan memindahkannya di tandai dengan panah panah".
      onChestSnapshot({ position, items, misplaced, timestamp: Date.now() });
    });

    log('Pekerja gudang mulai bekerja.');
    lastAction = 'WORKING';
    async function tick() {
      if (stopped) return;
      try {
        const result = await engine.tick();
        if (result.action !== 'idle') lastAction = result.action.toUpperCase();
      } catch (e) {
        log(`ERROR di tick gudang (non-fatal, lanjut tick berikutnya): ${e.message}`);
      }
      // Cek lagi SESUDAH await (bukan cuma di awal fungsi) - koneksi bisa saja terputus SAAT
      // engine.tick() sedang menunggu (mis. chest open yang macet 20 detik lalu timeout tepat
      // ketika bot disconnect) - tanpa ini, satu tick tambahan tetap terjadwal walau worker
      // sebenarnya sudah berhenti.
      if (stopped) return;
      timer = setTimeout(tick, TICK_INTERVAL_MS);
    }
    tick();
  });

  bot.on('error', (e) => log(`ERROR: ${e.message}`));
  bot.on('kicked', (r) => log(`DIKICK: ${JSON.stringify(r)}`));
  bot.on('end', (reason) => {
    if (stopped) return;
    log(`Koneksi terputus tak terduga (${reason || 'tidak diketahui'}) - worker berhenti.`);
    stopped = true;
    if (timer) clearTimeout(timer);
    onDisconnect();
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      bot.quit();
    },
    getMetrics() {
      if (!engine) return null;
      return { storage: engine.metrics };
    },
    // Memori sortir MENTAH, verbatim dari engine.getChestAssignments() - permintaan nyata
    // pemilik: "harusnya yang tampil di web itu sama persis dengan memory worker nya". Dipakai
    // dashboard supaya yang ditampilkan bukan turunan/olahan, tapi persis objek yang sama yang
    // engine pakai sendiri untuk memutuskan ke mana tiap jenis item pergi.
    getAssignments() {
      if (!engine) return null;
      return engine.getChestAssignments();
    },
    getStatus() {
      return {
        role: 'Kuartermaster',
        position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        health: bot.health ?? null,
        status: lastAction,
        inventory: bot.inventory ? bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) : []
      };
    }
  };
}

module.exports = { startStorageWorker };

if (require.main === module) {
  startStorageWorker({
    host: process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(process.env.MC_PORT) || 25565,
    botName: process.env.MC_BOT_NAME || 'StorageWorker',
    scanRadius: Number(process.env.STORAGE_SCAN_RADIUS) || 48
  });
}
