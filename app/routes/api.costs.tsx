import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  MAX_SAVE_ITEMS,
  ShopifyApiError,
  fetchVariantPage,
  getShopCurrency,
  saveMinMargin,
  updateCosts,
} from "../lib/costcheck.server";
import type { SaveResult, VariantRow } from "../lib/costcheck.server";

// JSON endpoint used by the CostCheck page. Requests come from App Bridge's
// fetch, which adds the session token that authenticate.admin verifies.

export type ScanResponse =
  | { rows: VariantRow[]; hasNextPage: boolean; endCursor: string | null }
  | { error: string };
export type SaveResponse = { results: SaveResult[] } | { error: string };
export type SettingsResponse = { minMargin: number } | { error: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  let body: { intent?: unknown; cursor?: unknown; items?: unknown; minMargin?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    if (body.intent === "scan") {
      const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
      const page = await fetchVariantPage(admin, cursor);
      return Response.json(page satisfies ScanResponse);
    }

    if (body.intent === "settings") {
      const minMargin = Number(body.minMargin);
      if (!Number.isFinite(minMargin) || minMargin < 0 || minMargin >= 100) {
        return Response.json(
          { error: "Minimum margin must be between 0 and 99.99%" },
          { status: 400 },
        );
      }
      const saved = await saveMinMargin(admin, Math.round(minMargin * 100) / 100);
      return Response.json({ minMargin: saved } satisfies SettingsResponse);
    }

    if (body.intent === "save") {
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return Response.json({ error: "Select at least one row" }, { status: 400 });
      }
      if (body.items.length > MAX_SAVE_ITEMS) {
        return Response.json(
          { error: `Save at most ${MAX_SAVE_ITEMS} rows at a time` },
          { status: 400 },
        );
      }
      const items = body.items.map((item) => ({
        inventoryItemId: String(item?.inventoryItemId ?? ""),
        // null clears the cost (Undo restoring a previously unset cost).
        cost: item?.cost === null ? null : String(item?.cost ?? ""),
      }));
      // Validate against the shop's real currency, never one sent by the client.
      const currencyCode = await getShopCurrency(admin);
      const results = await updateCosts(admin, items, currencyCode);
      return Response.json({ results } satisfies SaveResponse);
    }
  } catch (error) {
    if (error instanceof ShopifyApiError) {
      console.error(`CostCheck ${String(body.intent)} failed:`, error.message);
      // 422, not 5xx: proxies/tunnels may replace 5xx bodies with their own page.
      return Response.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
};
