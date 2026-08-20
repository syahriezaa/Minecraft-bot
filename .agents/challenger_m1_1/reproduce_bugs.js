// Test empirical reproduction of the identified vulnerabilities
'use strict';
const assert = require('node:assert/strict');
const {
  writeVarLong,
  readVarLong,
  readVarInt,
  readString
} = require('../../src/network/liveProtocolClient.js');

console.log('Testing Bug 1: writeVarLong with negative BigInts');
try {
  // -1n or any negative BigInt
  const start = Date.now();
  console.log('Attempting writeVarLong(-1n)...');
  const buf = writeVarLong(-1n);
  console.log('Result length:', buf.length);
} catch (e) {
  console.log('Bug 1 Confirmed! Caught error:', e.name, '-', e.message);
}

console.log('\nTesting Bug 2: readVarInt with empty buffer or out-of-bounds offset');
const emptyRes = readVarInt(Buffer.alloc(0), 0);
console.log('readVarInt(Buffer.alloc(0), 0) returned:', emptyRes);
if (emptyRes && emptyRes.size === 0) {
  console.log('Bug 2 Confirmed! readVarInt returned size: 0 on empty buffer, which can cause infinite loops when advancing offsets.');
}

console.log('\nTesting Bug 3: readVarLong with empty buffer');
const emptyLongRes = readVarLong(Buffer.alloc(0), 0);
console.log('readVarLong(Buffer.alloc(0), 0) returned:', emptyLongRes);

console.log('\nTesting Bug 4: readString with empty buffer');
const emptyStrRes = readString(Buffer.alloc(0), 0);
console.log('readString(Buffer.alloc(0), 0) returned:', emptyStrRes);
