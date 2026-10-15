/**
 * The `instructions` string of the MCP `initialize` result (#560).
 *
 * ONE source, built from the tools this process actually publishes (#483), so the text can
 * never point the model at a tool that MCP_TOOLSETS, MCP_TOOLS or MCP_READ_ONLY hid. Clients
 * that read the field (LibreChat with `serverInstructions: true`, Claude Desktop, Claude Code,
 * Gemini's MCP connector) inject it into the system prompt on every turn, so it holds
 * cross-tool rules only: call order, the data conventions every tool shares, and how to
 * recover. Facts that belong to one tool (join syntax, LIKE semantics, what an empty query
 * result means) live in that tool's description and are deliberately not repeated here, where
 * they would drift. The whole text stays at most 512 characters so it stands on its own in
 * clients that truncate.
 *
 * Ids are promised for accounts and categories only: actual_get_context caps payees at
 * payeeLimit (default 500) and its own description routes the rest elsewhere.
 *
 * Read-only comes from the resolved tool policy, never from tool annotations, which are hints
 * that nothing in src/ may branch on.
 */
export function buildServerInstructions(published: readonly string[], readOnly: boolean): string {
  const has = new Set(published);
  const parts = [
    'This server exposes an Actual Budget through MCP tools.',
    'Amounts are integer cents (5000 is 50.00, negative is an outflow) and dates are YYYY-MM-DD strings.',
  ];
  if (has.has('actual_get_context')) {
    parts.push(
      'Call actual_get_context first and use the account and category ids it returns, never guessed names.',
    );
    if (has.has('actual_query_run')) {
      parts.push(
        'In actual_query_run, filter on the id columns (account, category, payee) rather than on names; an empty result can mean a name was wrong.',
      );
    }
  }
  if (readOnly) {
    parts.push('This server is read-only, so do not offer to create, change or delete anything.');
  }
  return parts.join(' ');
}
