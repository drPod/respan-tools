import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireClient, validatePathParam, type ToolDeps } from '../shared/client.js';

export function registerDatasetTools(server: McpServer, deps: ToolDeps) {
  server.tool(
    'list_datasets',
    'List all datasets in your organization.',
    {},
    async () => {
      const c = requireClient(deps.client);
      const data = await c.datasets.listDatasets();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'get_dataset',
    'Retrieve detailed information about a specific dataset.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset to retrieve.'),
    },
    async ({ dataset_id }) => {
      const c = requireClient(deps.client);
      const safeId = validatePathParam(dataset_id, "dataset_id");
      const data = await c.datasets.retrieveDataset({ dataset_id: safeId });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'create_dataset',
    'Create a new dataset.',
    {
      name: z.string().describe('Name of the dataset.'),
      description: z.string().optional().describe('A description of the dataset.'),
    },
    async (params) => {
      const c = requireClient(deps.client);
      const data = await c.datasets.createDataset(params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'update_dataset',
    "Update a dataset's name and/or description.",
    {
      dataset_id: z.string().describe('The unique identifier of the dataset to update.'),
      name: z.string().optional().describe('Updated name for the dataset.'),
      description: z.string().optional().describe('Updated description for the dataset.'),
    },
    async ({ dataset_id, name, description }) => {
      const c = requireClient(deps.client);
      const safeId = validatePathParam(dataset_id, "dataset_id");
      const updateBody: Record<string, unknown> = {};
      if (name !== undefined) updateBody.name = name;
      if (description !== undefined) updateBody.description = description;
      const data = await c.datasets.updateDataset({
        dataset_id: safeId,
        body: updateBody,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'list_dataset_spans',
    'List all spans (data points) in a dataset.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
    },
    async ({ dataset_id }) => {
      const c = requireClient(deps.client);
      const safeId = validatePathParam(dataset_id, "dataset_id");
      const data = await c.datasets.listspans({ dataset_id: safeId });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'list_dataset_spans_with_filters',
    'List dataset spans with server-side filtering.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      filters: z
        .record(z.any())
        .optional()
        .describe('Filter criteria to apply when listing spans.'),
    },
    async ({ dataset_id, filters }) => {
      const c = requireClient(deps.client);
      const safeId = validatePathParam(dataset_id, "dataset_id");
      const data = await c.datasets.listspanswithfilters({
        dataset_id: safeId,
        body: filters ?? {},
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'create_dataset_span',
    'Create a new span (data point) in a dataset. Requires input and output fields.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      input: z.string().describe('The input data for the span (can be JSON string).'),
      output: z.string().describe('The output data for the span (can be JSON string).'),
      metadata: z.record(z.any()).optional().describe('Optional metadata key-value pairs.'),
    },
    async ({ dataset_id, input, output, metadata }) => {
      const c = requireClient(deps.client);
      const safeId = validatePathParam(dataset_id, "dataset_id");
      const data = await c.datasets.createDatasetSpan({
        dataset_id: safeId,
        input,
        output,
        ...(metadata ? { metadata } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'retrieve_dataset_span',
    'Retrieve a specific span from a dataset.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      log_id: z.string().describe('The unique identifier of the span/log to retrieve.'),
    },
    async ({ dataset_id, log_id }) => {
      const c = requireClient(deps.client);
      const safeDatasetId = validatePathParam(dataset_id, "dataset_id");
      const safeLogId = validatePathParam(log_id, "log_id");
      const data = await c.datasets.retrievespan({ dataset_id: safeDatasetId, log_id: safeLogId });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'update_dataset_span',
    'Partially update a span in a dataset.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      log_id: z.string().describe('The unique identifier of the span/log to update.'),
      body: z
        .record(z.any())
        .describe('The fields to update on the span.'),
    },
    async ({ dataset_id, log_id, body }) => {
      const c = requireClient(deps.client);
      const safeDatasetId = validatePathParam(dataset_id, "dataset_id");
      const safeLogId = validatePathParam(log_id, "log_id");
      const data = await c.datasets.updateSpanPartial({ dataset_id: safeDatasetId, log_id: safeLogId, body });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'add_spans_to_dataset',
    'Add existing log spans to a dataset by their IDs.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      span_ids: z
        .array(z.string())
        .describe('Array of existing span IDs to add to the dataset.'),
    },
    async ({ dataset_id, span_ids }) => {
      const c = requireClient(deps.client);
      const safeId = validatePathParam(dataset_id, "dataset_id");
      const data = await c.datasets.addSpansToDataset({
        dataset_id: safeId,
        body: { span_ids },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
