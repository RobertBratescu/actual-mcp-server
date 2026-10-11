import { z } from 'zod';
import { createTool } from '../lib/toolFactory.js';
import { CommonSchemas } from '../lib/schemas/common.js';
import adapter from '../lib/actual-adapter.js';

const InputSchema = z.object({
  ids: z.array(CommonSchemas.transactionId).length(2)
    .refine((ids) => ids[0] !== ids[1], { message: 'ids must be two DIFFERENT transaction ids' })
    .describe('Exactly two transaction ids to merge'),
});

export default createTool({
  name: 'actual_transactions_merge',
  description:
    'Merge two transactions (e.g. a bank-imported duplicate and a manual entry). Same account and same amount required; split children cannot be merged. ' +
    'Upstream keeps the one with imported_id, else imported_payee, else the earlier date, else the SECOND id, and DELETES the other (cannot be undone). ' +
    'The kept row keeps its own values: only its EMPTY payee, category, notes and schedule, and false cleared and reconciled flags, are filled from the deleted row, so a deleted row value is lost where the kept row has one. ' +
    'Returns keptId and deletedId. If only one is a transfer, the kept row takes the transfer payee; if both are transfers, their counterparts are merged and one more row is deleted there. ' +
    'Merging a split in, or a transfer to an on-budget account, clears the category. Read both with actual_transactions_get first.',
  schema: InputSchema,
  handler: async (input) => {
    const ids: [string, string] = [input.ids[0], input.ids[1]];
    const { keptId, deletedId } = await adapter.mergeTransactions(ids);
    return { success: true, keptId, deletedId };
  },
  examples: [
    { description: 'Merge a manual transaction with its imported duplicate', input: { ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] } },
  ],
});
