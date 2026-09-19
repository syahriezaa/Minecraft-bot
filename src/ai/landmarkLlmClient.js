// Klien penamaan saja: tidak menerima atau menjalankan tool/perintah dunia.
function createLandmarkLlmClient(env = process.env, request = fetch) {
  if (env.LANDMARK_LLM_ENABLED !== 'true' || !env.LANDMARK_LLM_API_KEY || !env.LANDMARK_LLM_MODEL) return null;
  const base = (env.LANDMARK_LLM_BASE_URL || '').replace(/\/+$/, '');
  if (!base.startsWith('https://')) throw new Error('Endpoint LLM harus menggunakan HTTPS');
  let lastCall = 0;
  return {
    async chat(prompt) {
      if (Date.now() - lastCall < 10000) return { message: '' };
      lastCall = Date.now();
      const response = await request(`${base}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LANDMARK_LLM_API_KEY}` },
        body: JSON.stringify({ model: env.LANDMARK_LLM_MODEL, temperature: 0,
          max_tokens: 40, messages: [
            { role: 'system', content: 'Beri nama lokasi singkat berdasarkan bukti. Jangan buat perintah atau klaim yang tidak didukung.' },
            { role: 'user', content: prompt }
          ] })
      });
      if (!response.ok) throw new Error(`LLM penamaan gagal (HTTP ${response.status})`);
      const body = await response.json();
      return { message: typeof body.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : '' };
    }
  };
}

module.exports = { createLandmarkLlmClient };
