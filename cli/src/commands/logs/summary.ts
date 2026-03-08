import { Flags } from '@oclif/core';
import { BaseCommand } from '../../lib/base-command.js';

export default class LogsSummary extends BaseCommand {
  static description = 'Get a summary of log spans for a time range';
  static flags = {
    ...BaseCommand.baseFlags,
    'start-time': Flags.string({ description: 'Start time (ISO 8601)', required: true }),
    'end-time': Flags.string({ description: 'End time (ISO 8601)', required: true }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(LogsSummary);
    this.globalFlags = flags;
    try {
      const client = this.getClient();
      const data = await this.spin('Fetching summary', () =>
        client.logs.getSpansSummary({ start_time: flags['start-time'], end_time: flags['end-time'] }),
      );
      this.log(JSON.stringify(data, null, 2));
    } catch (error) {
      this.handleError(error);
    }
  }
}
