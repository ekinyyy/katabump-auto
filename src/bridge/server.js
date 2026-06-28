import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SECURE_TOKEN = 'kin_yi_mcp_secure_access_token_9f3d6a2b8e_5c7d1e9f2a4b8c0d3e6f';
const PORT = 20127;

let transport;
const server = new Server(
  { name: 'yi-jian-mcp-server', version: '1.5.18' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'ls', description: 'list files', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'read', description: 'read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'restart', description: 'restart server', inputSchema: { type: 'object', properties: {} } }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'ls': {
        const targetPath = path.resolve(process.cwd(), (args && typeof args.path === 'string') ? args.path : '.');
        const files = fs.readdirSync(targetPath);
        return { content: [{ type: 'text', text: files.join('\n') }] };
      }
      case 'read': {
        if (!args || typeof args.path !== 'string') throw new Error('Missing path');
        const targetPath = path.resolve(process.cwd(), args.path);
        const data = fs.readFileSync(targetPath, 'utf-8');
        return { content: [{ type: 'text', text: data }] };
      }
      case 'restart':
        setTimeout(() => process.exit(0), 100);
        return { content: [{ type: 'text', text: 'restarting...' }] };
      default:
        throw new Error('Tool not found');
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

app.get('/sse', async (req, res) => {
  const token = req.query.token;
  if (token !== SECURE_TOKEN) return res.status(401).send('unauthorized');

  transport = new SSEServerTransport(`/messages?token=${encodeURIComponent(token)}`, res);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  if (req.query.token !== SECURE_TOKEN) return res.status(401).send('unauthorized');
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send('no session');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}. v1.5.18`);
});

(async () => {
  try {
    const pluginPath = path.resolve(process.cwd(), 'src/bridge/chat-plugin.js');
    if (fs.existsSync(pluginPath)) {
      const plugin = await import(`file://${pluginPath}`);
      if (plugin.setupChat) plugin.setupChat(app);
    }
  } catch (e) {
    console.error('Plugin loading failed:', e.message);
  }
})();
