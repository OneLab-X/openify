CREATE TYPE "public"."customer_state" AS ENUM('enabled', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."checkout_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TYPE "public"."discount_kind" AS ENUM('percentage', 'fixed_amount', 'free_shipping');--> statement-breakpoint
CREATE TYPE "public"."discount_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."draft_order_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TYPE "public"."financial_status" AS ENUM('pending', 'authorized', 'paid', 'partially_paid', 'partially_refunded', 'refunded', 'voided');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('unfulfilled', 'partially_fulfilled', 'fulfilled', 'returned');--> statement-breakpoint
CREATE TYPE "public"."order_inventory_state" AS ENUM('none', 'reserved', 'released');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."transaction_kind" AS ENUM('authorization', 'capture', 'sale', 'refund', 'void');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'success', 'failure');--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"company" text,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"province" text,
	"postal_code" text,
	"country" char(2) NOT NULL,
	"phone" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_tags" (
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"tag" "citext" NOT NULL,
	CONSTRAINT "customer_tags_customer_id_tag_pk" PRIMARY KEY("customer_id","tag")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"first_name" text,
	"last_name" text,
	"phone" text,
	"password_hash" text,
	"state" "customer_state" DEFAULT 'enabled' NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"note" text,
	"currency" char(3),
	"orders_count" integer DEFAULT 0 NOT NULL,
	"total_spent" bigint DEFAULT 0 NOT NULL,
	"last_order_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"customer_id" uuid,
	"currency" char(3) NOT NULL,
	"note" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discount_code" "citext",
	"completed_at" timestamp with time zone,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" "checkout_status" DEFAULT 'open' NOT NULL,
	"email" "citext",
	"phone" text,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"shipping_address" jsonb,
	"billing_address" jsonb,
	"shipping_rate_id" text,
	"payment_provider" text,
	"totals" jsonb,
	"order_id" uuid,
	"abandoned_notified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"code" "citext" NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_usages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"code_id" uuid,
	"order_id" uuid NOT NULL,
	"email" "citext",
	"customer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" "discount_kind" NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"min_subtotal" bigint,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"usage_limit" integer,
	"once_per_customer" boolean DEFAULT false NOT NULL,
	"status" "discount_status" DEFAULT 'active' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"status" "draft_order_status" DEFAULT 'open' NOT NULL,
	"customer_id" uuid,
	"email" "citext",
	"phone" text,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shipping_address" jsonb,
	"shipping_line" jsonb,
	"discount" jsonb,
	"note" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"order_id" uuid,
	"created_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"template" text NOT NULL,
	"to" "citext" NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"order_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid,
	"product_id" uuid,
	"inventory_item_id" uuid,
	"location_id" uuid,
	"title" text NOT NULL,
	"variant_title" text,
	"sku" text,
	"hsn_code" text,
	"quantity" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	"compare_at_price" bigint,
	"discount_amount" bigint DEFAULT 0 NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"tax_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_shipping" boolean DEFAULT true NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"restocked_quantity" integer DEFAULT 0 NOT NULL,
	"refunded_quantity" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_sequences" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"next_order" integer DEFAULT 1001 NOT NULL,
	"next_draft" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"number" integer,
	"name" text,
	"checkout_id" uuid,
	"customer_id" uuid,
	"email" "citext",
	"phone" text,
	"currency" char(3) NOT NULL,
	"subtotal" bigint NOT NULL,
	"discount_total" bigint DEFAULT 0 NOT NULL,
	"shipping_total" bigint DEFAULT 0 NOT NULL,
	"tax_total" bigint DEFAULT 0 NOT NULL,
	"total" bigint NOT NULL,
	"taxes_included" boolean DEFAULT false NOT NULL,
	"amount_paid" bigint DEFAULT 0 NOT NULL,
	"amount_refunded" bigint DEFAULT 0 NOT NULL,
	"tax_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discount_applications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shipping_line" jsonb,
	"shipping_address" jsonb,
	"billing_address" jsonb,
	"note" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "order_status" DEFAULT 'open' NOT NULL,
	"financial_status" "financial_status" DEFAULT 'pending' NOT NULL,
	"fulfillment_status" "fulfillment_status" DEFAULT 'unfulfilled' NOT NULL,
	"inventory_state" "order_inventory_state" DEFAULT 'none' NOT NULL,
	"reservation_expires_at" timestamp with time zone,
	"payment_provider" text,
	"payment_mode" text,
	"source_name" text DEFAULT 'web' NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"placed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"provider_order_id" text,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"order_id" uuid,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"restock" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text,
	"note" text,
	"restock" boolean DEFAULT false NOT NULL,
	"transaction_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "transaction_kind" NOT NULL,
	"status" "transaction_status" NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider" text NOT NULL,
	"mode" text,
	"provider_reference" text,
	"provider_order_id" text,
	"method" text,
	"error_message" text,
	"parent_id" uuid,
	"created_by" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_discount_id_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_discount_id_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_code_id_discount_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."discount_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sequences" ADD CONSTRAINT "order_sequences_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_idx" ON "customer_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_tags_store_tag_idx" ON "customer_tags" USING btree ("store_id","tag");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_store_email_uq" ON "customers" USING btree ("store_id","email");--> statement-breakpoint
CREATE INDEX "customers_store_created_idx" ON "customers" USING btree ("store_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customers_store_spent_idx" ON "customers" USING btree ("store_id","total_spent" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cart_lines_cart_idx" ON "cart_lines" USING btree ("cart_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_token_uq" ON "carts" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "carts_customer_idx" ON "carts" USING btree ("store_id","customer_id") WHERE "carts"."completed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "checkouts_cart_uq" ON "checkouts" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "checkouts_abandoned_idx" ON "checkouts" USING btree ("store_id","updated_at") WHERE "checkouts"."status" = 'open' and "checkouts"."email" is not null and "checkouts"."abandoned_notified_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "discount_codes_store_code_uq" ON "discount_codes" USING btree ("store_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_usages_order_uq" ON "discount_usages" USING btree ("discount_id","order_id");--> statement-breakpoint
CREATE INDEX "discount_usages_email_idx" ON "discount_usages" USING btree ("discount_id","email");--> statement-breakpoint
CREATE INDEX "discounts_store_idx" ON "discounts" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "draft_orders_store_number_uq" ON "draft_orders" USING btree ("store_id","number");--> statement-breakpoint
CREATE INDEX "draft_orders_store_idx" ON "draft_orders" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_key_uq" ON "email_deliveries" USING btree ("store_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "email_deliveries_order_idx" ON "email_deliveries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_store_number_uq" ON "orders" USING btree ("store_id","number");--> statement-breakpoint
CREATE INDEX "orders_store_placed_idx" ON "orders" USING btree ("store_id","placed_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "orders"."placed_at" is not null;--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_checkout_idx" ON "orders" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "payment_sessions_order_idx" ON "payment_sessions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_sessions_provider_idx" ON "payment_sessions" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_uq" ON "payment_webhook_events" USING btree ("store_id","provider","event_id");--> statement-breakpoint
CREATE INDEX "refund_lines_refund_idx" ON "refund_lines" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "transactions_order_idx" ON "transactions" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_reference_uq" ON "transactions" USING btree ("store_id","provider","kind","provider_reference");