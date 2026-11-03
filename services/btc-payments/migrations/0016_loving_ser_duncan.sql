ALTER TABLE "payouts" DROP CONSTRAINT "payouts_asset_chk";--> statement-breakpoint
ALTER TABLE "pix_charges" DROP CONSTRAINT "pix_charges_asset_chk";--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_asset_chk" CHECK ("payouts"."asset" in ('USDC') and "payouts"."chain" in ('base','polygon'));--> statement-breakpoint
ALTER TABLE "pix_charges" ADD CONSTRAINT "pix_charges_asset_chk" CHECK ("pix_charges"."asset" in ('USDC') and "pix_charges"."chain" in ('base','polygon'));