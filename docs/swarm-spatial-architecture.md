# Analisis spasial dan koordinasi swarm

## Kontrak

Koordinat menyatakan tujuan atau izin kerja, bukan bukti keterjangkauan. Blok dari
chunk yang belum diketahui tidak dianggap udara. Klasifikasi berisi hipotesis dan
bukti, bukan instruksi untuk membongkar area. Tidak ada classifier yang dapat
menjamin mengenali semua struktur buatan pemain; kategori unknown wajib tersedia.

## Implementasi saat ini

- Semua bot yang memakai MineflayerRoleAdapter memasang observer dan koordinasi
  pada instance bot. Aksi dig/placeBlock/openChest/openContainer/openFurnace juga
  terlindungi ketika dipanggil langsung, setelah adapter dibuat.
- Observer menganalisis volume 9x7x9 setiap 15 detik; memori menyimpan observasi
  semantik berdimensi dunia, observer, waktu, batas XYZ dan coverage. Ini bukan
  klaim bahwa seluruh bangunan sudah terlihat.
- Geometri mengenali komponen udara tertutup pada keenam sisi yang diketahui.
  Ruang dengan pintu terbuka atau batas tak terlihat belum dianggap tertutup.
- Kategori: crop farm, storage, workshop, smeltery, kandidat rumah, area villager,
  kandidat trading hall/breeder/iron farm/mob farm/kandang, portal, rel, redstone,
  air, lava, kandidat bekas galian, kandidat struktur, dan unknown.
- Kategori boleh tumpang tindih. Skor heuristik bukan probabilitas terkalibrasi.
- Reservasi SQLite bersifat all-or-nothing untuk seluruh sel yang diminta.
  Identitas owner adalah sesi UUID, bukan nama bot yang dapat dipakai ulang.
- Lease 30 detik diperbarui tiap 5 detik. Gagal renew menghentikan navigasi/dig.
  Release memakai token; pemilik lama tidak dapat melepas reservasi sesi baru.
- Peti/furnace ditahan sampai window ditutup. Peti bersebelahan dikunci bersama
  secara konservatif untuk mencegah double chest dipakai melalui sisi berbeda.
- Navigasi lokal yang dianalisis memakai reservasi pijakan, ruang kepala, dan
  support sepanjang rute. Pathfinder dibatasi ke rute itu selama eksekusi.
- API GET /api/world-analysis dan /api/reservations menyediakan bukti runtime.

## Pembaruan Integrasi

- Registry voxel sekarang memberikan ID tetap lintas pengamatan untuk komponen
  storage, cultivation, smelting, workstation, railway, redstone, portal, building.
  Komponen dapat menyatu atau terbelah ketika penghubung berubah. ID ini milik
  komponen fisik, bukan jaminan satu komponen selalu sama dengan satu bangunan.
- PATCH /api/structures/:id/label menyimpan label pengguna; GET /api/world-analysis
  mengembalikan daftar komponen, revision, batas XYZ dan jumlah voxel.
- Okupansi kaki/kepala diperbarui setiap 500 ms, berlaku 5 detik, termasuk saat idle.
  Akuisisi reservasi memeriksa okupansi dan lease bot lain.
- Wait graph mendeteksi siklus saling menunggu dan mengembalikan DEADLOCK_REPLAN;
  aksi dibatalkan, tidak memaksa bot melewati bot lain. Ini bukan jaminan fairness.
- Goto langsung pada instance pathfinder yang sudah dipasangi adapter kini dipantau:
  rencana dari library dipecah maksimum 128 node per segmen, semua selnya direservasi,
  dan jalur dibatasi ke hasil tersebut. Maksimum 8 segmen per panggilan. Gerakan
  yang memerlukan perubahan medan atau drop lebih dari satu blok ditolak untuk
  ditangani planner pekerjaan, bukan dilakukan otomatis tanpa izin.
- Riwayat perubahan crop_removed/crop_planted memberi bukti temporal untuk farm
  tanaman. Kemunculan entitas akibat chunk loading tidak dianggap bukti breeding.
- Validasi: 352 tes AI lulus. Probe Minecraft read-only membuktikan okupansi dua sel,
  penyimpanan analisis, serta pembersihan sesi saat disconnect. Tidak ada mutasi world.

## Batas Sistem

- Komponen fisik dan label sudah persisten, tetapi pengelompokan semantik seluruh
  bangunan beserta lantai/ruangan lintas komponen belum terverifikasi. Observasi
  semantik mempunyai waktu dan kedaluwarsa setelah 24 jam; gunakan voxel terkini
  sebelum aksi, bukan percaya snapshot semantik lama.
- Breeding, trading dan siklus spawn memerlukan bukti temporal. Deteksi sekarang
  hanya mengeluarkan kandidat, tidak mengklaim fungsi farm terverifikasi.
- Gerakan manual lewat control state atau setGoal yang melewati goto masih di luar
  reservasi jalur. Bot tanpa adapter tidak ikut protokol koordinasi ini.
- Bot/player eksternal tidak tunduk pada reservasi. Bot idle belum memiliki
  okupansi setelah heartbeat kedaluwarsa. Lease bukan kunci server Minecraft.
- Belum ada scheduler antrean adil atau MAPF berbasis waktu. Deteksi siklus adalah
  fail-safe, bukan pemecahan semua deadlock secara otomatis; replanning dapat tetap
  gagal jika tidak ada tempat berpapasan. Caller dapat mengulang tick berikutnya.
- Semua proses harus memakai file SQLite lokal dan MC_WORLD_ID yang sama. Ini
  belum layanan koordinasi lintas host. Observer dinonaktifkan berarti aksi tidak
  dikoordinasikan melalui modul ini.

## Tahapan penyelesaian sistem penuh

1. Migrasikan semua gerakan langsung/runner ke adapter dan tambah okupansi bot idle.
2. Satukan pengamatan ke objek bangunan berversi, room graph, pintu dan lantai;
   tambahkan label pengguna serta invalidasi berdasarkan perubahan voxel.
3. Tambahkan pengamatan temporal untuk farm dan penilaian dataset berlabel pengguna.
4. Tambahkan antrean adil, prioritas keselamatan, deteksi deadlock dan replanning
   jalur global yang menyambung reservasi lokal tanpa celah.
5. Uji dua bot berpapasan di lorong, crash pemilik lock, pergantian dimensi,
   ledakan creeper, perubahan rute oleh player, dan stress test bertahap 4/8/16 bot.

Jangan menaikkan populasi menuju 200 bot sebelum throughput, waktu tunggu dan
konflik fisik diukur. Tes unit bukan bukti semua skenario survival sudah berhasil.
