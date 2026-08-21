/**
 * @file storageMemory.js
 * @description Memori sortir gudang - jenis item mana pergi ke chest mana, dan nama kategori
 * manusiawinya - DIBAGIKAN ke SEMUA bot, bukan cuma StorageWorker. Permintaan nyata pemilik:
 * "share memory tentang peti ke semua bot agar dapat mencari barang barang dan menaruh barang
 * dengan tepat". Sebelumnya semua konstanta ini didefinisikan LANGSUNG di dalam
 * runStorageWorker.js - worker lain (FarmerWorker dst) tidak punya akses sama sekali, jadi
 * terpaksa menebak lewat pemindaian chest satu-satu (findMatchingChest, buka tiap chest sampai
 * ketemu yang isinya cocok) tiap kali mau menyimpan/mengambil barang - lebih lambat DAN bisa
 * salah pilih chest (mis. kebetulan menemukan chest yang isinya nyasar, bukan rumah baku yang
 * benar). Modul ini jadi SATU sumber kebenaran yang bisa di-require dari worker manapun.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const fs = require('fs');
const path = require('path');

// Memori "jenis item ini pergi ke chest itu" yang DIPELAJARI (bukan rumah baku) DISIMPAN KE DISK -
// supaya sortir tetap konsisten lintas restart worker (tanpa ini, StorageManagerEngine cuma ingat
// assignment SELAMA proses ini hidup - begitu dashboard di-restart, semua memori hilang dan chest
// bisa dipilih beda-beda lagi tiap kali) - ditemukan dari keluhan nyata pemilik: "does not have
// any memory about storage chest".
const ASSIGNMENTS_FILE = process.env.STORAGE_ASSIGNMENTS_FILE || path.join(__dirname, '..', '..', 'data', 'storageChestAssignments.json');

function loadLearnedAssignments(log = () => {}) {
  try {
    if (!fs.existsSync(ASSIGNMENTS_FILE)) return {};
    return JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, 'utf8'));
  } catch (e) {
    log(`PERINGATAN: gagal memuat memori sortir gudang dari disk (${e.message}) - mulai dari kosong.`);
    return {};
  }
}

function saveLearnedAssignments(assignments, log = () => {}) {
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
// Cadangan DARURAT untuk RAW_ORE_CHEST - ditemukan dari keluhan nyata pemilik lewat pemantauan
// live langsung ("bot tidak melakukan apa apa antara membuka hingga menutup peti"): redstone
// macet (RAW_ORE_CHEST kronis penuh) tanpa overflow memaksa resolveChestForItem scan SEMUA
// chest gudang berulang-ulang tanpa hasil. Barel di x=-180,z=-351,y73 (mirror dari barel x=-181
// yang sudah dipakai kategori lain, standalone/tidak pernah menyatu dengan blok manapun -
// dikonfirmasi lewat probe: gudang punya barisan barel kedua di x=-180 yang belum dipakai
// kategori apapun) dipakai sebagai tempat daruratnya.
const RAW_ORE_OVERFLOW_CHEST = '-180,73,-351'; // barrel
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
// Cadangan DARURAT untuk BOOKS_CHEST - ditemukan dari keluhan nyata pemilik lewat pemantauan
// live langsung ("bot tidak melakukan apa apa antara membuka hingga menutup peti"): tanpa
// overflow, enchanted_book yang macet (BOOKS_CHEST kronis penuh) memaksa resolveChestForItem
// mengulang scan SEMUA chest gudang (mencari yang genuinely kosong, yang tidak akan pernah
// ketemu di gudang yang sudah rapi) di SETIAP percobaan - 130+ chest dibuka tanpa hasil apapun,
// terlihat seperti bot "diam" padahal sedang sia-sia mencari. Barel di z=-351,y73 (standalone,
// belum dipakai kategori manapun) dipakai sebagai tempat daruratnya.
const BOOKS_OVERFLOW_CHEST = '-181,73,-351'; // barrel
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
// y74,-349 dulu sengaja dibiarkan sebagai ruang cadangan - sekarang dipakai untuk beetroot
// (hasil panen, BUKAN beetroot_seeds yang sudah punya rumah sendiri di SEEDS_CHEST) - ditemukan
// dari bug live nyata: "kenapa farming workernya tidak bisa menaruh barangnya di peti". beetroot
// TIDAK PERNAH terdaftar di mana pun sebelumnya, jadi setiap kali dipanen selalu jatuh ke live-
// scan findMatchingChest yang TIDAK PERNAH berhasil (tidak ada chest yang PERNAH berisi beetroot
// untuk dicocokkan - masalah ayam-telur) - menumpuk sampai 800+ beetroot di tas tanpa pernah
// tersetor, ikut menyumbat slot inventaris sehingga item lain juga tidak sempat kebagian giliran.
const BEETROOT_CHEST = '-181,74,-349';
const LOGS_CHEST = '-181,74,-347';
const RARE_DROPS_CHEST = '-181,74,-345';

// Double chest & barel TAMBAHAN yang ditaruh pemilik langsung ("saya menaruh beberapa lagi double
// peti di area itu kamu bisa ekspan lagi storage nya terutama untuk item yang jumlah nya banyak") -
// dikonfirmasi lewat query-blocks live (bukan tebakan): 7 double chest baru + 3 barel baru,
// SEMUANYA di kolom z yang sebelumnya kosong pada x=-181/-180 (bukan kolom/x baru). Diprioritaskan
// untuk item hasil panen bervolume tinggi (potato/carrot/wheat/beetroot - sudah 3 FarmerWorker
// jalan paralel sekarang, panen jauh lebih cepat dari sebelumnya) dan kategori lain yang selama ini
// TIDAK PUNYA cadangan darurat sama sekali (dirt/log/hasil sampingan panen).
const POTATO_OVERFLOW_CHEST = '-181,71,-350';
const CARROT_OVERFLOW_CHEST = '-181,72,-348';
// Awalnya dialokasikan untuk dirt/logs/wheat/hasil sampingan panen, tapi DIALIHKAN SEMUANYA ke
// rantai cadangan untuk batu & cobblestone (dan turunannya - granite/diorite/andesite/deepslate/
// tuff/gravel, SEMUA berbagi satu STONE_COBBLE_CHEST) - ditemukan dari pemantauan live LANGSUNG
// pemilik: "storage worker nya tetap stuck di batu" bahkan SETELAH 3 tingkat overflow pertama
// (reorganized:1151x - tanda thrashing berat, worker berulang-ulang ambil-taruh tanpa progres).
// Gudang fisik sudah diperiksa ULANG (query-blocks y70-76, area luas) - TIDAK ADA chest/barel lain
// yang belum terdaftar, jadi kapasitas tambahan HARUS datang dari mengorbankan kategori lain.
// Dirt/logs/wheat/hasil sampingan panen dipilih karena TIDAK PERNAH terbukti kritis lewat
// pemantauan live (beda dari potato/carrot/beetroot yang masing-masing punya bukti nyata pernah
// menumpuk parah) - permintaan nyata pemilik: "kan tadi saya menambahkan peti kan barusan kalau
// tidak salah 7 itu gunakan beberapa [untuk batu]".
const STONE_COBBLE_OVERFLOW_2_CHEST = '-181,73,-348';
const STONE_COBBLE_OVERFLOW_3_CHEST = '-181,73,-346';
const STONE_COBBLE_OVERFLOW_4_CHEST = '-181,72,-346'; // dulu WHEAT_OVERFLOW_CHEST
const STONE_COBBLE_OVERFLOW_5_CHEST = '-181,74,-348'; // dulu FARMING_BYPRODUCTS_OVERFLOW_CHEST
const BEETROOT_OVERFLOW_CHEST = '-181,74,-346';
const ARMOR_OVERFLOW_CHEST = '-180,71,-351'; // barrel
const TOOLS_OVERFLOW_CHEST = '-180,71,-348'; // barrel
const TRINKETS_OVERFLOW_CHEST = '-180,71,-346'; // barrel

// Nama kategori manusiawi per posisi chest - permintaan nyata pemilik: "di ui tampilan peti nya
// rapikan urut baris dan kolom nya dan berikan nama kategorinya". `mirror: false` untuk barel
// (armor/buku/perkakas/cadangan) karena barel TIDAK PERNAH menyatu fisik dengan blok lain (lihat
// koreksi besar di atas dekat PROCESSED_ORE_CHEST) - x=-180 di posisi yang sama TIDAK mewarisi
// label barel itu. Chest sungguhan (bukan barel) mewarisi label yang SAMA ke pasangan double-
// chest fisiknya di x+1 (mis. -181 -> -180) supaya dashboard menampilkan satu wadah fisik sebagai
// satu kategori, bukan dua nama berbeda untuk dua separuh chest yang sama.
const CHEST_CATEGORIES = [
  { pos: PROCESSED_ORE_CHEST, label: 'Bahan Berharga (Ore Olahan)' },
  { pos: RAW_ORE_CHEST, label: 'Bijih Mentah' },
  { pos: RAW_ORE_OVERFLOW_CHEST, label: 'Cadangan Bijih Mentah', mirror: false },
  { pos: PROCESSED_ORE_OVERFLOW_CHEST, label: 'Cadangan Bahan Berharga' },
  { pos: NETHER_MATERIALS_CHEST, label: 'Material Nether' },
  { pos: STONE_COBBLE_CHEST, label: 'Batu & Cobblestone' },
  { pos: MOB_DROPS_OVERFLOW_CHEST, label: 'Cadangan Drop Mob' },
  { pos: SEEDS_OVERFLOW_CHEST, label: 'Cadangan Benih' },
  { pos: STONE_COBBLE_OVERFLOW_CHEST, label: 'Cadangan Batu & Cobblestone' },
  { pos: ARMOR_CHEST, label: 'Armor', mirror: false },
  { pos: MOB_DROPS_CHEST, label: 'Drop Mob' },
  { pos: BOOKS_CHEST, label: 'Buku', mirror: false },
  { pos: BOOKS_OVERFLOW_CHEST, label: 'Cadangan Buku', mirror: false },
  { pos: TOOLS_CHEST, label: 'Perkakas', mirror: false },
  { pos: FOOD_CHEST, label: 'Makanan' },
  { pos: RAILS_MINECART_CHEST, label: 'Rel & Minecart' },
  { pos: WEAPONS_CHEST, label: 'Senjata' },
  { pos: SEEDS_CHEST, label: 'Benih' },
  { pos: FARMING_BYPRODUCTS_CHEST, label: 'Hasil Sampingan Panen' },
  { pos: SAPLINGS_PLANTS_CHEST, label: 'Bibit & Tanaman' },
  { pos: WOOD_BLOCKS_CHEST, label: 'Kayu Olahan' },
  { pos: WOOD_BLOCKS_OVERFLOW_CHEST, label: 'Cadangan Kayu Olahan', mirror: false },
  { pos: TRINKETS_CHEST, label: 'Pernak-pernik' },
  { pos: BUILDING_MATERIALS_CHEST, label: 'Bahan Bangunan' },
  { pos: WHEAT_CHEST, label: 'Gandum' },
  { pos: CARROT_CHEST, label: 'Wortel' },
  { pos: PLANKS_CHEST, label: 'Papan Kayu' },
  { pos: UTILITY_BLOCKS_CHEST, label: 'Blok Utilitas' },
  { pos: DIRT_SAND_CHEST, label: 'Tanah & Pasir' },
  { pos: POTATO_CHEST, label: 'Kentang' },
  { pos: BEETROOT_CHEST, label: 'Beetroot' },
  { pos: LOGS_CHEST, label: 'Kayu Gelondongan (Log)' },
  { pos: RARE_DROPS_CHEST, label: 'Drop Langka' },
  { pos: POTATO_OVERFLOW_CHEST, label: 'Cadangan Kentang' },
  { pos: CARROT_OVERFLOW_CHEST, label: 'Cadangan Wortel' },
  { pos: STONE_COBBLE_OVERFLOW_2_CHEST, label: 'Cadangan Batu & Cobblestone (2)' },
  { pos: STONE_COBBLE_OVERFLOW_3_CHEST, label: 'Cadangan Batu & Cobblestone (3)' },
  { pos: STONE_COBBLE_OVERFLOW_4_CHEST, label: 'Cadangan Batu & Cobblestone (4)' },
  { pos: STONE_COBBLE_OVERFLOW_5_CHEST, label: 'Cadangan Batu & Cobblestone (5)' },
  { pos: BEETROOT_OVERFLOW_CHEST, label: 'Cadangan Beetroot' },
  { pos: ARMOR_OVERFLOW_CHEST, label: 'Cadangan Armor', mirror: false },
  { pos: TOOLS_OVERFLOW_CHEST, label: 'Cadangan Perkakas', mirror: false },
  { pos: TRINKETS_OVERFLOW_CHEST, label: 'Cadangan Pernak-pernik', mirror: false }
];

function buildChestCategoryLabels() {
  const labels = {};
  for (const { pos, label, mirror } of CHEST_CATEGORIES) {
    labels[pos] = label;
    if (mirror !== false) {
      const [x, y, z] = pos.split(',').map(Number);
      const mirrorKey = `${x + 1},${y},${z}`;
      if (!(mirrorKey in labels)) labels[mirrorKey] = label;
    }
  }
  return labels;
}

const CHEST_CATEGORY_LABELS = buildChestCategoryLabels();

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
  beetroot: BEETROOT_CHEST,

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
  // RAW_ORE_CHEST -> RAW_ORE_OVERFLOW_CHEST sempat celah nyata: konstanta RAW_ORE_OVERFLOW_CHEST
  // sudah lama didefinisikan (lihat komentarnya di atas, ditulis khusus untuk redstone yang macet)
  // tapi tidak pernah benar-benar dipasangkan ke sini, jadi RAW_ORE_CHEST sebenarnya TIDAK PERNAH
  // punya cadangan darurat sama sekali walau terlihat seperti sudah ada - baru ketahuan saat
  // memori ini dibagikan ke worker lain dan diverifikasi ulang lewat tes.
  [RAW_ORE_CHEST]: RAW_ORE_OVERFLOW_CHEST,
  [MOB_DROPS_CHEST]: MOB_DROPS_OVERFLOW_CHEST,
  [SEEDS_CHEST]: SEEDS_OVERFLOW_CHEST,
  [STONE_COBBLE_CHEST]: STONE_COBBLE_OVERFLOW_CHEST,
  [WOOD_BLOCKS_CHEST]: WOOD_BLOCKS_OVERFLOW_CHEST,
  [BOOKS_CHEST]: BOOKS_OVERFLOW_CHEST,
  // Buku tingkat KEDUA - permintaan nyata pemilik langsung: "enchantment book perlu tempat lagi
  // juga coba optimalkan barel barel itu". Dicek live lewat storage/chests: BOOKS_CHEST 25/27 dan
  // BOOKS_OVERFLOW_CHEST 8/27 (enchanted_book stackSize:1 - SATU item = SATU slot, jadi cepat
  // penuh walau jumlah "barang"-nya kelihatan sedikit). TRINKETS_OVERFLOW_CHEST dipilih sebagai
  // rantai kedua karena TRINKETS_CHEST utamanya sendiri masih longgar (12/27) - barel ini nyaris
  // tidak terpakai (1/27) walau sudah terdaftar untuk trinkets, aman dipakai BERSAMA (overflow
  // eksplisit boleh dipakai banyak kategori berbeda sekaligus, lihat walkOverflowChain).
  [BOOKS_OVERFLOW_CHEST]: TRINKETS_OVERFLOW_CHEST,
  // Cadangan BARU dari double chest/barel tambahan yang ditaruh pemilik - permintaan nyata
  // pemilik: "saya menaruh beberapa lagi double peti di area itu kamu bisa ekspan lagi storage
  // nya terutama untuk item yang jumlah nya banyak". POTATO_CHEST/CARROT_CHEST sebelumnya SAMA
  // SEKALI tidak punya cadangan darurat (celah yang sudah diketahui sejak sesi sebelumnya) -
  // sekarang 3 FarmerWorker jalan paralel jadi panen jauh lebih cepat menumpuk.
  [POTATO_CHEST]: POTATO_OVERFLOW_CHEST,
  [CARROT_CHEST]: CARROT_OVERFLOW_CHEST,
  // Batu/cobble & turunannya (granite/diorite/andesite/deepslate/tuff/gravel) BERANTAI 5 tingkat -
  // sebelumnya cuma 1 overflow (STONE_COBBLE_OVERFLOW_CHEST), lalu 3 (masih tidak cukup) - masih
  // TETAP stuck ("storage worker nya tetap stuck di batu", reorganized:1151x). Gudang fisik sudah
  // habis (diperiksa ulang, tidak ada chest lain) - 2 tingkat tambahan ini mengorbankan
  // wheat/hasil-sampingan-panen (tidak pernah terbukti kritis lewat pemantauan live, beda dari
  // potato/carrot/beetroot yang masing-masing punya bukti nyata pernah menumpuk parah).
  [STONE_COBBLE_OVERFLOW_CHEST]: STONE_COBBLE_OVERFLOW_2_CHEST,
  [STONE_COBBLE_OVERFLOW_2_CHEST]: STONE_COBBLE_OVERFLOW_3_CHEST,
  [STONE_COBBLE_OVERFLOW_3_CHEST]: STONE_COBBLE_OVERFLOW_4_CHEST,
  [STONE_COBBLE_OVERFLOW_4_CHEST]: STONE_COBBLE_OVERFLOW_5_CHEST,
  [BEETROOT_CHEST]: BEETROOT_OVERFLOW_CHEST,
  [ARMOR_CHEST]: ARMOR_OVERFLOW_CHEST,
  [TOOLS_CHEST]: TOOLS_OVERFLOW_CHEST,
  [TRINKETS_CHEST]: TRINKETS_OVERFLOW_CHEST
};

// Terjemahkan posisi dari memori bersama (string "x,y,z") jadi objek {x,y,z} yang dipahami adapter
// (bot.openChest dst) - dipakai worker MANAPUN yang membaca getSharedChestAssignments().
function parseChestPositionKey(key) {
  const [x, y, z] = key.split(',').map(Number);
  return { x, y, z };
}

// SATU sumber kebenaran "item ini pergi ke chest itu" untuk SEMUA bot - gabungan memori yang
// DIPELAJARI dari disk (item yang belum punya rumah baku, dipelajari StorageWorker lewat
// pengiriman sungguhan) dengan rumah baku (CANONICAL_*, SELALU menang atas apapun yang mungkin
// keliru tersimpan di disk untuk item yang sama - lihat komentar CANONICAL_ORE_INGOT_ASSIGNMENTS).
// Ini PERSIS urutan merge yang dipakai StorageManagerEngine sendiri (lihat runStorageWorker.js) -
// permintaan nyata pemilik: "share memory tentang peti ke semua bot agar dapat mencari barang
// barang dan menaruh barang dengan tepat".
function getSharedChestAssignments(log = () => {}) {
  return { ...loadLearnedAssignments(log), ...CANONICAL_ORE_INGOT_ASSIGNMENTS, ...CANONICAL_GEAR_ASSIGNMENTS };
}

module.exports = {
  ASSIGNMENTS_FILE,
  loadLearnedAssignments,
  saveLearnedAssignments,
  CANONICAL_ORE_INGOT_ASSIGNMENTS,
  CANONICAL_GEAR_ASSIGNMENTS,
  OVERFLOW_CHESTS,
  CHEST_CATEGORY_LABELS,
  getSharedChestAssignments,
  parseChestPositionKey,
  TOOLS_CHEST,
  WEAPONS_CHEST
};
