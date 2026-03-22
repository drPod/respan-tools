import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { RespanClient } from '@respan/respan-api';
import type { AuthConfig, ToolDeps } from './client.js';
import { registerLogTools } from '../observe/logs.js';
import { registerTraceTools } from '../observe/traces.js';
import { registerUserTools } from '../observe/users.js';
import { registerPromptTools } from '../develop/prompts.js';
import { registerExperimentTools } from '../develop/experiments.js';
import { registerEvaluatorTools } from '../evaluate/evaluators.js';
import { registerDatasetTools } from '../evaluate/datasets.js';

function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({
    name: 'respan',
    version: '1.0.0',
  });

  registerLogTools(server, deps);
  registerTraceTools(server, deps);
  registerUserTools(server, deps);
  registerPromptTools(server, deps);
  registerExperimentTools(server, deps);
  registerEvaluatorTools(server, deps);
  registerDatasetTools(server, deps);

  return server;
}

function extractApiKey(req: VercelRequest): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return process.env.RESPAN_API_KEY;
}

export function createMcpHandler(defaultBaseUrl: string, _resourceMetadataPath: string) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

    if (req.method === 'GET') {
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'SSE streams not supported in stateless mode. Use POST for tool calls.' },
        id: null,
      });
    }
    if (req.method === 'DELETE') {
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session management not supported in stateless mode.' },
        id: null,
      });
    }

    try {
      const apiKey = extractApiKey(req);

      let client: RespanClient | null = null;
      let auth: AuthConfig | null = null;

      if (apiKey) {
        const baseUrl = (req.headers['respan-api-base-url'] as string)
          || process.env.RESPAN_API_BASE_URL
          || defaultBaseUrl;

        auth = { token: apiKey, baseUrl };
        client = new RespanClient({
          token: apiKey,
          ...(baseUrl !== defaultBaseUrl ? { environment: baseUrl } : {}),
        });
      }

      const deps: ToolDeps = { client, auth };
      const server = createServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      await transport.handleRequest(
        req as any,
        res as any,
        req.body
      );
    } catch (error) {
      console.error('MCP Handler error:', error);

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  };
}
