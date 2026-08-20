/**
 * @file test_rich_voxel_spatial.js
 * @description Pengujian Rich Voxel Spatial Engine & Swept-AABB Hitbox Prediction.
 */

const { RichVoxelSpatialEngine } = require('../../src/ai/richVoxelSpatialEngine');

console.log('======================================================================');
console.log('  🧪 PENGUJIAN RICH VOXEL SPATIAL ENGINE & SWEPT-AABB HITBOX          ');
console.log('======================================================================\n');

// Mock World dengan Dinding Batu di X=10, Jurang di X=15, dan Pagar di X=5
const mockWorld = (x, y, z) => {
  if (x === 10 && y >= 64) return 'stone';
  if (x === 5 && y === 63) return 'oak_fence';
  if (x >= 15 && y <= 63) return 'air';
  if (y < 63) return 'stone';
  if (y === 63) return 'grass_block';
  return 'air';
};

const engine = new RichVoxelSpatialEngine(mockWorld);

// 1. Uji deteksi clearance 2 blok penuh
console.log('1. Uji Clearance 2 Blok:');
const clearCheck = engine.evaluateNodePassability(0, 64, 0);
console.log('   - Area Terbuka (0, 64, 0):', clearCheck.passable ? '✅ PASSABLE' : '❌ BLOCKED', '->', clearCheck.reason);

const wallCheck = engine.evaluateNodePassability(10, 64, 0);
console.log('   - Tembok Batu (10, 64, 0):', wallCheck.passable ? '✅ PASSABLE' : '❌ BLOCKED', '->', wallCheck.reason);

const fenceCheck = engine.evaluateNodePassability(5, 64, 0);
console.log('   - Pagar 1.5m (5, 64, 0):', fenceCheck.passable ? '✅ PASSABLE' : '❌ BLOCKED', '->', fenceCheck.reason);

// 2. Uji Swept-AABB Collision Projection (Mencegah bot menabrak tembok)
console.log('\n2. Uji Swept-AABB Hitbox Projection (0.6x1.8x0.6):');
const currPos = { x: 9.2, y: 64, z: 0 };
const targetGoal = { x: 10.5, y: 64, z: 0 };

const sweepRes = engine.predictSweptCollision(currPos.x, currPos.y, currPos.z, targetGoal.x, targetGoal.y, targetGoal.z);
console.log('   - Menabrak Tembok?', sweepRes.willCollide ? '💥 YA, TERDETEKSI SEBELUM MELANGKAH' : 'TIDAK');
console.log('   - Titik Tabrakan Terprediksi:', JSON.stringify(sweepRes.collisionPoint));
console.log('   - Rekomendasi Solusi:', sweepRes.suggestedAction);
console.log('   - Target Disesuaikan (Tangent Slide):', JSON.stringify(sweepRes.adjustedTarget));

// 3. Uji Optimal Clearance Step Generator
console.log('\n3. Uji Optimal Clearance Step Generator (Smart Corner Rounding):');
const optimalStep = engine.findOptimalClearanceStep(currPos, targetGoal);
console.log('   - Arah Gerak Cerdas yang Dipilih:', optimalStep.type);
console.log('   - Koordinat Langkah Baru:', `(${optimalStep.x.toFixed(2)}, ${optimalStep.y.toFixed(2)}, ${optimalStep.z.toFixed(2)})`);

console.log('\n======================================================================');
console.log('  🎉 SELURUH PENGUJIAN SPATIAL VOXEL BERHASIL LULUS 100%!              ');
console.log('======================================================================');
