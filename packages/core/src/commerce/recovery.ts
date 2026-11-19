import { hmacSha256Hex, randomToken, safeEqual, sha256Hex } from "@shopkit/crypto";
import { and, carts, checkouts, eq, isNull, lte, sql, UUID_RE } from "@shopkit/db";
import type { CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getSetting } from "../settings.js";

/** Signed link in the abandoned-checkout email that restores the cart in any browser. */
export function checkoutRecoveryToken(deps: Pick<CoreDeps, "runtime">, checkoutId: string): string {
  return `${checkoutId}.${hmacSha256Hex(deps.runtime.signingSecret, `checkout-recover:${checkoutId}`).slice(0, 32)}`;
}

export const checkoutRecoveryUrl = (deps: Pick<CoreDeps, "runtime">, checkoutId: string) =>
  `${deps.runtime.publicUrl}/api/storefront/checkouts/recover/${checkoutRecoveryToken(deps, checkoutId)}`;

/**
 * Gives the checkout's cart a new cookie token (only hashes are stored, so the old one cannot be
 * reissued) and returns it. The original browser's cookie stops matching, which is intended: the
 * cart follows whoever opened the emailed link.
 */
export async function recoverCheckout(deps: CoreDeps, storeId: string, token: string): Promise<{ checkoutId: string; cartToken: string } | null> {
  const [id] = token.split(".");
  if (!id || !UUID_RE.test(id) || !safeEqual(checkoutRecoveryToken(deps, id), token)) return null;
  const [row] = await deps.db.select({ checkout: checkouts, cart: carts }).from(checkouts).innerJoin(carts, eq(carts.id, checkouts.cartId)).where(and(eq(checkouts.storeId, storeId), eq(checkouts.id, id)));
  if (!row) throw notFound("Checkout");
  if (row.checkout.status === "completed" || row.cart.completedAt) return null;
  const cartToken = randomToken(24);
  await deps.db.update(carts).set({ tokenHash: sha256Hex(cartToken), updatedAt: now(deps) }).where(eq(carts.id, row.cart.id));
  return { checkoutId: id, cartToken };
}

/**
 * Periodic scan (abandoned-cart queue): open checkouts with an email, untouched for the configured
 * delay, get one reminder each. Marking and the outbox event share a transaction, and the email's
 * idempotency key is per checkout, so overlapping scans cannot double-send.
 */
export async function scanAbandonedCheckouts(deps: CoreDeps, storeId: string): Promise<number> {
  const cfg = await getSetting(deps.db, storeId, "notifications.config");
  if (!cfg.abandonedCheckoutEnabled) return 0;
  const cutoff = new Date(now(deps).getTime() - cfg.abandonedCheckoutDelayMinutes * 60_000);
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select({ id: checkouts.id, email: checkouts.email })
      .from(checkouts)
      .innerJoin(carts, eq(carts.id, checkouts.cartId))
      .where(
        and(
          eq(checkouts.storeId, storeId),
          eq(checkouts.status, "open"),
          isNull(checkouts.abandonedNotifiedAt),
          sql`${checkouts.email} is not null`,
          lte(checkouts.updatedAt, cutoff),
          lte(carts.updatedAt, cutoff),
          isNull(carts.completedAt),
          sql`exists (select 1 from cart_lines cl where cl.cart_id = ${carts.id})`,
        ),
      )
      .limit(500)
      .for("update", { of: checkouts, skipLocked: true });
    for (const c of due) {
      await tx.update(checkouts).set({ abandonedNotifiedAt: now(deps) }).where(eq(checkouts.id, c.id));
      await enqueueEvent(tx, { storeId, type: "checkout.abandoned", payload: { checkoutId: c.id, email: c.email } });
    }
    return due.length;
  });
}
