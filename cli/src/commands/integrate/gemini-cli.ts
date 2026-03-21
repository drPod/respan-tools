import * as path from 'node:path';
import { BaseCommand } from '../../lib/base-command.js';
import {
  integrateFlags,
  deepMerge,
  readJsonFile,
  writeJsonFile,
  readTextFile,
  writeTextFile,
  expandHome,
  parseAttrs,
  toOtelResourceAttrs,
  resolveScope,
  findProjectRoot,
} from '../../lib/integrate.js';

export default class IntegrateGeminiCli extends BaseCommand {
  static description = `Integrate Respan with Gemini CLI.

Gemini CLI has native OTel traces (tool_call, llm_call, agent_call)
so we configure it to send telemetry directly to the Respan OTLP
endpoint.

Scope:
  --local    Write to .gemini/settings.json in project root (default)
  --global   Write to ~/.gemini/settings.json`;

  static examples = [
    'respan integrate gemini-cli',
    'respan integrate gemini-cli --global',
    'respan integrate gemini-cli --project-id my-project --attrs \'{"env":"prod"}\'',
    'respan integrate gemini-cli --dry-run',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    ...integrateFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IntegrateGeminiCli);
    this.globalFlags = flags;

    try {
      const apiKey = this.resolveApiKey();
      const baseUrl = (flags['base-url']!).replace(/\/+$/, '');
      const projectId = flags['project-id'];
      const attrs = parseAttrs(flags.attrs!);
      const dryRun = flags['dry-run'];
      const scope = resolveScope(flags, 'local');

      // Resolve target settings file
      const settingsPath = scope === 'global'
        ? expandHome('~/.gemini/settings.json')
        : path.join(findProjectRoot(), '.gemini', 'settings.json');

      const existing = readJsonFile(settingsPath);

      // Build resource attributes
      const resourceAttrs: Record<string, string> = {
        'service.name': 'gemini-cli',
        ...attrs,
      };
      if (projectId) {
        resourceAttrs['respan.project_id'] = projectId;
      }

      // settings.json — only telemetry fields Gemini CLI supports
      const patch: Record<string, unknown> = {
        telemetry: {
          enabled: true,
          otlpEndpoint: `${baseUrl}/v2/traces`,
          otlpProtocol: 'http',
        },
      };

      const merged = deepMerge(existing, patch);

      // .env file — OTel SDK picks up headers & resource attrs from env
      const envDir = scope === 'global'
        ? expandHome('~/.gemini')
        : path.join(findProjectRoot(), '.gemini');
      const envPath = path.join(envDir, '.env');

      const envLines: string[] = [];
      envLines.push(`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${apiKey}`);
      const otelResStr = toOtelResourceAttrs(resourceAttrs);
      if (otelResStr) {
        envLines.push(`OTEL_RESOURCE_ATTRIBUTES=${otelResStr}`);
      }

      // Merge with existing .env (replace our keys, keep the rest)
      const existingEnv = readTextFile(envPath);
      const envKeysToSet = new Set(envLines.map(l => l.split('=')[0]));
      const keptLines = existingEnv
        .split('\n')
        .filter(line => {
          const key = line.split('=')[0];
          return !envKeysToSet.has(key);
        });
      const finalEnv = [...keptLines.filter(l => l.trim() !== ''), ...envLines].join('\n') + '\n';

      if (dryRun) {
        this.log(`[dry-run] Would update: ${settingsPath}`);
        this.log(JSON.stringify(merged, null, 2));
        this.log('');
        this.log(`[dry-run] Would update: ${envPath}`);
        this.log(finalEnv);
      } else {
        writeJsonFile(settingsPath, merged);
        this.log(`Updated settings: ${settingsPath}`);
        writeTextFile(envPath, finalEnv);
        this.log(`Updated env: ${envPath}`);
      }

      this.log('');
      this.log(`Gemini CLI integration complete (${scope}).`);
      this.log('');
      this.log('Set dynamic attributes before a session:');
      this.log('  export OTEL_RESOURCE_ATTRIBUTES="env=prod,task_id=T-123"');
    } catch (error) {
      this.handleError(error);
    }
  }

  private resolveApiKey(): string {
    const auth = this.getAuth();
    if (auth.apiKey) return auth.apiKey;
    if (auth.accessToken) {
      this.warn('Using access token (JWT) which may expire. Consider using an API key instead.');
      return auth.accessToken;
    }
    this.error('No API key found. Pass --api-key, set RESPAN_API_KEY, or run: respan auth login');
  }
}
