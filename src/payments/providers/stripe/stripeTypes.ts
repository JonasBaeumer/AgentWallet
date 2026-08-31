import type Stripe from 'stripe';

/**
 * Stripe resource types, derived from the public client type.
 *
 * stripe@22 publishes through `exports` with a single "." entry, and its
 * CommonJS type entry (`cjs/stripe.cjs.node.d.ts`) exports `StripeConstructor`,
 * whose namespace re-exports only `type Stripe`. The rich namespace carrying
 * `Issuing`, `Balance`, and `Event` lives in `cjs/stripe.core.d.ts`, which the
 * package does not expose as a subpath. That is why these modules previously
 * imported from `stripe/cjs/*` directly.
 *
 * Those deep paths resolve only under the legacy Node 10 algorithm, which
 * ignores `exports`. Anything that needs `exports` honoured -- notably
 * `@coinbase/cdp-sdk/x402`, which is published through `exports` alone -- forces
 * `moduleResolution: node16`, and under node16 every `stripe/cjs/*` import stops
 * resolving. The two requirements are in direct conflict as long as the types
 * come from a deep path. See #214.
 *
 * Deriving the same types structurally from the client removes the conflict:
 * every alias below is reachable from `import type Stripe from 'stripe'` alone,
 * and each compiles identically under `moduleResolution: node` today and under
 * `node16` after the switch. No behaviour changes -- these resolve to the same
 * `Stripe.Issuing.*` types the deep imports named.
 *
 * Prefer adding an alias here over reintroducing a `stripe/cjs/*` import.
 */
type Client = InstanceType<typeof Stripe>;

/** Strips the `lastResponse` envelope Stripe adds to a returned resource. */
type Unwrap<T> = T extends { lastResponse: unknown } ? Omit<T, 'lastResponse'> : T;

export type IssuingCard = Unwrap<Awaited<ReturnType<Client['issuing']['cards']['create']>>>;

export type IssuingCardholder = Unwrap<
  Awaited<ReturnType<Client['issuing']['cardholders']['create']>>
>;

export type IssuingAuthorization = Unwrap<
  Awaited<ReturnType<Client['testHelpers']['issuing']['authorizations']['create']>>
>;

export type IssuingTransaction = Unwrap<
  Awaited<ReturnType<Client['issuing']['transactions']['update']>>
>;

export type StripeBalance = Unwrap<Awaited<ReturnType<Client['balance']['retrieve']>>>;

export type StripeEvent = ReturnType<Client['webhooks']['constructEvent']>;

export type CardSpendingControls = NonNullable<
  Parameters<Client['issuing']['cards']['create']>[0]['spending_controls']
>;

export type AllowedMerchantCategory = NonNullable<
  CardSpendingControls['allowed_categories']
>[number];

/** The configured client itself, for modules that hold or return one. */
export type StripeClient = Client;
