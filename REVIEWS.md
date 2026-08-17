# REVIEWS.md

## Review guidelines

Review strictly. Assume the diff was partly written by an AI agent and that the
author has not read it as carefully as they should have. Your job is to catch
what a fast human reviewer would wave through.

### Business logic — restate it, then confirm it

Much of this codebase encodes business rules directly in code, and those rules
are rarely written down anywhere else. Before reviewing style or structure,
work out **what rule the diff is asserting about the domain** and check whether
the author meant to assert it.

For each changed piece of logic:

1. Read the code and derive the business rule it implements, in one sentence,
   in domain terms — not a description of the control flow. "A user with no
   active subscription still keeps read access for 30 days after cancellation",
   not "the `if` checks `cancelledAt` against `now - 30d`".
2. Check that rule against everything else available: the PR description, the
   linked issue, adjacent code, existing tests, naming, comments, docs.
3. If the rule is unambiguous and consistent with the rest, say nothing.
4. **If you cannot determine the intended rule with confidence, or the code
   implies a rule that is not stated anywhere, or two parts of the diff imply
   different rules — raise it as P1 and ask the author to confirm.** Do not
   guess, and do not assume the code is correct because it is self-consistent.

Write these as a stated interpretation plus a direct question, so the author
can answer yes/no rather than reverse-engineer their own code:

> **P1 — confirm intended:** As written, an order with `status = PENDING` and
> a past `expiresAt` is still counted toward the customer's credit limit,
> because the filter on line 84 only excludes `CANCELLED`. Is that intended,
> or should expired-pending orders be released? The test on line 210 only
> covers the `CANCELLED` case, so either behaviour would pass.

Always flag these, even when the code looks deliberate:

- A boundary that could reasonably go either way and isn't pinned by a test:
  inclusive vs exclusive comparison, `>` vs `>=`, whether "within 30 days"
  includes day 30, rounding direction, timezone or day-boundary assumptions.
- Empty, zero, negative, and null cases that fall through to a default. Is the
  default the intended business answer, or an accident of the control flow?
- Ordering and precedence between rules: when two conditions both apply
  (a discount and a cap, a manual override and an automatic rule), the code
  picks one. Confirm the priority is the intended one.
- A rule that changed in this diff without the PR description saying it should.
  Behaviour changes smuggled in alongside a refactor are P1 by default —
  state the old behaviour, the new behaviour, and ask which is wanted.
- Special cases keyed on a specific ID, name, tier, or region. Ask whether the
  carve-out is intended and where it is documented.
- A magic number or threshold with no name and no source. Ask where the value
  comes from and give it a named constant.
- The same domain rule expressed in two places that could drift apart. Name
  both locations.

Once a rule is confirmed, ask for it to be recorded — as a named constant, a
test case that pins the boundary, or a one-line comment stating the rule and
why. A comment that restates the code is slop; a comment that states the
business rule the code cannot express is not.

### P0 — must block

- Logic that is wrong on a realistic input: off-by-one, inverted condition,
  wrong operator precedence, wrong variable used, swapped arguments.
- Unhandled error paths. Every fallible call either handles the failure or
  deliberately propagates it. Silent `catch {}` / `catch(e) { /* ignore */ }` /
  `let _ = fallible()` is a defect unless a comment justifies it.
- Concurrency bugs: unawaited promises, shared mutable state without
  synchronization, races between check and use.
- Resource leaks: files, sockets, DB connections, locks, subscriptions,
  timers not released on every exit path including the error path.
- Secrets, tokens, keys, or credentials in source, config, tests, or fixtures.
- PII or secret material written to logs, traces, or error messages.
- Unvalidated external input reaching a query, shell command, filesystem path,
  deserializer, or template.
- Breaking changes to a public API, CLI flag, config key, DB schema, or wire
  format with no migration path and no note in the PR description.
- Authentication or authorization checks that are missing, bypassable, or
  applied inconsistently across sibling routes/handlers.

### P1 — must be addressed before merge

- **AI slop.** Flag these explicitly, they are not nitpicks:
  - Comments that restate the code (`// increment counter` above `i += 1`),
    or narrate the change (`// Added error handling here`).
  - Defensive scaffolding for conditions that cannot occur given the types or
    the call sites — null checks on non-nullable values, `try/catch` around
    code that cannot throw, redundant guard clauses.
  - Abstractions with exactly one caller: a wrapper, interface, factory,
    strategy, or config object introduced for flexibility nobody asked for.
  - Invented configuration: new options, env vars, or feature flags not
    required by the change.
  - Duplicated logic that a nearby existing helper already covers. Say which
    helper.
  - Generic naming that hides intent: `data`, `result`, `handler`, `process`,
    `manager`, `utils`, `helper`, `temp`, `newX`.
  - Docstrings or README prose padded with filler ("robust", "seamlessly",
    "comprehensive", "leverages", "ensures that") that carries no information.
  - Emoji, decorative section banners, or marketing tone in code comments,
    commit messages, or docs.
  - Dead code, commented-out blocks, unused imports, unused parameters, or
    leftover debug prints/`console.log`.
- **Tests.** New behavior needs a test. Bug fixes need a regression test that
  fails without the fix. Flag tests that assert only that the code ran, mock
  the very thing under test, or duplicate an existing case with a new name.
- **Error messages** must say what failed and with what input. Reject
  `throw new Error("error")` and equivalents.
- **Consistency with the surrounding code.** New code should use the module's
  existing error type, logging facility, config access pattern, and naming
  conventions rather than introducing a parallel one.
- **Types.** Reject `any`, unchecked casts, and `unwrap()`/`!`/`as` used to
  silence a type or option rather than because the invariant is proven. If an
  invariant is proven, it needs a one-line comment saying why.
- **Docs and typos.** Treat typos, stale examples, and out-of-date docs in
  user-facing files (README, CONTRIBUTING, public docstrings, CLI help) as P1.
- **Dependencies.** A new dependency needs a justification in the PR
  description. Flag additions that duplicate an existing dependency or pull in
  a large tree for one function.
- **Performance regressions that are structural**, not micro: an N+1 query, a
  loop that reloads the same data, an O(n²) pass over an unbounded collection,
  a synchronous call on a hot async path.

### How to write the review

- Lead with the most serious issue. Do not open with a summary of what the PR
  does — the author knows.
- Every comment names the concrete failure: the input, the sequence, or the
  caller that breaks. "Consider handling errors" is not a review comment;
  "if `fetchUser` rejects here the request hangs, since `next` is never
  called" is.
- Business-logic questions follow the same rule. State your reading of the
  rule and the specific line it comes from, then ask one closed question.
  "Is this logic correct?" is not a review comment.
- Uncertainty about intent is a legitimate finding, not a gap in your review.
  Raising it is better than picking the more likely reading and staying quiet.
  But raise it once, on the line that decides the rule — not on every line
  that touches it.
- Suggest the fix when it is short. Do not paste large rewrites.
- Do not comment on formatting the linter or formatter already enforces.
- No praise, no "LGTM overall", no summary of strengths. If there is nothing
  to flag, say so in one line.

### TypeScript specifics

- **P0** — floating-point arithmetic on a money field. `User.mainBalance`,
  `PurchaseIntent.maxBudget`, `Pot.reservedAmount`, `Pot.settledAmount`, and
  `LedgerEntry.amount` are `Int` in the smallest currency unit. Any
  `parseFloat`, `Number(...)` on a decimal string, `*`, `/`, or `Math.round`
  introduced on these is a rounding bug waiting to happen. Percentages and
  splits must stay integer arithmetic.
- **P0** — a write that touches `mainBalance`, `Pot`, or `LedgerEntry` outside
  `prisma.$transaction`. All three of `reserveForIntent`, `settleIntent`, and
  `returnIntent` wrap their reads and writes in one transaction; a balance
  mutation that lands without its ledger entry is unrecoverable.
- **P0** — a change to `prisma/schema.prisma` with no matching directory under
  `prisma/migrations/`. Deploys run migrations, not `db push`.
- **P0** — a Stripe create/update call without an `idempotencyKey`. Card
  issuance keys on `intentId`; retries at the queue or webhook layer will
  re-invoke these calls, and Stripe treats an unkeyed retry as a new object.
- **P0** — the Stripe webhook route parsing the body before
  `stripe.webhooks.constructEvent`. Signature verification needs the raw
  buffer; a `JSON.parse`, a schema parse, or a default Fastify content-type
  parser on that route silently breaks verification.
- **P0** — a BullMQ processor that is not safe to run twice. Jobs retry on
  failure, so a processor that issues a card, moves money, or advances
  `IntentStatus` must key on something stable and no-op on the second run.
- **P1** — a route handler reading `request.body`, `request.query`, or
  `request.params` without a Zod schema from `src/api/validators/`. Handlers
  are the trust boundary; the agent and the Telegram bot are both untrusted
  callers.
- **P1** — a `VirtualCard` write that omits `provider`. The field deliberately
  has no default in the schema so a future provider cannot be silently
  mis-tagged as `STRIPE`; the comment above it says so.
- **P1** — a `VirtualCard` lookup keyed on `providerCardId` alone. Uniqueness
  is `@@unique([provider, providerCardId])`, so a single-column lookup is
  ambiguous the moment a second provider exists.
- **P1** — a cross-module import that reaches into another module's internals
  instead of its published interface, or a shared type redefined locally
  instead of imported from `src/contracts/`.

### Business logic in this repo

- The budget cap in `policyEngine.evaluateIntent` is exclusive:
  `intent.maxBudget > user.maxBudgetPerIntent` rejects, so an intent that
  hits `maxBudgetPerIntent` exactly is allowed. Confirm whether spending
  exactly the cap is meant to succeed, and keep the reading consistent with
  the `spending_limits` amount handed to Stripe, which is a separate check.
- Both allowlists are default-open in two directions. `merchantAllowlist` is
  only consulted when `metadata.merchantUrl` is present, and `mccAllowlist`
  only when `metadata.mccCategory` is present — an intent that omits the
  field skips the rule entirely. An empty allowlist also means "no
  restriction", not "nothing allowed". Any diff touching these must state
  whether absent metadata is meant to be permitted or denied.
- `settleIntent` computes `surplus = pot.reservedAmount - actualAmount` and
  only returns funds when `surplus > 0`. An over-capture — which Stripe
  Issuing permits — makes `surplus` negative, and the user keeps the
  difference while `settledAmount` records more than was ever reserved.
  Confirm whether over-capture should debit the balance, fail, or be
  reconciled out of band.
- `returnIntent` guards on `pot.status !== PotStatus.ACTIVE` and exits;
  `settleIntent` has no such guard. Settling the same intent twice — a
  plausible outcome of a webhook retry or a requeued job — writes a second
  `SETTLE` ledger entry and returns the surplus again. Confirm which of the
  two functions has the intended behaviour before copying either.
- The rate limit counts intents in a rolling 24 hours with
  `recentIntentCount >= 3` while excluding the intent under evaluation
  (`id: { not: intent.id }`), so the fourth intent in a window is the one
  rejected. Confirm the intended limit is three per rolling day rather than
  per calendar day, and that self-exclusion is deliberate.
- Currency is carried independently on `PurchaseIntent.currency`,
  `LedgerEntry.currency` (both defaulting to `"eur"`) and on the issued
  Stripe card, and nothing reconciles them. `reserveForIntent` compares
  `mainBalance` against `amount` with no currency check at all. Confirm
  whether a single account currency is assumed, and flag any diff that
  introduces a second one.
