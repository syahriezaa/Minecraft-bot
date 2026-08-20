/**
 * @file aiTerminal.js
 * @description Controller terminal chat DeepSeek AI di dashboard web.
 */

(function () {
  'use strict';

  const chatContainer = document.getElementById('chat-container');
  const aiInput = document.getElementById('ai-input');
  const btnSend = document.getElementById('btn-send-ai');

  if (!chatContainer || !aiInput || !btnSend) return;

  let isWaiting = false;

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'chat-message ' + role;

    const roleNames = { user: 'Anda', ai: 'AI Brain', system: 'Sistem' };
    div.innerHTML = `<span class="chat-role">${roleNames[role] || role}</span> <span class="chat-text">${escapeHtml(text)}</span>`;

    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function sendPrompt() {
    const prompt = aiInput.value.trim();
    if (!prompt || isWaiting) return;

    addMessage('user', prompt);
    aiInput.value = '';
    isWaiting = true;
    btnSend.disabled = true;
    btnSend.textContent = '...';

    // Tampilkan indikator mengetik
    const typingDiv = document.createElement('div');
    typingDiv.className = 'chat-message ai';
    typingDiv.innerHTML = '<span class="chat-role">AI Brain</span> <span class="chat-text" style="opacity:0.5;">Sedang berpikir...</span>';
    typingDiv.id = 'typing-indicator';
    chatContainer.appendChild(typingDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();

      // Hapus indikator mengetik
      const indicator = document.getElementById('typing-indicator');
      if (indicator) indicator.remove();

      if (data.success && data.data) {
        addMessage('ai', data.data.message || 'Tidak ada respons');
        if (data.data.toolCalls && data.data.toolCalls.length > 0) {
          const toolSummary = data.data.toolCalls.map(tc => `> ${tc.name}(${JSON.stringify(tc.arguments)})`).join('\n');
          addMessage('system', `Tool calls yang akan dieksekusi:\n${toolSummary}`);
        }
      } else {
        addMessage('system', `Error: ${data.error?.message || 'Gagal mendapatkan respons AI'}`);
      }
    } catch (e) {
      const indicator = document.getElementById('typing-indicator');
      if (indicator) indicator.remove();
      addMessage('system', `Error koneksi: ${e.message}`);
    } finally {
      isWaiting = false;
      btnSend.disabled = false;
      btnSend.textContent = 'Kirim';
    }
  }

  btnSend.addEventListener('click', sendPrompt);
  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendPrompt();
  });

  // Export global
  window.aiTerminal = { addMessage };
})();
