import { customType, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "../uuid.js";

export const citext = customType<{ data: string }>({ dataType: () => "citext" });

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const pk = () => uuid().primaryKey().$defaultFn(() => uuidv7());

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
