/**
 * @file deepseekClient.js
 * @description Klien API DeepSeek AI (`deepseek-chat`) untuk perencanaan tugas otonom multi-langkah.
 * Mendukung mode mock untuk pengujian deterministik tanpa koneksi internet.
 */

const environment = require('../config/environment');

// Definisi alat (tools/functions) yang tersedia untuk AI Brain
const AVAILABLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate_to',
      description: 'Navigasi bot ke koordinat target di dunia Minecraft',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Koordinat X tujuan' },
          y: { type: 'number', description: 'Koordinat Y tujuan' },
          z: { type: 'number', description: 'Koordinat Z tujuan' },
          tolerance: { type: 'number', description: 'Toleransi jarak kedatangan (meter)', default: 2.0 }
        },
        required: ['x', 'y', 'z']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'farm_mobs',
      description: 'Farming otomatis monster di sekitar bot dengan jeda serangan senjata',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Jenis monster target (zombie, skeleton, spider)', default: 'zombie' },
          durationSeconds: { type: 'number', description: 'Durasi farming dalam detik' },
          weapon: { type: 'string', enum: ['sword', 'axe'], description: 'Senjata yang digunakan', default: 'sword' }
        },
        required: ['target', 'durationSeconds']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sort_chests',
      description: 'Menyortir item inventaris ke beberapa peti berdasarkan kategori',
      parameters: {
        type: 'object',
        properties: {
          chestCoords: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                z: { type: 'number' }
              }
            },
            description: 'Daftar koordinat peti tujuan'
          },
          targetCategory: { type: 'string', description: 'Kategori item (weapons, armor, food, drops, trash)' }
        },
        required: ['chestCoords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'incinerate_trash',
      description: 'Membuang item sampah ke kolam lava/api dengan perimeter aman',
      parameters: {
        type: 'object',
        properties: {
          hazardCoord: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            description: 'Koordinat titik bahaya (lava/api)'
          },
          hazardType: { type: 'string', enum: ['lava', 'fire', 'cactus'], description: 'Jenis bahaya' },
          items: { type: 'array', items: { type: 'string' }, description: 'Daftar nama item yang akan dibuang' }
        },
        required: ['hazardCoord', 'hazardType', 'items']
      }
    }
  }
];

// Prompt sistem dasar untuk AI Brain
const SYSTEM_PROMPT = `Kamu adalah AI Companion cerdas dalam permainan Minecraft.
Kamu bertugas merencanakan dan mengeksekusi tugas-tugas otonom:
1. Navigasi ke koordinat target menggunakan pathfinding 3D
2. Farming monster (zombie, skeleton) dengan manajemen cooldown senjata
3. Menyortir item ke peti-peti yang sesuai berdasarkan kategori
4. Membuang item sampah ke kolam lava/api secara aman

Gunakan tool/function yang tersedia untuk mengeksekusi setiap langkah.
Selalu prioritaskan keselamatan karakter (hindari lava, jurang, monster berbahaya).
Jawab dalam Bahasa Indonesia.`;

class DeepSeekClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || environment.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY || '';
    this.baseUrl = options.baseUrl || environment.deepseek?.baseUrl || 'https://api.deepseek.com';
    this.model = options.model || 'deepseek-chat';
    this.useMock = options.useMock || !this.apiKey;
    this.conversationHistory = [];
    this.maxHistoryLength = 20;
  }

  /**
   * Mengirim prompt ke DeepSeek API dan mengembalikan respons beserta tool calls.
   * @param {string} userMessage - Pesan/prompt dari pengguna
   * @param {Object} [context={}] - Konteks tambahan (posisi bot, inventaris, dll)
   * @returns {Promise<Object>} Respons AI: { message, toolCalls, usage }
   */
  async chat(userMessage, context = {}) {
    // Tambahkan konteks ke pesan
    let enrichedMessage = userMessage;
    if (context.position) {
      enrichedMessage += `\n[Posisi Bot Saat Ini: X=${context.position.x}, Y=${context.position.y}, Z=${context.position.z}]`;
    }
    if (context.health !== undefined) {
      enrichedMessage += `\n[Health: ${context.health}/20]`;
    }

    this.conversationHistory.push({ role: 'user', content: enrichedMessage });

    // Batasi panjang histori percakapan
    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
    }

    if (this.useMock) {
      return this._mockResponse(userMessage, context);
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...this.conversationHistory
          ],
          tools: AVAILABLE_TOOLS,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 1024
        })
      });

      if (!response.ok) {
        throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      const assistantMessage = choice?.message?.content || '';
      const toolCalls = choice?.message?.tool_calls || [];

      this.conversationHistory.push({
        role: 'assistant',
        content: assistantMessage,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      });

      return {
        message: assistantMessage,
        toolCalls: toolCalls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}')
        })),
        usage: data.usage || {}
      };
    } catch (error) {
      console.error('[DeepSeek Client] Gagal menghubungi API:', error.message);
      return this._mockResponse(userMessage, context);
    }
  }

  /**
   * Menghasilkan respons mock untuk pengujian tanpa API key.
   * @private
   */
  _mockResponse(userMessage, context = {}) {
    const lower = userMessage.toLowerCase();
    let message = '';
    let toolCalls = [];

    if (lower.includes('zombie') || lower.includes('farm') || lower.includes('bantai')) {
      message = 'Baik! Saya akan menuju ke farm spawner zombie dan memulai farming otomatis selama 60 detik.';
      toolCalls = [
        { id: 'mock-1', name: 'navigate_to', arguments: { x: -256, y: -20, z: -432, tolerance: 2 } },
        { id: 'mock-2', name: 'farm_mobs', arguments: { target: 'zombie', durationSeconds: 60, weapon: 'sword' } }
      ];
    } else if (lower.includes('sort') || lower.includes('peti') || lower.includes('chest')) {
      message = 'Memulai penyortiran item ke peti-peti yang sesuai berdasarkan kategori.';
      toolCalls = [
        { id: 'mock-3', name: 'sort_chests', arguments: { chestCoords: [{ x: -258, y: -20, z: -429 }], targetCategory: 'weapons' } }
      ];
    } else if (lower.includes('trash') || lower.includes('sampah') || lower.includes('bakar')) {
      message = 'Membuang item sampah ke kolam lava secara aman.';
      toolCalls = [
        { id: 'mock-4', name: 'incinerate_trash', arguments: { hazardCoord: { x: -259, y: -21, z: -435 }, hazardType: 'lava', items: ['poisonous_potato', 'rotten_flesh'] } }
      ];
    } else if (lower.includes('navigasi') || lower.includes('pergi') || lower.includes('jalan')) {
      message = 'Menavigasi bot ke koordinat yang ditentukan.';
      toolCalls = [
        { id: 'mock-5', name: 'navigate_to', arguments: { x: 0, y: 64, z: 0, tolerance: 2 } }
      ];
    } else {
      message = `Saya memahami permintaan Anda: "${userMessage}". Apa yang bisa saya bantu? Saya dapat membantu farming zombie, menyortir peti, membuang sampah, atau navigasi ke koordinat tertentu.`;
    }

    this.conversationHistory.push({ role: 'assistant', content: message });

    return { message, toolCalls, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }

  /**
   * Mereset histori percakapan AI.
   */
  resetHistory() {
    this.conversationHistory = [];
  }
}

module.exports = { DeepSeekClient, AVAILABLE_TOOLS, SYSTEM_PROMPT };
