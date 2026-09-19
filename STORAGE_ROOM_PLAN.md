# Gudang Baru Minimal 250 Double Chest

Status: pembangunan live masih parsial dan belum selesai. Lokasi dipindahkan 11 blok ke
timur dan seluruh komponen gudang baru memakai origin (-110, 70, -400). Checkpoint dari
origin lama (-121, 70, -400) tidak dipakai ulang.

Pilihan pengguna dikonfirmasi: minimal 250 double chest. Rancangan terpilih
menampung 260 double chest (520 blok chest), empat sayap, berukuran 41 x 45 x 6
blok, dengan total 14040 slot inventori. Generator menggunakan pilihan ini
sebagai default. Tambahan 10 double chest adalah cadangan kapasitas.

## Kapasitas

| Hitungan permintaan | Kapasitas rancangan | Ukuran luar | Stone bricks | Chest | Torch |
| --- | --- | --- | --- | --- | --- |
| Minimal 250 blok chest | 260 blok / 130 double chest | 41 x 23 x 6 | 2373 | 260 | 35 |
| Minimal 250 double chest | 520 blok / 260 double chest | 41 x 45 x 6 | 4353 | 520 | 70 |

Kebutuhan material berasal dari generator, belum termasuk fondasi tambahan di bawah
lantai, jalan penghubung, pengamanan pintu, atau tambahan penerangan hasil verifikasi
light level. Persediaan material server belum diaudit.

Rancangan menggunakan 5 baris rak per sayap, 13 pasangan per baris, dan 2 tingkat
chest. Antar-rak tersedia lorong 3 blok; pasangan chest dipisahkan satu blok.
Chest bagian atas menyisakan ruang kosong. Akses di depan tiap pasangan bebas
blok setinggi pemain. Orientasi dan penyatuan double chest perlu diperiksa di
server setelah penempatan; blueprint bukan perintah /fill.

## Survei Awal dan Relokasi

Survei live dengan Mineflayer dan registry protocol 775 berhasil membaca volume
sekitar base di (-185, 71, -352). Origin kerja sebelumnya adalah (-121, 70, -400),
lalu dipindahkan 11 blok ke timur menjadi (-110, 70, -400). Semua lantai, dinding,
rack chest, lampu, atap, dan pembagian wing dihitung ulang relatif terhadap origin baru.
Kebutuhan fondasi tambahan dihitung per worker dari voxel live, bukan angka tetap dari
survei lama.

Pembaca blok LiveProtocolClient memakai minecraft-data 1.21.1 meskipun koneksi
menargetkan protocol 775. Nama blok dari jalur tersebut tidak dapat dijadikan
bukti lokasi pembangunan aman tanpa verifikasi registry yang sesuai.

Eksekusi parsial sebelumnya sudah memasang sebagian fondasi di area origin lama.
Fondasi lama dibiarkan dan tidak dianggap bagian dari gudang baru; tidak ada penghapusan
otomatis pada relokasi ini.

## Pekerjaan Sebelum Konstruksi

1. Selesai: kapasitas dikonfirmasi minimal 250 double chest.
2. Selesai: survei voxel sekitar base memakai registry sesuai server; kandidat
   dibandingkan berdasarkan bangunan, kebun, air, elevasi, dan ruang kosong.
3. Selesai: builder mendukung excavate blok natural dan filling fondasi, dengan
   batas kedalaman 16 blok, whitelist material, checkpoint, serta stop pada cairan
   atau blok yang tidak dikenal.
4. Selesai: runner memiliki jalur restock makanan, stone bricks, dan crafting dari stone;
   akses sumber tetap memakai lock heartbeat lintas-worker.
5. Selesai: dua worker live pernah memasang fondasi secara terkoordinasi. Checkpoint
   terakhir yang tersimpan: worker 1 = 87 blok, worker 2 = 56 blok, keduanya masih fase
   foundation. Angka ini bukan bukti ruangan selesai.
6. Selesai: supervisor menunggu SLP protocol 775 sehat lalu me-resume swarm; swarm kini
   dapat dikonfigurasi 1-4 worker, membagi rentang z tanpa memotong pasangan chest,
   memakai checkpoint per worker, dan men-stagger start agar beban koneksi lebih rendah.
7. Tertahan sampai landscaping origin baru lulus: ratakan kolom tinggi/rendah dengan
   worker landscaping terpisah, lalu lanjutkan lantai, dinding, rak, penerangan, dan atap;
   setelah itu audit 520 chest block, state `left/right` untuk 260 pasangan double chest,
   light level, jalur akses,
   dan registrasi storage.

8. Coordinator dashboard kini melakukan SLP preflight protocol 775 sebelum spawn role.
   TCP port yang terbuka tetapi handshake reset/timeout menghasilkan `503` retryable dan
   tidak membuat child bot. Jika koneksi role terputus setelah sesi dimulai, hanya role
   yang terdampak yang di-retry dengan exponential backoff terbatas; kegagalan pathfinding
   tetap menjadi blocker yang perlu survei/akses baru.

9. Jika start dashboard mendapat reset/timeout, run kini masuk `WAITING_FOR_SERVER` dan
   melakukan probe SLP berkala tanpa membuat child bot. Setelah protocol 775 sehat, run
   otomatis berubah ke `MINING_AND_BUILDING` dan memakai konfigurasi awal (termasuk 4 miner,
   target inventory 75%, serta startup role bertahap).

## Executor

`src/ai/storageRoomBuilder.js` sekarang mendukung preflight volume, excavate/fill terrain
secara opt-in, restock bahan dari peti, placement survival, verifikasi nama blok, penghentian
karena cairan/mob/health/food, dan checkpoint resume. `src/ai/runStorageRoomBuilder.js` default
hanya observasi; mode bangun memerlukan `STORAGE_ROOM_EXECUTE=1` serta origin integer hasil
survei live. `STORAGE_ROOM_ALLOW_TERRAIN_WORK=1` mengaktifkan penggalian blok natural dan
fondasi tambahan. Batch default 32 blok agar bot dapat restock dan menyimpan checkpoint berkala.

Dependency Mineflayer lokal diperbarui ke `4.39.0` dan `minecraft-data` ke `3.116.0`.
Preflight builder live di origin terpilih pernah lolos geometri (`blockedCount=0`). Pada
eksekusi parsial, server kemudian menjadi tidak responsif dan koneksi worker dihentikan;
tidak ada proses builder aktif yang dibiarkan berjalan.

Generator: `src/ai/storageRoomBlueprint.js`.
Tes storage terfokus dan tes konfigurasi swarm dijalankan ulang setelah perubahan scaling.
Tes live tetap membutuhkan server yang sehat.

`src/ai/runStorageRoomSwarm.js` membagi blueprint menjadi 1-4 segmen z dengan worker
terkoordinasi, checkpoint terpisah, staggered start, dan lock restock lintas-proses.
Untuk dua worker, checkpoint lama tetap dipakai. `src/ai/runStorageRoomSupervisor.js`
menunggu SLP protocol 775 sehat sebelum menyalakan swarm, lalu melakukan resume dari
checkpoint jika koneksi server sempat putus. Gunakan `STORAGE_ROOM_SWARM_WORKERS=4`
hanya setelah SLP sehat; maksimum sengaja dibatasi empat worker.
Setelah builder selesai, jalankan `STORAGE_ROOM_ORIGIN=-110,70,-400 STORAGE_ROOM_SKIP_BASE=1 npm run storage:audit`;
perintah ini read-only dan hanya boleh dilaporkan sukses jika seluruh gate struktur,
pasangan chest, akses, cairan, dan pencahayaan lulus.
