ALTER TABLE "merchant_wallets" DROP CONSTRAINT "merchant_wallets_kind_chk";--> statement-breakpoint
ALTER TABLE "merchant_wallets" ADD COLUMN "lnbits_url" text;--> statement-breakpoint
ALTER TABLE "merchant_wallets" ADD COLUMN "secret_enc" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "lightning_wallet_id" uuid;--> statement-breakpoint
ALTER TABLE "merchant_wallets" ADD CONSTRAINT "merchant_wallets_kind_chk" CHECK ("merchant_wallets"."kind" in ('btc_deposit', 'usdc_settlement', 'btc_cold', 'lightning_lnbits'));