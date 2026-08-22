/**
 * Server-level instructions surfaced to MCP clients during the initialize
 * handshake. This replaces the workflow guidance that previously lived in the
 * tranzact-checkout skill (skills/tranzact-checkout/SKILL.md) — the MCP server
 * is now the single agent-facing integration surface.
 */
export const SERVER_INSTRUCTIONS = `Tranzact is a payment backend for agent-driven purchases. The user approves every
purchase via Telegram before any charge occurs. On approval the backend issues a
one-time virtual card with a spending limit equal to the approved quote; you reveal
the card credentials exactly once, use them to check out on the merchant site, then
report the result, which cancels the card.

## One-time setup (per agent installation)

1. Call \`register_agent\` (no arguments) and store the returned \`agentId\`
   permanently. Give the user the \`pairingCode\` and ask them to message the
   Telegram bot with \`/start <pairingCode>\`. If the code expires, call
   \`register_agent\` again with your stored \`agentId\` to get a fresh code.
2. After the user says they have paired, call \`get_pairing_status\` with your
   \`agentId\`. Status \`claimed\` means you are ready to make purchases.

## Purchase flow (in order, per purchase)

1. \`create_intent\` — register the purchase task before searching. Store the
   returned \`intentId\`; it threads through every subsequent call.
2. Find the product yourself (web search / browser tools). Collect merchant name,
   direct product URL, and the exact price. Gather any checkout details you will
   need from the user (shipping address, size, colour) BEFORE submitting the
   quote — after approval you should proceed straight to checkout.
3. \`submit_quote\` — submits the found product and triggers a Telegram approval
   request to the user. Tell the user to approve or reject it in Telegram.
4. \`get_decision\` — poll until the status is no longer AWAITING_APPROVAL. Pass
   \`waitSeconds\` (e.g. 20) so the server holds the request open instead of you
   spinning. APPROVED → continue. DENIED → stop, do not check out.
5. \`reveal_card\` — returns the virtual card credentials. THIS WORKS EXACTLY
   ONCE per intent. Hold the credentials in working memory only; never write
   them to disk, logs, or messages.
6. Complete the checkout on the merchant site with your browser tools, using the
   revealed card (zero-pad expMonth to two digits).
7. \`report_result\` — ALWAYS call this last, on success AND on failure. It
   settles the ledger and cancels the card. Include \`actualAmount\` on success.

## Rules

- Amounts are integers in the smallest currency unit (cents/pence): €5.00 = 500.
  Convert before calling; divide by 100 when showing amounts to the user.
- Never skip approval, never check out after a DENIED decision, and never attempt
  more than one checkout per intent.
- Card credentials are one-time and ephemeral: reveal once, use, forget. A 429
  from \`reveal_card\` does NOT consume the reveal — wait 60 seconds and retry.
- Always call \`report_result\`, even when checkout fails — otherwise the user's
  budget stays reserved and the card stays active.`;
