const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080');
ws.on('open', () => console.log('connected'));
ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data);
    if (msg.type === 'AI_ACTION_EVENT' && msg.data?.task === 'STORAGE_WORKER') {
      console.log(new Date().toISOString(), msg.data.step);
    }
  } catch (e) {}
});
setTimeout(() => process.exit(0), 150000);
