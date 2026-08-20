/**
 * @file entityDecoder.js
 * @description Dekoder packet entity (spawn_entity, entity_destroy, rel_entity_move) untuk NeoForge
 * 26.1.2 / protokol 775. Sama seperti chunkDecoder.js, framing dibongkar lewat minecraft-protocol
 * versi referensi terdekat yang tersedia (1.21.11 / protokol 774) karena minecraft-data belum
 * menerbitkan definisi untuk protokol 775 - packet ID nyata server ini (0x01/0x4d/0x63) sudah
 * dikonfirmasi lewat capture live & validasi silang entityId, bukan tebakan.
 */

const ENTITY_REFERENCE_VERSION = '1.21.11';

let cachedDeserializer = null;
let cachedMcData = null;

function getDeserializer() {
  if (!cachedDeserializer) {
    const mcProtocol = require('minecraft-protocol');
    cachedDeserializer = mcProtocol.createDeserializer({
      state: mcProtocol.states.PLAY,
      isServer: false,
      version: ENTITY_REFERENCE_VERSION
    });
  }
  return cachedDeserializer;
}

function getMcData() {
  if (!cachedMcData) {
    cachedMcData = require('minecraft-data')(ENTITY_REFERENCE_VERSION);
  }
  return cachedMcData;
}

function writeVarIntLocal(value) {
  const bytes = [];
  let val = value >>> 0;
  while (true) {
    if ((val & ~0x7F) === 0) {
      bytes.push(val);
      break;
    }
    bytes.push((val & 0x7F) | 0x80);
    val >>>= 7;
  }
  return Buffer.from(bytes);
}

function getReferencePacketId(packetName) {
  const mcData = getMcData();
  const mappings = mcData.protocol.play.toClient.types.packet[1][0].type[1].mappings;
  for (const [id, name] of Object.entries(mappings)) {
    if (name === packetName) return parseInt(id, 16);
  }
  throw new Error(`entityDecoder: packet '${packetName}' tidak ditemukan di minecraft-data ${ENTITY_REFERENCE_VERSION}`);
}

function decodeViaReference(packetName, bodyBuffer) {
  const deserializer = getDeserializer();
  const fullPacket = Buffer.concat([writeVarIntLocal(getReferencePacketId(packetName)), bodyBuffer]);
  const { data } = deserializer.parsePacketBuffer(fullPacket);
  return data.params;
}

function decodeSpawnEntity(bodyBuffer) {
  const p = decodeViaReference('spawn_entity', bodyBuffer);
  return { entityId: p.entityId, type: p.type, x: p.x, y: p.y, z: p.z };
}

function decodeEntityDestroy(bodyBuffer) {
  const p = decodeViaReference('entity_destroy', bodyBuffer);
  return { entityIds: p.entityIds };
}

/**
 * dX/dY/dZ mentah dari server berskala 1/4096 blok (format standar rel_entity_move Minecraft
 * sejak protokol lama, stabil lintas versi) - dikonversi ke satuan blok di sini.
 */
function decodeRelEntityMove(bodyBuffer) {
  const p = decodeViaReference('rel_entity_move', bodyBuffer);
  return {
    entityId: p.entityId,
    dx: p.dX / 4096,
    dy: p.dY / 4096,
    dz: p.dZ / 4096
  };
}

function resolveEntityTypeName(typeId) {
  const mcData = getMcData();
  const entity = mcData.entitiesArray.find((e) => e.id === typeId);
  return entity ? entity.name : null;
}

function isHostileEntityName(name) {
  if (!name) return false;
  const mcData = getMcData();
  const entity = mcData.entitiesArray.find((e) => e.name === name);
  return Boolean(entity && entity.type === 'hostile');
}

module.exports = {
  decodeSpawnEntity,
  decodeEntityDestroy,
  decodeRelEntityMove,
  resolveEntityTypeName,
  isHostileEntityName
};
