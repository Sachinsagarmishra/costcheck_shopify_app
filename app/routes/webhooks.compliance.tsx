import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory compliance webhooks. CostCheck stores no customer data and no
// product data, only the shop's auth session, so customer requests need no
// action and shop/redact removes any remaining sessions.
// authenticate.webhook verifies the HMAC and responds 401 when it is invalid.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic === "SHOP_REDACT") {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
