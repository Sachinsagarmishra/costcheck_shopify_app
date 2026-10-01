import type { VariantRow } from "./costcheck.server";
import { parseCsv } from "./csv";
import { validateCost } from "./money";

export type ImportChange = { row: VariantRow; newCost: string; line: number };
export type ImportIssue = { line: number; key: string; reason: string };

export type ImportPreview = {
  fileName: string;
  matchedBy: string;
  changes: ImportChange[];
  unchanged: number;
  blank: number;
  issues: ImportIssue[];
};

// Accepted header names (lower-case). Includes Shopify's own product export
// columns ("Variant SKU", "Cost per item") and CostCheck's export columns.
const HEADERS = {
  inventoryItemId: ["inventory_item_id", "inventory item id"],
  variantId: ["variant_id", "variant id"],
  sku: ["sku", "variant sku"],
  cost: ["cost", "unit cost", "unit_cost", "cost per item", "variant cost"],
};

const numericId = (value: string) => value.trim().split("/").pop() ?? "";

/** Strips currency symbols/codes around a number, e.g. "$12.50" or "12.50 USD". */
function cleanCost(value: string) {
  return value
    .trim()
    .replace(/^[^\d.,-]+/, "")
    .replace(/\s*[A-Za-z]{3}$/, "")
    .trim();
}

export function buildImportPreview(
  text: string,
  fileName: string,
  rows: VariantRow[],
  currencyCode: string,
): ImportPreview | { error: string } {
  const table = parseCsv(text);
  if (table.length < 2) return { error: "The file has no data rows." };

  const header = table[0].map((h) => h.trim().toLowerCase());
  const column = (names: string[]) => header.findIndex((h) => names.includes(h));
  const costCol = column(HEADERS.cost);
  const keyCols = [
    { name: "inventory item ID", index: column(HEADERS.inventoryItemId) },
    { name: "variant ID", index: column(HEADERS.variantId) },
    { name: "SKU", index: column(HEADERS.sku) },
  ].filter((c) => c.index >= 0);

  if (costCol < 0) {
    return { error: 'Missing a "cost" column. Export a CSV from CostCheck to get the right format.' };
  }
  if (!keyCols.length) {
    return { error: 'Missing a "sku" (or "variant_id") column to match rows to your variants.' };
  }

  const byItem = new Map(rows.map((r) => [numericId(r.inventoryItemId), r]));
  const byVariant = new Map(rows.map((r) => [numericId(r.variantId), r]));
  const bySku = new Map<string, VariantRow[]>();
  for (const r of rows) {
    const sku = r.sku.trim().toLowerCase();
    if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), r]);
  }

  const changesByVariant = new Map<string, ImportChange>();
  const issues: ImportIssue[] = [];
  let unchanged = 0;
  let blank = 0;

  table.slice(1).forEach((cells, i) => {
    const line = i + 2; // 1-based, after the header
    if (cells.length > header.length) {
      // Usually an unquoted thousands separator, e.g. 1,234.50 split in two.
      issues.push({
        line,
        key: (cells[keyCols[0].index] ?? "").trim() || "—",
        reason: "Row has more columns than the header (remove commas from numbers)",
      });
      return;
    }
    const rawCost = (cells[costCol] ?? "").trim();
    if (rawCost === "") {
      blank++;
      return;
    }

    let match: VariantRow | undefined;
    let key = "";
    let reason = "No matching variant";
    for (const col of keyCols) {
      const value = (cells[col.index] ?? "").trim();
      if (!value) continue;
      key = value;
      if (col.name === "inventory item ID") match = byItem.get(numericId(value));
      else if (col.name === "variant ID") match = byVariant.get(numericId(value));
      else {
        const found = bySku.get(value.toLowerCase()) ?? [];
        if (found.length === 1) match = found[0];
        else if (found.length > 1) reason = `SKU is used by ${found.length} variants`;
      }
      if (match) break;
    }
    if (!key) {
      issues.push({ line, key: "—", reason: "No SKU or ID on this row" });
      return;
    }
    if (!match) {
      issues.push({ line, key, reason });
      return;
    }

    const check = validateCost(cleanCost(rawCost), currencyCode);
    if (!check.ok) {
      issues.push({ line, key, reason: `${check.error} ("${rawCost}")` });
      return;
    }
    if (match.cost !== null && Number(match.cost) === Number(check.value)) {
      unchanged++;
      return;
    }
    // A later row for the same variant wins.
    changesByVariant.set(match.variantId, { row: match, newCost: check.value, line });
  });

  return {
    fileName,
    matchedBy: keyCols.map((c) => c.name).join(", then "),
    changes: [...changesByVariant.values()],
    unchanged,
    blank,
    issues,
  };
}
