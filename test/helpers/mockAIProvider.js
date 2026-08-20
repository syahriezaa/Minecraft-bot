/**
 * Mock Provider DeepSeek AI Brain (`deepseek-chat`) untuk Pengujian Otonom.
 * Menyediakan simulasi tool calling terstruktur, pengurai niat (intent parser)
 * Bahasa Indonesia, validasi skema kontrak, dan mekanisme failover heuristik deterministik.
 */

class MockDeepSeekClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY || 'mock-deepseek-key';
    this.model = options.model || 'deepseek-chat';
    this.fallbackMode = !options.apiKey && !process.env.DEEPSEEK_API_KEY;
    this.rateLimitCounter = 0;
  }

  init(config = {}) {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    return { status: 'INITIALIZED', model: this.model, endpoint: 'https://api.deepseek.com/v1/chat/completions' };
  }

  validateToolSchema(toolName, parameters) {
    if (!toolName || !parameters || typeof parameters !== 'object') {
      return { valid: false, error: 'Skema pemanggilan alat (tool call) tidak valid.' };
    }

    if (toolName === 'farm_mobs') {
      if (!parameters.target || typeof parameters.durationSeconds !== 'number') {
        return { valid: false, error: 'Parameter farm_mobs membutuhkan target (string) dan durationSeconds (number).' };
      }
      return { valid: true };
    }

    if (toolName === 'sort_chests') {
      if (!Array.isArray(parameters.chestCoords) && !parameters.chestCoords) {
        return { valid: false, error: 'Parameter sort_chests membutuhkan chestCoords (array).' };
      }
      return { valid: true };
    }

    if (toolName === 'incinerate_trash') {
      if (!parameters.hazardCoord || !parameters.hazardType) {
        return { valid: false, error: 'Parameter incinerate_trash membutuhkan hazardCoord dan hazardType.' };
      }
      if (!['lava', 'fire', 'cactus'].includes(parameters.hazardType)) {
        return { valid: false, error: `Tipe bahaya '${parameters.hazardType}' tidak valid untuk pembakaran sampah.` };
      }
      return { valid: true };
    }

    if (toolName === 'navigate_to') {
      if (typeof parameters.x !== 'number' || typeof parameters.y !== 'number' || typeof parameters.z !== 'number') {
        return { valid: false, error: 'Parameter navigate_to membutuhkan koordinat numerik (x, y, z).' };
      }
      return { valid: true };
    }

    return { valid: false, error: `Nama alat '${toolName}' tidak terdaftar.` };
  }

  parseIntent(prompt) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Prompt tidak boleh kosong.');
    }

    const trimmed = prompt.trim().toLowerCase();

    // Deteksi prompt nonsens
    if (trimmed.length < 3 || /^[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?0-9\s]+$/.test(trimmed) || trimmed.startsWith('blabla')) {
      return {
        tool: null,
        error: 'Perintah tidak dikenali atau di luar domain tugas.',
        status: 'UNRECOGNIZED'
      };
    }

    if (trimmed.includes('zombie') || trimmed.includes('spawner') || trimmed.includes('basmi') || trimmed.includes('bunuh')) {
      const matchSeconds = trimmed.match(/(\d+)\s*(detik|s)/i);
      const durationSeconds = matchSeconds ? parseInt(matchSeconds[1], 10) : 30;
      const weapon = trimmed.includes('kapak') || trimmed.includes('axe') ? 'axe' : 'sword';

      return {
        tool: 'farm_mobs',
        parameters: {
          target: 'zombie',
          durationSeconds,
          weapon
        },
        confidence: 0.98
      };
    }

    if (trimmed.includes('peti') || trimmed.includes('sort') || trimmed.includes('rapikan') || trimmed.includes('simpan')) {
      return {
        tool: 'sort_chests',
        parameters: {
          chestCoords: [{ x: 10, y: 64, z: 5 }, { x: 12, y: 64, z: 5 }, { x: 14, y: 64, z: 5 }],
          targetCategory: trimmed.includes('mineral') ? 'minerals' : 'mob_drops'
        },
        confidence: 0.95
      };
    }

    if (trimmed.includes('sampah') || trimmed.includes('bakar') || trimmed.includes('lava') || trimmed.includes('racun')) {
      return {
        tool: 'incinerate_trash',
        parameters: {
          hazardCoord: { x: 10, y: 64, z: 10 },
          hazardType: trimmed.includes('api') ? 'fire' : (trimmed.includes('kaktus') ? 'cactus' : 'lava'),
          items: ['poisonous_potato', 'rotten_flesh']
        },
        confidence: 0.96
      };
    }

    if (trimmed.includes('navigasi') || trimmed.includes('pergi') || trimmed.includes('jalan') || trimmed.includes('farm')) {
      return {
        tool: 'navigate_to',
        parameters: {
          x: -256,
          y: -20,
          z: -432,
          tolerance: 1.0
        },
        confidence: 0.99
      };
    }

    return {
      tool: 'navigate_to',
      parameters: { x: 0, y: 64, z: 0, tolerance: 0.5 },
      confidence: 0.80
    };
  }

  async planMultiStepTask(prompt) {
    const lower = (prompt || '').toLowerCase();
    const plan = [];

    if (lower.includes('bersihkan') || lower.includes('rutinitas') || (lower.includes('zombie') && lower.includes('peti'))) {
      plan.push({
        step: 1,
        tool: 'navigate_to',
        parameters: { x: -256, y: -20, z: -432, tolerance: 1.0 },
        deskripsi: 'Navigasi menuju ruang spawner farm zombie.'
      });
      plan.push({
        step: 2,
        tool: 'farm_mobs',
        parameters: { target: 'zombie', durationSeconds: 10, weapon: 'sword' },
        deskripsi: 'Membasmi zombie di kill chamber dengan weapon cooldown pacing.'
      });
      plan.push({
        step: 3,
        tool: 'sort_chests',
        parameters: { chestCoords: [{ x: 10, y: 64, z: 5 }] },
        deskripsi: 'Menyortir hasil jarahan ke peti penyimpanan.'
      });
      plan.push({
        step: 4,
        tool: 'incinerate_trash',
        parameters: { hazardCoord: { x: 10, y: 64, z: 10 }, hazardType: 'lava', items: ['poisonous_potato'] },
        deskripsi: 'Memusnahkan limbah beracun ke dalam perimeter aman lava.'
      });
    } else if (lower.includes('lalu') || lower.includes('kemudian') || (lower.includes('peti') && lower.includes('bawa'))) {
      plan.push({
        step: 1,
        tool: 'sort_chests',
        parameters: { chestCoords: [{ x: 1, y: 64, z: 1 }] },
        deskripsi: 'Memeriksa dan mengambil item dari peti.'
      });
      plan.push({
        step: 2,
        tool: 'equip_item',
        parameters: { item: 'iron_sword', slot: 'hand' },
        deskripsi: 'Menyiapkan pedang besi.'
      });
      plan.push({
        step: 3,
        tool: 'navigate_to',
        parameters: { x: -250, y: 64, z: 100, tolerance: 1.0 },
        deskripsi: 'Membawa perlengkapan ke koordinat target.'
      });
    } else {
      const single = this.parseIntent(prompt);
      plan.push({
        step: 1,
        tool: single.tool || 'navigate_to',
        parameters: single.parameters || { x: 0, y: 64, z: 0 },
        deskripsi: 'Eksekusi tugas tunggal.'
      });
    }

    return {
      planId: `plan-${Date.now()}`,
      model: this.model,
      status: 'MOCK_PLAN_READY',
      totalSteps: plan.length,
      steps: plan
    };
  }

  async simulateApiCall(options = {}) {
    if (options.simulateRateLimit) {
      throw new Error('HTTP 429: Too Many Requests (Rate limit exceeded). Silakan coba beberapa saat lagi.');
    }
    if (options.simulateTimeout) {
      await new Promise(r => setTimeout(r, 100));
      throw new Error('Timeout: Permintaan API DeepSeek melebihi batas waktu 10000ms.');
    }
    if (options.simulateMalformedJson) {
      return '{"tool": "farm_mobs", "parameters": { target: '; // Cacat sintaks JSON
    }

    return JSON.stringify({
      id: 'chatcmpl-mock-123',
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            function: {
              name: 'farm_mobs',
              arguments: JSON.stringify({ target: 'zombie', durationSeconds: 15, weapon: 'sword' })
            }
          }]
        }
      }]
    });
  }
}

module.exports = {
  MockDeepSeekClient,
  mockAIProvider: new MockDeepSeekClient()
};
