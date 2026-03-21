import * as fs from 'node:fs';
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
  getGeminiHookScript,
  resolveScope,
  findProjectRoot,
} from '../../lib/integrate.js';

export default class IntegrateGeminiCli extends BaseCommand {
  static description = `Integrate Respan with Gemini CLI.

Installs an AfterModel hook that captures LLM request/response data
and sends it to Respan as structured spans with model, token counts,
and input/output.

Scope:
  --global   Write to ~/.gemini/settings.json (default)
  --local    Write to .gemini/settings.json in project root

Note: Gemini CLI ignores workspace-level telemetry settings, so
--global is the default.`;

  static examples = [
    'respan integrate gemini-cli',
    'respan integrate gemini-cli --local',
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
      const scope = resolveScope(flags, 'global');

      // ── 1. Install hook script ──────────────────────────────────
      const hookPath = expandHome('~/.respan/gemini_hook.py');
      if (dryRun) {
        this.log(`[dry-run] Would write hook script to: ${hookPath}`);
      } else {
        writeTextFile(hookPath, getGeminiHookScript());
        fs.chmodSync(hookPath, 0o755);
        this.log(`Wrote hook script: ${hookPath}`);
      }

      // ── 2. Register AfterModel hook in settings.json ────────────
      const settingsPath = scope === 'global'
        ? expandHome('~/.gemini/settings.json')
        : path.join(findProjectRoot(), '.gemini', 'settings.json');

      const existing = readJsonFile(settingsPath);

      const hookEntry = {
        hooks: [{ type: 'command', command: `python3 ${hookPath}` }],
      };

      const hooksSection = (existing.hooks || {}) as Record<string, unknown>;
      const afterModelHooks = Array.isArray(hooksSection.AfterModel)
        ? [...(hooksSection.AfterModel as Array<Record<string, unknown>>)]
        : [];

      // Replace existing respan hook or add new one
      const existingIdx = afterModelHooks.findIndex((entry) => {
        const inner = Array.isArray(entry.hooks)
          ? (entry.hooks as Array<Record<string, unknown>>)
          : [];
        return inner.some(
          (h) => typeof h.command === 'string' &&
            ((h.command as string).includes('respan') || (h.command as string).includes('gemini_hook')),
        );
      });

      if (existingIdx >= 0) {
        afterModelHooks[existingIdx] = hookEntry;
      } else {
        afterModelHooks.push(hookEntry);
      }

      const merged = deepMerge(existing, {
        hooks: { ...hooksSection, AfterModel: afterModelHooks },
      });

      // ── 3. Write .env with API key and config ───────────────────
      const envDir = scope === 'global'
        ? expandHome('~/.gemini')
        : path.join(findProjectRoot(), '.gemini');
      const envPath = path.join(envDir, '.env');

      const envLines: string[] = [];
      envLines.push(`RESPAN_API_KEY=${apiKey}`);
      envLines.push(`RESPAN_BASE_URL=${baseUrl}`);
      if (projectId) {
        envLines.push(`RESPAN_PROJECT_ID=${projectId}`);
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
