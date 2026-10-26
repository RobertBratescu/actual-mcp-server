import { z } from 'zod';
import { createTool } from '../lib/toolFactory.js';
import { CommonSchemas } from '../lib/schemas/common.js';
import adapter from '../lib/actual-adapter.js';
import { toReportRecord, type ReportRow } from '../lib/custom-reports.js';

export default createTool({
  name: 'actual_reports_get',
  description:
    'Get one saved custom report by id. Returns every stored column. conditions, metadata, and color_scheme are objects. A missing id returns found false and does not throw.',
  schema: z.object({
    id: CommonSchemas.reportId,
  }).strict(),
  handler: async ({ id }) => {
    const row = (await adapter.getCustomReport(id)) as ReportRow | null;
    if (row == null) {
      return {
        found: false as const,
        id,
        report: null,
        message: `No custom report found for ${id}`,
      };
    }
    return { found: true as const, ...toReportRecord(row) };
  },
});
