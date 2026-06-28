import fs from 'fs';
import path from 'path';

export function setupChat(app) {
  const messageStorePath = path.resolve(process.cwd(), 'chat_history.json');
  
  const getMessages = () => {
    if (fs.existsSync(messageStorePath)) {
      try {
        return JSON.parse(fs.readFileSync(messageStorePath, 'utf-8'));
      } catch (e) {
        return [];
      }
    }
    return [];
  };

  const saveMessages = (messages) => {
    fs.writeFileSync(messageStorePath, JSON.stringify(messages, null, 2));
  };

  app.get('/api/messages', (req, res) => {
    res.json(getMessages());
  });

  app.post('/api/messages', async (req, res) => {
    const { message, sender } = req.body;
    if (!message) return res.status(400).send('Missing message');

    const messages = getMessages();
    const newMessage = {
      id: Date.now().toString(),
      text: message,
      sender: sender || 'User',
      timestamp: new Date().toISOString(),
      role: 'user'
    };

    messages.push(newMessage);
    saveMessages(messages);

    try {
      await fetch('https://poke.com/api/v1/inbound/ingest/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkMWJhODYzMy0wZmVlLTQzYmQtYTE0NS00YTViNzY5ZWMyYWQiLCJqdGkiOiI4NmI4MzQ0Yy0wNzE5LTQ5NWEtYWQ5Ny03MGNlODNjOWQ2Y2EiLCJpYXQiOjE3ODI1NjYzMjAsImV4cCI6MjA5NzkyNjMyMH0.QirsJ2-79XRppzrHxNh-0qJAQAPh7R6McqsUZ8GGjWI', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sender: sender || 'web-user' })
      });
    } catch (e) {
      console.error('[plugins] failed to forward to ingest:', e.message);
    }

    res.json(newMessage);
  });

  app.post('/api/poke-reply', (req, res) => {
    const { message } = req.body;
    const messages = getMessages();
    const reply = {
      id: Date.now().toString(),
      text: message,
      sender: 'Poke',
      timestamp: new Date().toISOString(),
      role: 'assistant'
    };
    messages.push(reply);
    saveMessages(messages);
    res.json(reply);
  });

  console.log('[plugins] Chat API endpoints active at /api/messages');
}
