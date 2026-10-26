/**
 * Saved custom reports (the custom_reports table).
 *
 * Column lists follow src/lib/actual-schema.ts. The ActualQL schema also has
 * show_trend_lines; this server does not publish that column.
 */

export const CUSTOM_REPORT_COLUMNS = [
  'id',
  'name',
  'start_date',
  'end_date',
  'date_static',
  'date_range',
  'mode',
  'group_by',
  'sort_by',
  'balance_type',
  'show_empty',
  'show_offbudget',
  'show_hidden',
  'show_uncategorized',
  'trim_intervals',
  'include_current',
  'graph_type',
  'conditions',
  'conditions_op',
  'metadata',
  'interval',
  'color_scheme',
  'tombstone',
] as const;

export const CUSTOM_REPORT_LIST_COLUMNS = [
  'id',
  'name',
  'graph_type',
  'mode',
  'group_by',
  'balance_type',
  'interval',
  'date_range',
  'start_date',
  'end_date',
] as const;

const JSON_COLUMNS = new Set<string>(['conditions', 'metadata', 'color_scheme']);

export type ReportRow = Record<string, unknown>;

/** JSON columns arrive as strings or already-parsed values. Invalid text is left as-is. */
export function parseReportJson(value: unknown): unknown {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function pick(row: ReportRow, columns: readonly string[], parseJson: boolean): ReportRow {
  const out: ReportRow = {};
  for (const key of columns) {
    const value = row[key] ?? null;
    out[key] = parseJson && JSON_COLUMNS.has(key) ? parseReportJson(value) : value;
  }
  return out;
}

export function toReportListItem(row: ReportRow): ReportRow {
  return pick(row, CUSTOM_REPORT_LIST_COLUMNS, false);
}

export function toReportRecord(row: ReportRow): ReportRow {
  return pick(row, CUSTOM_REPORT_COLUMNS, true);
}
