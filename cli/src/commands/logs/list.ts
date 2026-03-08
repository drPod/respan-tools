import { Flags } from '@oclif/core';
import { BaseCommand } from '../../lib/base-command.js';
import { extractPagination, formatPaginationInfo } from '../../lib/pagination.js';

export default class LogsList extends BaseCommand {
  static description = 'List log spans';
  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({ description: 'Number of results per page', default: 50 }),
    page: Flags.integer({ description: 'Page number', default: 1 }),
    'sort-by': Flags.string({ description: 'Sort field' }),
    'start-time': Flags.string({ description: 'Start time filter (ISO 8601)' }),
    'end-time': Flags.string({ description: 'End time filter (ISO 8601)' }),
    filter: Flags.string({ description: 'Filter expression', multiple: true }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(LogsList);
    this.globalFlags = flags;
    try {
      const client = this.getClient();
      const params: Record<string, unknown> = {
        page_size: flags.limit,
        page: flags.page,
      };
      if (flags['sort-by']) params.sort_by = flags['sort-by'];
      if (flags['start-time']) params.start_time = flags['start-time'];
      if (flags['end-time']) params.end_time = flags['end-time'];
      if (flags.filter && flags.filter.length > 0) params.filters = flags.filter;

      // listSpans requires start_time, end_time, sort_by, operator
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const data = await this.spin('Fetching logs', () => client.logs.listSpans({
        start_time: (params.start_time as string) || oneHourAgo,
        end_time: (params.end_time as string) || new Date().toISOString(),
        sort_by: (params.sort_by as string) || '-id',
        operator: '',
        page_size: params.page_size as number,
        page: params.page as number,
      }));
      this.outputResult(data, ['id', 'model', 'prompt_tokens', 'completion_tokens', 'cost', 'latency', 'timestamp']);
      const pagination = extractPagination(data, flags.page);
      this.log(formatPaginationInfo(pagination));
    } catch (error) {
      this.handleError(error);
    }
  }
}
