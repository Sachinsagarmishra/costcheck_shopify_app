import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { validateCost } from "./money";

import { REQUIRED_SCOPES } from "./constants";

export { MAX_SAVE_ITEMS } from "./constants";

// Variants fetched per scan request. Keeps each query's calculated cost well
// below the single-query maximum while needing few round trips.
export const SCAN_PAGE_SIZE = 250;
// Inventory item updates sent per GraphQL request (aliased mutations).
const SAVE_CHUNK_SIZE = 25;
const MAX_THROTTLE_RETRIES = 6;

export type VariantRow = {
  variantId: string;
  productId: string;
  productTitle: string;
  vendor: string;
  productType: string;
  tags: string[];
  /** ACTIVE | DRAFT | ARCHIVED (Shopify ProductStatus). */
  productStatus: string;
  variantTitle: string;
  sku: string;
  price: string;
  inventoryItemId: string;
  /** Small thumbnail (variant image, else product image) from Shopify's CDN. */
  imageUrl: string | null;
  imageAlt: string;
  /** `null` = no cost set. "0" is a real, explicit zero cost. */
  cost: string | null;
  costCurrency: string | null;
};

export type SaveResult =
  | {
      inventoryItemId: string;
      ok: true;
      cost: string | null;
      costCurrency: string | null;
    }
  | { inventoryItemId: string; ok: false; error: string };

type ThrottleStatus = {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
};
type QueryCost = {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: ThrottleStatus;
};
type GraphqlError = { message: string; extensions?: { code?: string } };

export class ShopifyApiError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function secondsUntilAvailable(cost: QueryCost | undefined, needed?: number) {
  const status = cost?.throttleStatus;
  const want = needed ?? cost?.requestedQueryCost;
  if (!status || !want || status.restoreRate <= 0) return 0;
  return Math.max(0, (want - status.currentlyAvailable) / status.restoreRate);
}

/**
 * Runs an Admin GraphQL operation, honouring Shopify's calculated query cost
 * rate limit: THROTTLED responses are retried after waiting for the bucket to
 * refill, and we pause pre-emptively when the bucket is nearly empty.
 * HTTP 429/503 responses are retried by the underlying client (`tries`).
 */
async function adminGraphql<T>(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await admin.graphql(query, { variables, tries: 3 });
      const json = (await response.json()) as {
        data: T;
        extensions?: { cost?: QueryCost };
      };
      const wait = secondsUntilAvailable(json.extensions?.cost);
      if (wait > 0) await sleep(Math.ceil(wait * 1000));
      return json.data;
    } catch (error) {
      // Auth helpers throw Responses (e.g. re-authentication); let them through.
      if (error instanceof Response) throw error;

      const body = (
        error as {
          body?: {
            errors?: { graphQLErrors?: GraphqlError[] };
            extensions?: { cost?: QueryCost };
          };
        }
      ).body;
      const graphQLErrors: GraphqlError[] = body?.errors?.graphQLErrors ?? [];
      const throttled = graphQLErrors.some(
        (e) => e.extensions?.code === "THROTTLED",
      );

      if (throttled && attempt < MAX_THROTTLE_RETRIES) {
        const wait = secondsUntilAvailable(body?.extensions?.cost);
        await sleep(Math.max(1000, Math.ceil(wait * 1000)) * (attempt + 1));
        continue;
      }

      throw new ShopifyApiError(describeError(graphQLErrors, error));
    }
  }
}

function describeError(graphQLErrors: GraphqlError[], error: unknown) {
  if (graphQLErrors.some((e) => e.extensions?.code === "ACCESS_DENIED")) {
    return "Access denied: CostCheck is missing permissions. Reopen or reinstall the app to approve them.";
  }
  if (graphQLErrors.some((e) => e.extensions?.code === "THROTTLED")) {
    return "Shopify is rate limiting requests. Please wait a moment and try again.";
  }
  if (graphQLErrors.length)
    return graphQLErrors.map((e) => e.message).join("; ");
  return error instanceof Error
    ? error.message
    : "Unexpected Shopify API error";
}

export async function getShopCurrency(admin: AdminApiContext): Promise<string> {
  const data = await adminGraphql<{ shop: { currencyCode: string } }>(
    admin,
    `#graphql
      query CostCheckShop {
        shop {
          currencyCode
        }
      }`,
    {},
  );
  return data.shop.currencyCode;
}

type MediaPreview = {
  preview: { image: { url: string; altText: string | null } | null } | null;
};

type VariantsPage = {
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      title: string;
      sku: string | null;
      price: string;
      media: { nodes: MediaPreview[] };
      product: {
        id: string;
        title: string;
        vendor: string;
        productType: string;
        tags: string[];
        status: string;
        featuredMedia: MediaPreview | null;
      };
      inventoryItem: {
        id: string;
        unitCost: { amount: string; currencyCode: string } | null;
      } | null;
    }>;
  };
};

/** Fetches one page of variants with their inventory item cost. Nothing is stored. */
export async function fetchVariantPage(
  admin: AdminApiContext,
  after: string | null,
) {
  const data = await adminGraphql<VariantsPage>(
    admin,
    `#graphql
      query CostCheckVariants($first: Int!, $after: String) {
        productVariants(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            sku
            price
            media(first: 1) {
              nodes {
                preview {
                  image {
                    url(transform: { maxWidth: 80, maxHeight: 80 })
                    altText
                  }
                }
              }
            }
            product {
              id
              title
              vendor
              productType
              tags
              status
              featuredMedia {
                preview {
                  image {
                    url(transform: { maxWidth: 80, maxHeight: 80 })
                    altText
                  }
                }
              }
            }
            inventoryItem {
              id
              unitCost {
                amount
                currencyCode
              }
            }
          }
        }
      }`,
    { first: SCAN_PAGE_SIZE, after },
  );

  const rows: VariantRow[] = data.productVariants.nodes
    .filter((node) => node.inventoryItem)
    .map((node) => {
      const image =
        node.media.nodes[0]?.preview?.image ??
        node.product.featuredMedia?.preview?.image ??
        null;
      return {
        variantId: node.id,
        productId: node.product.id,
        productTitle: node.product.title,
        vendor: node.product.vendor,
        productType: node.product.productType,
        tags: node.product.tags,
        productStatus: node.product.status,
        variantTitle: node.title,
        sku: node.sku ?? "",
        price: node.price,
        inventoryItemId: node.inventoryItem!.id,
        cost: node.inventoryItem!.unitCost?.amount ?? null,
        costCurrency: node.inventoryItem!.unitCost?.currencyCode ?? null,
        imageUrl: image?.url ?? null,
        imageAlt: image?.altText || node.product.title,
      };
    });

  return {
    rows,
    hasNextPage: data.productVariants.pageInfo.hasNextPage,
    endCursor: data.productVariants.pageInfo.endCursor,
  };
}

type UpdatePayload = {
  inventoryItem: {
    id: string;
    unitCost: { amount: string; currencyCode: string } | null;
  } | null;
  userErrors: Array<{ field: string[] | null; message: string }>;
};

const INVENTORY_ITEM_GID = /^gid:\/\/shopify\/InventoryItem\/\d+$/;

/**
 * Updates inventory item costs. Every item gets its own result so the UI can
 * show per-row success or failure.
 */
export async function updateCosts(
  admin: AdminApiContext,
  items: Array<{ inventoryItemId: string; cost: string | null }>,
  currencyCode: string,
): Promise<SaveResult[]> {
  const results: SaveResult[] = [];
  // `cost: null` clears the cost (used by Undo to restore "not set").
  const valid: Array<{ inventoryItemId: string; cost: string | null }> = [];

  for (const item of items) {
    if (!INVENTORY_ITEM_GID.test(item.inventoryItemId)) {
      results.push({
        inventoryItemId: item.inventoryItemId,
        ok: false,
        error: "Invalid item",
      });
      continue;
    }
    if (item.cost === null) {
      valid.push({ inventoryItemId: item.inventoryItemId, cost: null });
      continue;
    }
    const check = validateCost(item.cost, currencyCode);
    if (!check.ok) {
      results.push({
        inventoryItemId: item.inventoryItemId,
        ok: false,
        error: check.error,
      });
      continue;
    }
    valid.push({ inventoryItemId: item.inventoryItemId, cost: check.value });
  }

  for (let start = 0; start < valid.length; start += SAVE_CHUNK_SIZE) {
    const chunk = valid.slice(start, start + SAVE_CHUNK_SIZE);
    const params = chunk.map(
      (_, i) => `$id${i}: ID!, $input${i}: InventoryItemInput!`,
    );
    const fields = chunk.map(
      (_, i) => `u${i}: inventoryItemUpdate(id: $id${i}, input: $input${i}) {
          inventoryItem { id unitCost { amount currencyCode } }
          userErrors { field message }
        }`,
    );
    const variables: Record<string, unknown> = {};
    chunk.forEach((item, i) => {
      variables[`id${i}`] = item.inventoryItemId;
      variables[`input${i}`] = { cost: item.cost };
    });

    try {
      const data = await adminGraphql<Record<string, UpdatePayload | null>>(
        admin,
        `mutation CostCheckUpdateCosts(${params.join(", ")}) {\n${fields.join("\n")}\n}`,
        variables,
      );
      chunk.forEach((item, i) => {
        const payload = data[`u${i}`];
        if (!payload) {
          results.push({
            inventoryItemId: item.inventoryItemId,
            ok: false,
            error: "No response from Shopify",
          });
        } else if (payload.userErrors.length) {
          results.push({
            inventoryItemId: item.inventoryItemId,
            ok: false,
            error: payload.userErrors.map((e) => e.message).join("; "),
          });
        } else {
          results.push({
            inventoryItemId: item.inventoryItemId,
            ok: true,
            cost: payload.inventoryItem
              ? (payload.inventoryItem.unitCost?.amount ?? null)
              : item.cost,
            costCurrency: payload.inventoryItem
              ? (payload.inventoryItem.unitCost?.currencyCode ?? null)
              : item.cost === null
                ? null
                : currencyCode,
          });
        }
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      const message = error instanceof Error ? error.message : "Save failed";
      chunk.forEach((item) =>
        results.push({
          inventoryItemId: item.inventoryItemId,
          ok: false,
          error: message,
        }),
      );
    }
  }

  return results;
}

/** Store details and the scopes this installation actually has. */
export async function getAppInfo(admin: AdminApiContext) {
  const data = await adminGraphql<{
    shop: { name: string; currencyCode: string };
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  }>(
    admin,
    `#graphql
      query CostCheckAppInfo {
        shop {
          name
          currencyCode
        }
        currentAppInstallation {
          accessScopes {
            handle
          }
        }
      }`,
    {},
  );
  const granted = data.currentAppInstallation.accessScopes.map((s) => s.handle);
  // A write scope implies the matching read scope.
  const has = (scope: string) =>
    granted.includes(scope) ||
    (scope.startsWith("read_") &&
      granted.includes(scope.replace("read_", "write_")));

  return {
    shopName: data.shop.name,
    currencyCode: data.shop.currencyCode,
    grantedScopes: granted,
    missingScopes: REQUIRED_SCOPES.filter((scope) => !has(scope)),
  };
}

const SETTINGS_NAMESPACE = "costcheck";
const MIN_MARGIN_KEY = "min_margin";
export const DEFAULT_MIN_MARGIN = 30;

/**
 * Shop currency plus the merchant's minimum margin setting. The setting is an
 * app-data metafield on this app's installation (no database, no extra scope).
 */
export async function getShopContext(admin: AdminApiContext) {
  const data = await adminGraphql<{
    shop: { currencyCode: string };
    currentAppInstallation: { metafield: { value: string } | null };
  }>(
    admin,
    `#graphql
      query CostCheckContext($namespace: String!, $key: String!) {
        shop {
          currencyCode
        }
        currentAppInstallation {
          metafield(namespace: $namespace, key: $key) {
            value
          }
        }
      }`,
    { namespace: SETTINGS_NAMESPACE, key: MIN_MARGIN_KEY },
  );
  const stored = Number(data.currentAppInstallation.metafield?.value);
  return {
    currencyCode: data.shop.currencyCode,
    minMargin: Number.isFinite(stored) ? stored : DEFAULT_MIN_MARGIN,
  };
}

export async function saveMinMargin(admin: AdminApiContext, minMargin: number) {
  const installation = await adminGraphql<{
    currentAppInstallation: { id: string };
  }>(
    admin,
    `#graphql
      query CostCheckInstallation {
        currentAppInstallation {
          id
        }
      }`,
    {},
  );
  const data = await adminGraphql<{
    metafieldsSet: {
      metafields: Array<{ value: string }> | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    admin,
    `#graphql
      mutation CostCheckSaveSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            value
          }
          userErrors {
            message
          }
        }
      }`,
    {
      metafields: [
        {
          ownerId: installation.currentAppInstallation.id,
          namespace: SETTINGS_NAMESPACE,
          key: MIN_MARGIN_KEY,
          type: "number_decimal",
          value: String(minMargin),
        },
      ],
    },
  );
  if (data.metafieldsSet.userErrors.length) {
    throw new ShopifyApiError(
      data.metafieldsSet.userErrors.map((e) => e.message).join("; "),
    );
  }
  return Number(data.metafieldsSet.metafields?.[0]?.value ?? minMargin);
}
