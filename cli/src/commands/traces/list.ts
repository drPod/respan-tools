import { Flags } from '@oclif/core';
import { BaseCommand } from '../../lib/base-command.js';
import { extractPagination, formatPaginationInfo } from '../../lib/pagination.js';

export default class TracesList extends BaseCommand {
  static description = 'List traces';
  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({ description: 'Number of results per page', default: 10 }),
    page: Flags.integer({ description: 'Page number', default: 1 }),
    'sort-by': Flags.string({ description: 'Sort field', default: '-timestamp' }),
    'start-time': Flags.string({ description: 'Start time filter (ISO 8601)' }),
    'end-time': Flags.string({ description: 'End time filter (ISO 8601)' }),
    environment: Flags.string({ description: 'Environment filter' }),
    filter: Flags.string({ description: 'Filter expression', multiple: true }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TracesList);
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
      if (flags.environment) params.environment = flags.environment;
      if (flags.filter && flags.filter.length > 0) params.filters = flags.filter;

      const data = await this.spin('Fetching traces', () => client.traces.list(params));
      this.outputResult(data, [
        'trace_unique_id', 'name', 'duration', 'span_count', 'total_cost', 'error_count', 'start_time',
      ]);
      const pagination = extractPagination(data, flags.page);
      this.log(formatPaginationInfo(pagination));
    } catch (error) {
      this.handleError(error);
    }
  }
}
