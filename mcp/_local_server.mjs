import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RespanClient } from '@respan/respan-api';
import { registerLogTools } from './dist/lib/observe/logs.js';
import { registerTraceTools } from './dist/lib/observe/traces.js';
import { registerUserTools } from './dist/lib/observe/users.js';
import { registerPromptTools } from './dist/lib/develop/prompts.js';
import { registerExperimentTools } from './dist/lib/develop/experiments.js';
import { registerEvaluatorTools } from './dist/lib/evaluate/evaluators.js';
import { registerDatasetTools } from './dist/lib/evaluate/datasets.js';

function createServer(client) {
  const server = new McpServer({ name: 'respan', version: '1.0.0' });
  registerLogTools(server, client);
  registerTraceTools(server, client);
  registerUserTools(server, client);
  registerPromptTools(server, client);
  registerExperimentTools(server, client);
  registerEvaluatorTools(server, client);
  registerDatasetTools(server, client);
  return server;
}

const httpServer = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    req.body = body ? JSON.parse(body) : undefined;

    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET' || req.method === 'DELETE') {
      return res.status(405).json({ error: 'Only POST supported' });
    }

    const authHeader = req.headers.authorization;
    const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    const baseUrl = req.headers['respan-api-base-url'] || 'https://api.respan.ai/api';
    console.log(`[LOCAL] respan-api-base-url header: ${req.headers['respan-api-base-url'] || '(not present)'}`);
    console.log(`[LOCAL] Resolved baseUrl: ${baseUrl}`);

    const client = new RespanClient({ token: apiKey, environment: baseUrl });
    const server = createServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
});

httpServer.listen(3456, () => console.log('Local MCP server on http://localhost:3456'));
