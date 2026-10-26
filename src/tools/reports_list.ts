import { z } from 'zod';
import { createTool } from '../lib/toolFactory.js';
import adapter from '../lib/actual-adapter.js';
import { toReportListItem, type ReportRow } from '../lib/custom-reports.js';

export default createTool({
  name: 'actual_reports_list',
  description:
    'List saved custom reports where tombstone is false. Returns id, name, graph_type, mode, group_by, balance_type, interval, date_range, start_date, and end_date.',
  schema: z.object({}).strict(),
  handler: async () => {
    const rows = (await adapter.listCustomReports()) as ReportRow[];
    return rows.map((row) => toReportListItem(row));
  },
});
