import type { MailingAddress } from "@shopkit/db";
import { z } from "zod";

const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

/** Shipping/billing address (zod boundary for carts, checkouts, orders and customer addresses). */
export const mailingAddressSchema = z.object({
  firstName: opt(100),
  lastName: opt(100),
  company: opt(200),
  line1: z.string().trim().min(1, "Enter an address").max(200),
  line2: opt(200),
  city: z.string().trim().min(1, "Enter a city").max(100),
  province: opt(100),
  postalCode: opt(20),
  country: z.string().trim().length(2, "Use a 2-letter country code").toUpperCase(),
  phone: opt(40),
}) satisfies z.ZodType<MailingAddress, unknown>;
export type MailingAddressInput = z.input<typeof mailingAddressSchema>;

export function fullName(a: Pick<MailingAddress, "firstName" | "lastName"> | null | undefined): string {
  return [a?.firstName, a?.lastName].filter(Boolean).join(" ");
}

export function formatAddress(a: MailingAddress | null | undefined): string[] {
  if (!a) return [];
  return [fullName(a), a.company, a.line1, a.line2, [a.city, a.province, a.postalCode].filter(Boolean).join(", "), a.country, a.phone].filter(
    (l): l is string => !!l,
  );
}
