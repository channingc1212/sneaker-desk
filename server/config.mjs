import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readDotEnv() {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};

  return Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const [key, ...valueParts] = line.split("=");
        const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
        return [key.trim(), value];
      }),
  );
}

const dotEnv = readDotEnv();
const env = { ...dotEnv, ...process.env };

export function getConfig() {
  const ebayEnv = env.EBAY_ENV || "sandbox";
  return {
    ebay: {
      env: ebayEnv,
      clientId: env.EBAY_CLIENT_ID || "",
      clientSecret: env.EBAY_CLIENT_SECRET || "",
      ruName: env.EBAY_RUNAME || "",
      marketplaceId: env.EBAY_MARKETPLACE_ID || "EBAY_US",
      locale: env.EBAY_LOCALE || "en-US",
      currency: env.EBAY_CURRENCY || "USD",
      locationKey: env.EBAY_LOCATION_KEY || "",
      fulfillmentPolicyId: env.EBAY_FULFILLMENT_POLICY_ID || "",
      paymentPolicyId: env.EBAY_PAYMENT_POLICY_ID || "",
      returnPolicyId: env.EBAY_RETURN_POLICY_ID || "",
      categoryId: env.EBAY_DEFAULT_CATEGORY_ID || "15709",
      conditionDefault: env.EBAY_DEFAULT_CONDITION || "USED_EXCELLENT",
      accountDeletionEndpoint: env.EBAY_ACCOUNT_DELETION_ENDPOINT || "",
      accountDeletionVerificationToken: env.EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN || "",
    },
  };
}
