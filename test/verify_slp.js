#!/usr/bin/env node

/**
 * @file verify_slp.js
 * @description Utilitas CLI mandiri untuk verifikasi Server List Ping (SLP) Minecraft Protokol 775 (NeoForge 26.1.2).
 * Mendukung format visual berwarna dalam Bahasa Indonesia dan JSON terstruktur untuk otomasi CI/CD.
 *
 * Aturan Tim: Semua komentar kode, error message, dan teks UI ditulis dalam Bahasa Indonesia.
 */

const { querySLP, verifyBotOnline } = require('../src/network/slpVerifier.js');

/**
 * Mem-parse argumen baris perintah (CLI) secara mandiri tanpa dependensi pihak ketiga.
 * @param {string[]} [argv=process.argv]
 * @returns {Object}
 */
function parseCliArgs(argv = process.argv) {
  const args = {
    host: process.env.MINECRAFT_SERVER_HOST || process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: parseInt(process.env.MINECRAFT_SERVER_PORT || process.env.MC_PORT, 10) || 25565,
    bot: process.env.BOT_USERNAME || process.env.MC_BOT_USERNAME || null,
    timeout: 5000,
    protocol: 775,
    json: false,
    help: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) {
      args.host = argv[++i];
    } else if (arg === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10);
    } else if (arg === '--bot' && argv[i + 1]) {
      args.bot = argv[++i];
    } else if (arg === '--timeout' && argv[i + 1]) {
      args.timeout = parseInt(argv[++i], 10);
    } else if (arg === '--protocol' && argv[i + 1]) {
      args.protocol = parseInt(argv[++i], 10);
    } else if (arg === '--json' || arg === '-j') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h' || arg === '-?') {
      args.help = true;
    }
  }

  return args;
}

/**
 * Menampilkan teks bantuan dalam Bahasa Indonesia.
 */
function displayHelp() {
  console.log(`
================================================================================
🔍 MINECRAFT SLP VERIFIER — BANTUAN PENGGUNAAN
================================================================================
Penggunaan:
  node test/verify_slp.js [opsi]

Opsi:
  --host <alamat>       Host atau IP server Minecraft (default: atoms-girl.tun.ply.gg)
  --port <nomor>        Port server Minecraft 1-65535 (default: 25565)
  --bot <nama>          Nama pemain bot yang dicari dalam daftar pemain aktif
  --timeout <ms>        Batas waktu kueri dalam milidetik (default: 5000)
  --protocol <nomor>    Versi protokol handshake Minecraft (default: 775)
  --json, -j            Keluarkan hasil dalam format JSON terstruktur murni
  --help, -h, -?        Tampilkan panduan bantuan ini

Exit Code:
  0: Server aktif / Bot terverifikasi online
  1: Server offline / Bot tidak ditemukan / Terjadi kesalahan
================================================================================
  `);
}

/**
 * Titik masuk utama eksekusi CLI.
 */
async function runCli() {
  const args = parseCliArgs(process.argv);
  if (args.help) {
    displayHelp();
    process.exit(0);
  }

  const startTime = new Date().toISOString();

  try {
    if (args.bot) {
      const verifyRes = await verifyBotOnline({
        host: args.host,
        port: args.port,
        botUsername: args.bot,
        timeoutMs: args.timeout,
        protocolVersion: args.protocol
      });

      const onlineCount = verifyRes.playerCount;
      const maxCount = verifyRes.maxPlayers;
      const sampleList = verifyRes.sample;
      const inSample = verifyRes.inSample;
      const sampleOmitted = verifyRes.sampleOmitted;
      const hasActivePlayers = onlineCount >= 1;
      const isSuccessful = verifyRes.isOnline;

      if (args.json) {
        console.log(
          JSON.stringify(
            {
              success: isSuccessful,
              timestamp: startTime,
              query: {
                host: args.host,
                port: args.port,
                botUsername: args.bot,
                timeoutMs: args.timeout,
                protocolVersion: args.protocol
              },
              server: {
                online: true,
                version: verifyRes.version,
                players: {
                  online: onlineCount,
                  max: maxCount,
                  sample: sampleList
                },
                description: verifyRes.rawStatus?.description,
                descriptionText: verifyRes.descriptionText,
                favicon: verifyRes.rawStatus?.favicon || null,
                latencyMs: verifyRes.latencyMs
              },
              verification: {
                serverOnline: true,
                playerCount: onlineCount,
                maxPlayers: maxCount,
                hasActivePlayers,
                botChecked: true,
                botFound: inSample,
                inSample,
                sampleOmitted,
                isOnline: isSuccessful
              }
            },
            null,
            2
          )
        );
      } else {
        console.log('='.repeat(80));
        console.log('🔍 MINECRAFT SERVER LIST PING (SLP) — VERIFIKASI STATUS SERVER & BOT');
        console.log('='.repeat(80));
        console.log(`Target Server      : ${args.host}:${args.port}`);
        console.log(`Batas Waktu (RTT)  : ${args.timeout} ms`);
        console.log(`Protokol Handshake : ${args.protocol} (Minecraft 1.21.x / NeoForge 26.1.2)`);
        console.log(`Bot yang Dicari    : ${args.bot}`);
        console.log('-'.repeat(80));
        console.log(`Status Server      : ONLINE (Aktif) ✔`);
        console.log(
          `Versi Server       : ${verifyRes.version?.name || 'Unknown'} (Protokol ${verifyRes.version?.protocol || args.protocol})`
        );
        console.log(`Deskripsi (MOTD)   : ${verifyRes.descriptionText || '-'}`);
        console.log(
          `Jumlah Pemain      : ${onlineCount} / ${maxCount} (${maxCount > 0 ? ((onlineCount / maxCount) * 100).toFixed(1) : 0}%)`
        );
        console.log(`Latensi Ping (RTT) : ${verifyRes.latencyMs} ms`);
        console.log('-'.repeat(80));
        console.log('📋 Sampel Pemain Aktif (players.sample):');
        if (sampleList && sampleList.length > 0) {
          sampleList.forEach((p, idx) => {
            console.log(`  [${idx + 1}] ${p.name} (UUID: ${p.id || '-'})`);
          });
        } else {
          console.log('  (Tidak ada sampel pemain yang disertakan oleh server)');
        }
        console.log('-'.repeat(80));
        console.log('🎯 Hasil Verifikasi Bot:');
        if (inSample) {
          console.log(`  ✔ Bot "${args.bot}" TERDAFTAR dalam sampel pemain aktif.`);
        } else if (sampleOmitted && hasActivePlayers) {
          console.log(
            `  ℹ Sampel pemain ditiadakan oleh server, namun server memiliki ${onlineCount} pemain online aktif.`
          );
        } else if (hasActivePlayers) {
          console.log(
            `  ℹ Bot "${args.bot}" tidak tercantum di sampel terbatas, namun server memiliki ${onlineCount} pemain online.`
          );
        } else {
          console.log(`  ✖ Bot "${args.bot}" TIDAK ditemukan dan server kosong (0 pemain).`);
        }
        console.log('='.repeat(80));
        if (isSuccessful) {
          console.log('🎉 KESIMPULAN: VERIFIKASI SLP BERHASIL ✔');
        } else {
          console.log('❌ KESIMPULAN: VERIFIKASI SLP GAGAL (Bot tidak online) ✖');
        }
        console.log('='.repeat(80));
      }

      process.exit(isSuccessful ? 0 : 1);
    } else {
      const slpResult = await querySLP({
        host: args.host,
        port: args.port,
        timeoutMs: args.timeout,
        protocolVersion: args.protocol
      });

      const onlineCount = slpResult.players?.online || 0;
      const maxCount = slpResult.players?.max || 0;
      const sampleList = slpResult.players?.sample || [];
      const hasActivePlayers = onlineCount >= 1;

      if (args.json) {
        console.log(
          JSON.stringify(
            {
              success: true,
              timestamp: startTime,
              query: {
                host: args.host,
                port: args.port,
                botUsername: null,
                timeoutMs: args.timeout,
                protocolVersion: args.protocol
              },
              server: {
                online: true,
                version: slpResult.version,
                players: {
                  online: onlineCount,
                  max: maxCount,
                  sample: sampleList
                },
                description: slpResult.description,
                descriptionText: slpResult.descriptionText,
                favicon: slpResult.favicon || null,
                latencyMs: slpResult.latencyMs
              },
              verification: {
                serverOnline: true,
                playerCount: onlineCount,
                maxPlayers: maxCount,
                hasActivePlayers,
                botChecked: false,
                botFound: false,
                inSample: false
              }
            },
            null,
            2
          )
        );
      } else {
        console.log('='.repeat(80));
        console.log('🔍 MINECRAFT SERVER LIST PING (SLP) — STATUS SERVER');
        console.log('='.repeat(80));
        console.log(`Target Server      : ${args.host}:${args.port}`);
        console.log(`Batas Waktu (RTT)  : ${args.timeout} ms`);
        console.log(`Protokol Handshake : ${args.protocol} (Minecraft 1.21.x / NeoForge 26.1.2)`);
        console.log('-'.repeat(80));
        console.log(`Status Server      : ONLINE (Aktif) ✔`);
        console.log(
          `Versi Server       : ${slpResult.version?.name || 'Unknown'} (Protokol ${slpResult.version?.protocol || args.protocol})`
        );
        console.log(`Deskripsi (MOTD)   : ${slpResult.descriptionText || '-'}`);
        console.log(
          `Jumlah Pemain      : ${onlineCount} / ${maxCount} (${maxCount > 0 ? ((onlineCount / maxCount) * 100).toFixed(1) : 0}%)`
        );
        console.log(`Latensi Ping (RTT) : ${slpResult.latencyMs} ms`);
        console.log('-'.repeat(80));
        console.log('📋 Sampel Pemain Aktif (players.sample):');
        if (sampleList.length > 0) {
          sampleList.forEach((p, idx) => {
            console.log(`  [${idx + 1}] ${p.name} (UUID: ${p.id || '-'})`);
          });
        } else {
          console.log('  (Tidak ada sampel pemain yang disertakan oleh server)');
        }
        console.log('='.repeat(80));
        console.log('🎉 KESIMPULAN: STATUS SERVER BERHASIL DIPEROLEH ✔');
        console.log('='.repeat(80));
      }

      process.exit(0);
    }
  } catch (err) {
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            success: false,
            timestamp: startTime,
            query: {
              host: args.host,
              port: args.port,
              botUsername: args.bot,
              timeoutMs: args.timeout,
              protocolVersion: args.protocol
            },
            server: {
              online: false
            },
            error: {
              code: err.code || 'ERR_SLP_FAILED',
              message: `Kesalahan kueri SLP: ${err.message}`
            },
            verification: {
              serverOnline: false,
              playerCount: 0,
              hasActivePlayers: false,
              botChecked: Boolean(args.bot),
              botFound: false,
              inSample: false
            }
          },
          null,
          2
        )
      );
    } else {
      console.error('='.repeat(80));
      console.error('❌ KESALAHAN SAAT MENJALANKAN VERIFIKASI SLP');
      console.error('='.repeat(80));
      console.error(`Target Server : ${args.host}:${args.port}`);
      console.error(`Pesan Galat   : ${err.message}`);
      if (err.code) console.error(`Kode Galat    : ${err.code}`);
      console.error('='.repeat(80));
    }
    process.exit(1);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = { parseCliArgs, runCli, displayHelp };
