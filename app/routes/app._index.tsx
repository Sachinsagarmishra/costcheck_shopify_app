import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getShopContext } from "../lib/costcheck.server";
import type { SaveResult, VariantRow } from "../lib/costcheck.server";
import { MAX_SAVE_ITEMS } from "../lib/constants";
import { buildImportPreview } from "../lib/cost-import";
import type { ImportPreview } from "../lib/cost-import";
import { downloadFile, toCsv } from "../lib/csv";
import {
  costFromPercentOfPrice,
  formatMoney,
  isZeroAmount,
  marginPercent,
  priceForMargin,
  validateCost,
} from "../lib/money";
import { postCosts, useScan } from "../lib/scan-context";
import type { SaveResponse, SettingsResponse } from "./api.costs";

const ROWS_PER_PAGE = 50;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { currencyCode, minMargin } = await getShopContext(admin);

  return {
    currencyCode,
    minMargin,
    // admin.shopify.com/store/<handle> uses the myshopify subdomain.
    storeHandle: session.shop.replace(/\.myshopify\.com$/, ""),
  };
};

type Filter = "all" | "missing" | "zero" | "low";
type RowStatus = { type: "success" | "error"; message: string };
type SaveItem = { inventoryItemId: string; cost: string | null };
type SortKey =
  | "default"
  | "margin-asc"
  | "margin-desc"
  | "price-desc"
  | "price-asc"
  | "missing-first"
  | "title";
type LastSave = { items: SaveItem[]; count: number };

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "default", label: "Default order" },
  { value: "missing-first", label: "Missing cost first" },
  { value: "margin-asc", label: "Margin: low to high" },
  { value: "margin-desc", label: "Margin: high to low" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "title", label: "Product: A to Z" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "ARCHIVED", label: "Archived" },
];

const uniqueSorted = (values: string[]) =>
  [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Margin used for sorting; rows without a real cost sort last. */
function sortMargin(row: VariantRow) {
  if (row.cost === null || isZeroAmount(row.cost)) return null;
  return marginPercent(row.price, row.cost);
}

function compareRows(a: VariantRow, b: VariantRow, key: SortKey) {
  const byNullable = (x: number | null, y: number | null, dir: 1 | -1) => {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir;
  };
  switch (key) {
    case "margin-asc":
      return byNullable(sortMargin(a), sortMargin(b), 1);
    case "margin-desc":
      return byNullable(sortMargin(a), sortMargin(b), -1);
    case "price-desc":
      return Number(b.price) - Number(a.price);
    case "price-asc":
      return Number(a.price) - Number(b.price);
    case "missing-first":
      return Number(a.cost !== null) - Number(b.cost !== null);
    case "title":
      return (
        a.productTitle.localeCompare(b.productTitle) ||
        a.variantTitle.localeCompare(b.variantTitle)
      );
    default:
      return 0;
  }
}

function numericId(gid: string) {
  return gid.split("/").pop() ?? "";
}

const formatPercent = (value: number) => `${value.toFixed(1)}%`;

/** Saved cost is a real (non-zero) cost whose margin is below the minimum. */
function isLowMargin(row: VariantRow, minMargin: number) {
  if (row.cost === null || isZeroAmount(row.cost)) return false;
  const margin = marginPercent(row.price, row.cost);
  return margin !== null && margin < minMargin;
}

/** Attaches a DOM event listener to a Polaris web component (React 18 can't). */
function useElementEvent(
  ref: RefObject<HTMLElement | null>,
  eventName: string,
  handler: (event: Event) => void,
) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (event: Event) => handlerRef.current(event);
    element.addEventListener(eventName, listener);
    return () => element.removeEventListener(eventName, listener);
  }, [ref, eventName]);
}

/** Controlled wrapper around <s-text-field> (value is set as a DOM property). */
function TextField({
  label,
  value,
  onChange,
  hideLabel,
  placeholder,
  suffix,
  error,
  onKeyDown,
  register,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hideLabel?: boolean;
  placeholder?: string;
  suffix?: string;
  error?: string;
  onKeyDown?: (event: KeyboardEvent) => void;
  register?: (element: HTMLElement | null) => void;
}) {
  const ref = useRef<HTMLElementTagNameMap["s-text-field"]>(null);
  useEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  }, [value]);
  useEffect(() => {
    if (!register) return;
    register(ref.current);
    return () => register(null);
  }, [register]);
  useElementEvent(ref, "input", (event) =>
    onChange((event.currentTarget as HTMLInputElement).value),
  );
  useElementEvent(ref, "keydown", (event) =>
    onKeyDown?.(event as KeyboardEvent),
  );
  return (
    <s-text-field
      ref={ref}
      label={label}
      {...(hideLabel
        ? { labelAccessibilityVisibility: "exclusive" as const }
        : {})}
      {...(placeholder ? { placeholder } : {})}
      {...(suffix ? { suffix } : {})}
      {...(error ? { error } : {})}
    />
  );
}

/** Controlled wrapper around <s-select>. */
function Select({
  label,
  value,
  options,
  onChange,
  hideLabel,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  hideLabel?: boolean;
}) {
  const ref = useRef<HTMLElementTagNameMap["s-select"]>(null);
  useEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  });
  useElementEvent(ref, "change", (event) =>
    onChange((event.currentTarget as HTMLSelectElement).value),
  );
  return (
    <s-select
      ref={ref}
      label={label}
      {...(hideLabel
        ? { labelAccessibilityVisibility: "exclusive" as const }
        : {})}
    >
      {options.map((option) => (
        <s-option key={option.value} value={option.value}>
          {option.label}
        </s-option>
      ))}
    </s-select>
  );
}

function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLElementTagNameMap["s-search-field"]>(null);
  useEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  }, [value]);
  useElementEvent(ref, "input", (event) =>
    onChange((event.currentTarget as HTMLInputElement).value),
  );
  return (
    <s-search-field
      ref={ref}
      label="Search"
      labelAccessibilityVisibility="exclusive"
      placeholder="Search product, variant, SKU or vendor"
    />
  );
}

/** Focuses the inner input of a Polaris field. */
function focusField(element: HTMLElement | undefined) {
  if (!element) return;
  const input = element.shadowRoot?.querySelector<HTMLInputElement>("input");
  if (input) {
    input.focus();
    input.select();
  } else {
    element.focus();
  }
}

export default function Index() {
  const loaderData = useLoaderData<typeof loader>();
  const { currencyCode, storeHandle } = loaderData;
  const shopify = useAppBridge();

  const {
    rows,
    setRows,
    hasScanned,
    scanning,
    scanError,
    startScan: runScan,
    stopScan,
  } = useScan();
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [lastSave, setLastSave] = useState<LastSave | null>(null);
  const fieldElements = useRef(new Map<string, HTMLElement>());
  const [showFilters, setShowFilters] = useState(false);
  const marginModalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);

  const [minMargin, setMinMargin] = useState(loaderData.minMargin);
  const [marginInput, setMarginInput] = useState(String(loaderData.minMargin));
  const [savingSettings, setSavingSettings] = useState(false);

  const [bulkValue, setBulkValue] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);

  const [importPreview, setImportPreview] = useState<ImportPreview | null>(
    null,
  );
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startScan = () => {
    if (scanning) return;
    setDrafts({});
    setSelected(new Set());
    setStatuses({});
    setSaveError(null);
    setImportPreview(null);
    setImportError(null);
    setLastSave(null);
    setPage(0);
    void runScan();
  };

  const applySaveResults = (results: SaveResult[], undo = false) => {
    const byItem = new Map(results.map((r) => [r.inventoryItemId, r]));
    const nextStatuses: Record<string, RowStatus> = {};
    const savedVariants = new Set<string>();

    for (const row of rows) {
      const result = byItem.get(row.inventoryItemId);
      if (!result) continue;
      if (result.ok) {
        nextStatuses[row.variantId] = {
          type: "success",
          message: undo ? "Restored" : "Saved",
        };
        savedVariants.add(row.variantId);
      } else {
        nextStatuses[row.variantId] = { type: "error", message: result.error };
      }
    }

    setRows((prev) =>
      prev.map((row) => {
        const result = byItem.get(row.inventoryItemId);
        return result?.ok
          ? { ...row, cost: result.cost, costCurrency: result.costCurrency }
          : row;
      }),
    );
    setStatuses((prev) => ({ ...prev, ...nextStatuses }));
    setDrafts((prev) => {
      const next = { ...prev };
      savedVariants.forEach((id) => delete next[id]);
      return next;
    });
    setSelected((prev) => {
      const next = new Set(prev);
      savedVariants.forEach((id) => next.delete(id));
      return next;
    });

    const failed = results.filter((r) => !r.ok).length;
    const saved = results.length - failed;
    const verb = undo ? "restored" : "saved";
    shopify.toast.show(
      failed
        ? `${saved} ${verb}, ${failed} failed`
        : `${saved} cost${saved === 1 ? "" : "s"} ${verb}`,
      failed ? { isError: true } : undefined,
    );
  };

  /** Saves in chunks the server accepts; results are shown per row. */
  const saveItems = async (items: SaveItem[], undo = false) => {
    // Remember the costs before this save so it can be undone.
    const previous = new Map(rows.map((r) => [r.inventoryItemId, r.cost]));
    setSaving(true);
    setSaveError(null);
    const results: SaveResult[] = [];
    for (let start = 0; start < items.length; start += MAX_SAVE_ITEMS) {
      const data = await postCosts<SaveResponse>({
        intent: "save",
        items: items.slice(start, start + MAX_SAVE_ITEMS),
      });
      if ("error" in data) {
        setSaveError(data.error);
        break;
      }
      results.push(...data.results);
    }
    setSaving(false);
    if (results.length) applySaveResults(results, undo);
    if (undo) {
      setLastSave(null);
    } else {
      const undoItems = results
        .filter((r) => r.ok && previous.has(r.inventoryItemId))
        .map((r) => ({
          inventoryItemId: r.inventoryItemId,
          cost: previous.get(r.inventoryItemId) ?? null,
        }));
      if (undoItems.length)
        setLastSave({ items: undoItems, count: undoItems.length });
    }
    return results;
  };

  const undoLastSave = async () => {
    if (!lastSave || saving) return;
    await saveItems(lastSave.items, true);
  };

  const filterOptions = useMemo(
    () => ({
      vendors: uniqueSorted(rows.map((r) => r.vendor)),
      types: uniqueSorted(rows.map((r) => r.productType)),
      tags: uniqueSorted(rows.flatMap((r) => r.tags)),
    }),
    [rows],
  );

  // Search + product attribute filters (vendor, type, tag, status).
  const attributeRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (statusFilter === "all" || r.productStatus === statusFilter) &&
        (vendorFilter === "all" || r.vendor === vendorFilter) &&
        (typeFilter === "all" || r.productType === typeFilter) &&
        (tagFilter === "all" || r.tags.includes(tagFilter)) &&
        (!query ||
          [r.productTitle, r.variantTitle, r.sku, r.vendor].some((v) =>
            v.toLowerCase().includes(query),
          )),
    );
  }, [rows, search, statusFilter, vendorFilter, typeFilter, tagFilter]);

  const counts = useMemo(
    () => ({
      missing: attributeRows.filter((r) => r.cost === null).length,
      zero: attributeRows.filter((r) => r.cost !== null && isZeroAmount(r.cost))
        .length,
      low: attributeRows.filter((r) => isLowMargin(r, minMargin)).length,
    }),
    [attributeRows, minMargin],
  );

  const filteredRows = useMemo(() => {
    // Rows saved since the filter was chosen stay visible so their result shows.
    const justSaved = (r: VariantRow) =>
      statuses[r.variantId]?.type === "success";
    let result = attributeRows;
    if (filter === "missing")
      result = result.filter((r) => r.cost === null || justSaved(r));
    if (filter === "zero") {
      result = result.filter(
        (r) => (r.cost !== null && isZeroAmount(r.cost)) || justSaved(r),
      );
    }
    if (filter === "low")
      result = result.filter((r) => isLowMargin(r, minMargin) || justSaved(r));
    return sortKey === "default"
      ? result
      : [...result].sort((a, b) => compareRows(a, b, sortKey));
  }, [attributeRows, filter, statuses, minMargin, sortKey]);

  const hasAttributeFilter =
    search.trim() !== "" ||
    vendorFilter !== "all" ||
    typeFilter !== "all" ||
    tagFilter !== "all" ||
    statusFilter !== "all";

  const clearAttributeFilters = () => {
    setSearch("");
    setVendorFilter("all");
    setTypeFilter("all");
    setTagFilter("all");
    setStatusFilter("all");
    setPage(0);
  };

  /** Wraps a filter setter so changing it returns to page 1. */
  const onFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(0);
  };

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / ROWS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = filteredRows.slice(
    currentPage * ROWS_PER_PAGE,
    (currentPage + 1) * ROWS_PER_PAGE,
  );

  const registerField = useCallback(
    (variantId: string, element: HTMLElement | null) => {
      if (element) fieldElements.current.set(variantId, element);
      else fieldElements.current.delete(variantId);
    },
    [],
  );

  // Enter / ↓ moves to the next row's cost field, Shift+Enter / ↑ to the previous one.
  const onFieldKey = (variantId: string, event: KeyboardEvent) => {
    const down =
      (event.key === "Enter" && !event.shiftKey) || event.key === "ArrowDown";
    const up =
      (event.key === "Enter" && event.shiftKey) || event.key === "ArrowUp";
    if (!down && !up) return;
    event.preventDefault();
    const ids = pageRows.map((r) => r.variantId);
    const target = ids[ids.indexOf(variantId) + (down ? 1 : -1)];
    if (target) focusField(fieldElements.current.get(target));
  };

  const changeFilter = (next: Filter) => {
    setFilter(next);
    setPage(0);
    setStatuses((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([, s]) => s.type === "error"),
      ),
    );
  };

  const setDraft = useCallback((row: VariantRow, value: string) => {
    setDrafts((prev) => ({ ...prev, [row.variantId]: value }));
    setStatuses((prev) => {
      if (!prev[row.variantId]) return prev;
      const next = { ...prev };
      delete next[row.variantId];
      return next;
    });
    // Editing a cost selects the row so it is included in "Save Selected".
    setSelected((prev) =>
      prev.has(row.variantId) ? prev : new Set(prev).add(row.variantId),
    );
  }, []);

  const toggleRow = useCallback((variantId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(variantId);
      else next.delete(variantId);
      return next;
    });
  }, []);

  const allOnPageSelected =
    pageRows.length > 0 && pageRows.every((r) => selected.has(r.variantId));
  const someOnPageSelected = pageRows.some((r) => selected.has(r.variantId));

  const toggleAllOnPage = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      pageRows.forEach((r) =>
        checked ? next.add(r.variantId) : next.delete(r.variantId),
      );
      return next;
    });
  };

  const selectAllFiltered = () =>
    setSelected(new Set(filteredRows.map((r) => r.variantId)));

  const saveSelected = async () => {
    if (saving) return;
    setSaveError(null);
    const items: SaveItem[] = [];
    const localErrors: Record<string, RowStatus> = {};

    for (const row of rows.filter((r) => selected.has(r.variantId))) {
      const check = validateCost(
        drafts[row.variantId] ?? row.cost ?? "",
        currencyCode,
      );
      if (!check.ok)
        localErrors[row.variantId] = { type: "error", message: check.error };
      else
        items.push({ inventoryItemId: row.inventoryItemId, cost: check.value });
    }

    setStatuses((prev) => ({ ...prev, ...localErrors }));
    if (items.length === 0) {
      if (!Object.keys(localErrors).length)
        setSaveError("Select at least one row to save.");
      return;
    }
    await saveItems(items);
  };

  // Bulk: fill the cost field of every selected row (saved with Save Selected).
  const applyBulk = (mode: "amount" | "percent") => {
    setBulkError(null);
    const targets = rows.filter((r) => selected.has(r.variantId));
    if (!targets.length) {
      setBulkError("Select rows first.");
      return;
    }
    const next: Record<string, string> = {};
    if (mode === "amount") {
      const check = validateCost(bulkValue, currencyCode);
      if (!check.ok) {
        setBulkError(check.error);
        return;
      }
      targets.forEach((r) => (next[r.variantId] = check.value));
    } else {
      const percent = Number(bulkValue.trim());
      if (
        bulkValue.trim() === "" ||
        !Number.isFinite(percent) ||
        percent < 0 ||
        percent > 1000
      ) {
        setBulkError("Enter a percentage between 0 and 1000");
        return;
      }
      targets.forEach((r) => {
        const cost = costFromPercentOfPrice(r.price, percent, currencyCode);
        if (cost !== null) next[r.variantId] = cost;
      });
    }
    setDrafts((prev) => ({ ...prev, ...next }));
    setStatuses((prev) => {
      const copy = { ...prev };
      Object.keys(next).forEach((id) => delete copy[id]);
      return copy;
    });
    shopify.toast.show(
      `Filled ${Object.keys(next).length} rows. Review, then Save Selected.`,
    );
  };

  const exportCsv = () => {
    const header = [
      "product_title",
      "variant_title",
      "sku",
      "price",
      "cost",
      "currency",
      "margin_percent",
      "variant_id",
      "inventory_item_id",
    ];
    const lines = filteredRows.map((r) => {
      const margin = marginPercent(r.price, r.cost);
      return [
        r.productTitle,
        r.variantTitle,
        r.sku,
        r.price,
        r.cost ?? "",
        r.costCurrency ?? currencyCode,
        margin === null ? "" : margin.toFixed(1),
        numericId(r.variantId),
        numericId(r.inventoryItemId),
      ];
    });
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(`costcheck-${filter}-${date}.csv`, toCsv([header, ...lines]));
  };

  const onImportFile = async (file: File | undefined) => {
    setImportError(null);
    setImportPreview(null);
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setImportError("File is larger than 5 MB.");
      return;
    }
    const preview = buildImportPreview(
      await file.text(),
      file.name,
      rows,
      currencyCode,
    );
    if ("error" in preview) setImportError(preview.error);
    else setImportPreview(preview);
  };

  const saveImport = async () => {
    if (!importPreview || saving) return;
    const items = importPreview.changes.map((c) => ({
      inventoryItemId: c.row.inventoryItemId,
      cost: c.newCost,
    }));
    const results = await saveItems(items);
    if (results.length) setImportPreview(null);
  };

  const saveMinMarginSetting = async () => {
    const value = Number(marginInput.trim());
    if (
      marginInput.trim() === "" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value >= 100
    ) {
      shopify.toast.show("Minimum margin must be between 0 and 99.99%", {
        isError: true,
      });
      return;
    }
    setSavingSettings(true);
    const data = await postCosts<SettingsResponse>({
      intent: "settings",
      minMargin: value,
    });
    setSavingSettings(false);
    if ("error" in data) {
      shopify.toast.show(data.error, { isError: true });
      return;
    }
    setMinMargin(data.minMargin);
    setMarginInput(String(data.minMargin));
    marginModalRef.current?.hideOverlay();
    shopify.toast.show(`Minimum margin set to ${data.minMargin}%`);
  };

  const selectedCount = selected.size;

  const tableRef = useRef<HTMLElementTagNameMap["s-table"]>(null);
  useElementEvent(tableRef, "nextpage", () =>
    setPage(Math.min(currentPage + 1, pageCount - 1)),
  );
  useElementEvent(tableRef, "previouspage", () =>
    setPage(Math.max(currentPage - 1, 0)),
  );

  const headerCheckboxRef = useRef<HTMLElementTagNameMap["s-checkbox"]>(null);
  useEffect(() => {
    if (!headerCheckboxRef.current) return;
    headerCheckboxRef.current.checked = allOnPageSelected;
    headerCheckboxRef.current.indeterminate =
      someOnPageSelected && !allOnPageSelected;
  });
  useElementEvent(headerCheckboxRef, "change", (event) =>
    toggleAllOnPage((event.currentTarget as HTMLInputElement).checked),
  );

  const busy = scanning || saving;
  const activeFilterCount = [
    vendorFilter,
    typeFilter,
    tagFilter,
    statusFilter,
  ].filter((value) => value !== "all").length;
  const allFilteredSelected =
    filteredRows.length > 0 &&
    filteredRows.every((r) => selected.has(r.variantId));

  const tab = (value: Filter, label: string, count: number) => (
    <s-button
      variant={filter === value ? "primary" : "tertiary"}
      onClick={() => changeFilter(value)}
    >
      {label} {count}
    </s-button>
  );

  return (
    <s-page heading="CostCheck" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={startScan}
        {...(scanning ? { loading: true } : {})}
      >
        {hasScanned ? "Rescan" : "Scan Products"}
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={exportCsv}
        {...(!hasScanned || busy || !filteredRows.length
          ? { disabled: true }
          : {})}
      >
        Export CSV
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => fileInputRef.current?.click()}
        {...(!hasScanned || busy ? { disabled: true } : {})}
      >
        Import CSV
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => {
          setMarginInput(String(minMargin));
          marginModalRef.current?.showOverlay();
        }}
      >
        Min. margin {minMargin}%
      </s-button>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(event) => {
          void onImportFile(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />

      <s-modal
        ref={marginModalRef}
        id="margin-settings"
        heading="Minimum margin"
        size="small"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Variants with a gross margin, (price − cost) ÷ price, below this are
            shown in red with the price needed to reach it.
          </s-paragraph>
          <TextField
            label="Minimum margin"
            value={marginInput}
            onChange={setMarginInput}
            suffix="%"
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={saveMinMarginSetting}
          {...(savingSettings ? { loading: true } : {})}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => marginModalRef.current?.hideOverlay()}
        >
          Cancel
        </s-button>
      </s-modal>

      {scanError && (
        <s-banner tone="critical" heading="Scan failed">
          <s-paragraph>{scanError}</s-paragraph>
        </s-banner>
      )}
      {saveError && (
        <s-banner tone="critical" heading="Couldn't save">
          <s-paragraph>{saveError}</s-paragraph>
        </s-banner>
      )}
      {importError && (
        <s-banner tone="critical" heading="Couldn't read that CSV">
          <s-paragraph>{importError}</s-paragraph>
        </s-banner>
      )}

      {!hasScanned ? (
        <s-section>
          <s-box padding="large">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-heading>Find products with missing costs</s-heading>
              <s-paragraph>
                Scan your catalog to see every variant&apos;s cost and margin,
                then fix costs one by one, in bulk, or from a CSV.
              </s-paragraph>
              <s-button variant="primary" onClick={startScan}>
                Scan Products
              </s-button>
            </s-stack>
          </s-box>
        </s-section>
      ) : (
        <>
          {importPreview && (
            <ImportPreviewSection
              preview={importPreview}
              currencyCode={currencyCode}
              saving={saving}
              onSave={saveImport}
              onCancel={() => setImportPreview(null)}
            />
          )}

          <s-section padding="none">
            <s-table
              ref={tableRef}
              paginate
              {...(currentPage < pageCount - 1 ? { hasNextPage: true } : {})}
              {...(currentPage > 0 ? { hasPreviousPage: true } : {})}
              {...(scanning && rows.length === 0 ? { loading: true } : {})}
            >
              <s-stack slot="filters" direction="block" gap="small">
                <s-grid
                  gridTemplateColumns="1fr auto auto"
                  gap="small"
                  alignItems="center"
                >
                  <SearchField value={search} onChange={onFilter(setSearch)} />
                  <s-button
                    icon="filter"
                    onClick={() => setShowFilters((open) => !open)}
                    {...(showFilters ? { variant: "secondary" as const } : {})}
                  >
                    Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
                  </s-button>
                  <Select
                    label="Sort by"
                    hideLabel
                    value={sortKey}
                    onChange={(value) => {
                      setSortKey(value as SortKey);
                      setPage(0);
                    }}
                    options={SORT_OPTIONS}
                  />
                </s-grid>

                {showFilters && (
                  <s-grid
                    gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))"
                    gap="small"
                    alignItems="end"
                  >
                    <Select
                      label="Vendor"
                      value={vendorFilter}
                      onChange={onFilter(setVendorFilter)}
                      options={[
                        { value: "all", label: "All vendors" },
                        ...filterOptions.vendors.map((v) => ({
                          value: v,
                          label: v,
                        })),
                      ]}
                    />
                    <Select
                      label="Product type"
                      value={typeFilter}
                      onChange={onFilter(setTypeFilter)}
                      options={[
                        { value: "all", label: "All types" },
                        ...filterOptions.types.map((t) => ({
                          value: t,
                          label: t,
                        })),
                      ]}
                    />
                    <Select
                      label="Tag"
                      value={tagFilter}
                      onChange={onFilter(setTagFilter)}
                      options={[
                        { value: "all", label: "All tags" },
                        ...filterOptions.tags.map((t) => ({
                          value: t,
                          label: t,
                        })),
                      ]}
                    />
                    <Select
                      label="Status"
                      value={statusFilter}
                      onChange={onFilter(setStatusFilter)}
                      options={STATUS_OPTIONS}
                    />
                  </s-grid>
                )}

                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="small"
                  alignItems="center"
                >
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    alignItems="center"
                  >
                    {tab("all", "All", attributeRows.length)}
                    {tab("missing", "Missing cost", counts.missing)}
                    {tab("zero", "Zero cost", counts.zero)}
                    {tab("low", "Low margin", counts.low)}
                  </s-stack>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    {scanning ? (
                      <>
                        <s-spinner accessibilityLabel="Scanning" size="base" />
                        <s-text color="subdued">Scanning… {rows.length}</s-text>
                        <s-button variant="tertiary" onClick={stopScan}>
                          Stop
                        </s-button>
                      </>
                    ) : (
                      <>
                        {hasAttributeFilter && (
                          <s-button
                            variant="tertiary"
                            onClick={clearAttributeFilters}
                          >
                            Clear filters
                          </s-button>
                        )}
                        {lastSave && (
                          <s-button
                            variant="tertiary"
                            icon="undo"
                            onClick={undoLastSave}
                            {...(saving ? { disabled: true } : {})}
                          >
                            Undo last save
                          </s-button>
                        )}
                      </>
                    )}
                  </s-stack>
                </s-grid>

                {selectedCount > 0 && (
                  <s-box
                    padding="small"
                    background="subdued"
                    borderRadius="base"
                  >
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-text type="strong">{selectedCount} selected</s-text>
                      {!allFilteredSelected && (
                        <s-button
                          variant="tertiary"
                          onClick={selectAllFiltered}
                        >
                          Select all {filteredRows.length}
                        </s-button>
                      )}
                      <div style={{ width: 150 }}>
                        <TextField
                          label="Amount or percentage"
                          hideLabel
                          value={bulkValue}
                          onChange={(value) => {
                            setBulkValue(value);
                            setBulkError(null);
                          }}
                          placeholder="12.50 or 40"
                          {...(bulkError ? { error: bulkError } : {})}
                        />
                      </div>
                      <s-button
                        onClick={() => applyBulk("amount")}
                        {...(busy ? { disabled: true } : {})}
                      >
                        Set cost
                      </s-button>
                      <s-button
                        onClick={() => applyBulk("percent")}
                        {...(busy ? { disabled: true } : {})}
                      >
                        Set % of price
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() => setSelected(new Set())}
                      >
                        Clear
                      </s-button>
                      <s-button
                        variant="primary"
                        onClick={saveSelected}
                        {...(saving ? { loading: true } : {})}
                        {...(scanning ? { disabled: true } : {})}
                      >
                        Save {selectedCount}
                      </s-button>
                    </s-stack>
                  </s-box>
                )}
              </s-stack>

              <s-table-header-row>
                <s-table-header>
                  <s-checkbox
                    ref={headerCheckboxRef}
                    accessibilityLabel="Select all rows on this page"
                  />
                </s-table-header>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header format="currency">Price</s-table-header>
                <s-table-header>Cost ({currencyCode})</s-table-header>
                <s-table-header format="numeric">Margin</s-table-header>
                <s-table-header>Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {pageRows.map((row) => (
                  <CostRow
                    key={row.variantId}
                    row={row}
                    draft={drafts[row.variantId]}
                    selected={selected.has(row.variantId)}
                    status={statuses[row.variantId]}
                    currencyCode={currencyCode}
                    storeHandle={storeHandle}
                    minMargin={minMargin}
                    onDraft={setDraft}
                    onToggle={toggleRow}
                    registerField={registerField}
                    onFieldKey={onFieldKey}
                  />
                ))}
              </s-table-body>
            </s-table>
            {!scanning && filteredRows.length === 0 && (
              <s-box padding="large">
                <s-stack direction="block" gap="small" alignItems="center">
                  <s-text color="subdued">
                    {rows.length === 0
                      ? "No variants found."
                      : "No variants match these filters."}
                  </s-text>
                </s-stack>
              </s-box>
            )}
            {filteredRows.length > ROWS_PER_PAGE && (
              <s-box padding="small-200">
                <s-text color="subdued">
                  Page {currentPage + 1} of {pageCount} · {filteredRows.length}{" "}
                  variants
                </s-text>
              </s-box>
            )}
          </s-section>
        </>
      )}
    </s-page>
  );
}

const PREVIEW_ROWS = 50;

function ImportPreviewSection({
  preview,
  currencyCode,
  saving,
  onSave,
  onCancel,
}: {
  preview: ImportPreview;
  currencyCode: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { changes, issues } = preview;
  return (
    <s-section heading={`Import preview: ${preview.fileName}`}>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          <s-text type="strong">{changes.length} costs will change</s-text>
          {" · "}
          {preview.unchanged} already match · {preview.blank} rows with a blank
          cost skipped · {issues.length} rows with problems. Rows were matched
          by {preview.matchedBy}. Nothing is saved until you click Save.
        </s-paragraph>

        {changes.length > 0 && (
          <s-table variant="list">
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header format="currency">Current cost</s-table-header>
              <s-table-header format="currency">New cost</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {changes.slice(0, PREVIEW_ROWS).map((change) => (
                <s-table-row key={change.row.variantId}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-thumbnail
                        size="small-200"
                        alt={change.row.imageAlt}
                        {...(change.row.imageUrl
                          ? { src: change.row.imageUrl }
                          : {})}
                      />
                      <s-text>
                        {change.row.productTitle}
                        {change.row.variantTitle !== "Default Title"
                          ? ` · ${change.row.variantTitle}`
                          : ""}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{change.row.sku || "—"}</s-table-cell>
                  <s-table-cell>
                    {change.row.cost === null
                      ? "Not set"
                      : formatMoney(change.row.cost, currencyCode)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text type="strong">
                      {formatMoney(change.newCost, currencyCode)}
                    </s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {changes.length > PREVIEW_ROWS && (
          <s-text color="subdued">
            …and {changes.length - PREVIEW_ROWS} more.
          </s-text>
        )}

        {issues.length > 0 && (
          <s-banner
            tone="warning"
            heading={`${issues.length} rows will be skipped`}
          >
            <s-unordered-list>
              {issues.slice(0, 20).map((issue) => (
                <s-list-item key={`${issue.line}-${issue.key}`}>
                  Line {issue.line} ({issue.key}): {issue.reason}
                </s-list-item>
              ))}
            </s-unordered-list>
            {issues.length > 20 && (
              <s-paragraph>…and {issues.length - 20} more.</s-paragraph>
            )}
          </s-banner>
        )}

        <s-stack direction="inline" gap="small">
          <s-button
            variant="primary"
            onClick={onSave}
            {...(saving ? { loading: true } : {})}
            {...(!changes.length ? { disabled: true } : {})}
          >
            Save {changes.length} costs
          </s-button>
          <s-button onClick={onCancel} {...(saving ? { disabled: true } : {})}>
            Cancel
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

type CostRowProps = {
  row: VariantRow;
  draft: string | undefined;
  selected: boolean;
  status: RowStatus | undefined;
  currencyCode: string;
  storeHandle: string;
  minMargin: number;
  onDraft: (row: VariantRow, value: string) => void;
  onToggle: (variantId: string, checked: boolean) => void;
  registerField: (variantId: string, element: HTMLElement | null) => void;
  onFieldKey: (variantId: string, event: KeyboardEvent) => void;
};

function CostRow({
  row,
  draft,
  selected,
  status,
  currencyCode,
  storeHandle,
  minMargin,
  onDraft,
  onToggle,
  registerField,
  onFieldKey,
}: CostRowProps) {
  const checkboxRef = useRef<HTMLElementTagNameMap["s-checkbox"]>(null);
  const register = useCallback(
    (element: HTMLElement | null) => registerField(row.variantId, element),
    [registerField, row.variantId],
  );
  const value = draft ?? row.cost ?? "";
  const validation =
    draft !== undefined && draft.trim() !== ""
      ? validateCost(draft, currencyCode)
      : null;

  // Web component properties are set directly; React 18 would stringify booleans.
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.checked = selected;
  }, [selected]);
  useElementEvent(checkboxRef, "change", (event) =>
    onToggle(row.variantId, (event.currentTarget as HTMLInputElement).checked),
  );

  const variantLabel =
    row.variantTitle === "Default Title" ? "—" : row.variantTitle;
  const fieldError =
    validation && !validation.ok ? validation.error : undefined;

  // Margin follows what's typed (when valid) so the merchant sees the effect live.
  const effectiveCost = validation?.ok ? validation.value : row.cost;
  const margin =
    effectiveCost === null || isZeroAmount(effectiveCost)
      ? null
      : marginPercent(row.price, effectiveCost);
  const suggestedPrice =
    margin !== null && margin < minMargin && effectiveCost !== null
      ? priceForMargin(effectiveCost, minMargin, currencyCode)
      : null;

  const meta = [
    variantLabel !== "—" ? variantLabel : "",
    row.sku ? `SKU ${row.sku}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <s-table-row>
      <s-table-cell>
        <s-checkbox
          ref={checkboxRef}
          accessibilityLabel={`Select ${row.productTitle} ${variantLabel}`}
        />
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-thumbnail
            size="small"
            alt={row.imageAlt}
            {...(row.imageUrl ? { src: row.imageUrl } : {})}
          />
          <s-stack direction="block" gap="none">
            <s-link
              href={`https://admin.shopify.com/store/${storeHandle}/products/${numericId(row.productId)}`}
              target="_blank"
            >
              {row.productTitle}
            </s-link>
            {meta && <s-text color="subdued">{meta}</s-text>}
          </s-stack>
        </s-stack>
      </s-table-cell>
      <s-table-cell>{formatMoney(row.price, currencyCode)}</s-table-cell>
      <s-table-cell>
        <div style={{ minWidth: 110, maxWidth: 140 }}>
          <TextField
            label={`Cost for ${row.productTitle} ${variantLabel}`}
            hideLabel
            value={value}
            onChange={(next) => onDraft(row, next)}
            placeholder={row.cost === null ? "Not set" : undefined}
            error={fieldError}
            register={register}
            onKeyDown={(event) => onFieldKey(row.variantId, event)}
          />
        </div>
      </s-table-cell>
      <s-table-cell>
        {margin === null ? (
          <s-text color="subdued">—</s-text>
        ) : margin < minMargin ? (
          <s-stack direction="block" gap="none">
            <s-text tone="critical" type="strong">
              {formatPercent(margin)}
            </s-text>
            {suggestedPrice && (
              <s-text color="subdued">
                Min. price {formatMoney(suggestedPrice, currencyCode)}
              </s-text>
            )}
          </s-stack>
        ) : (
          <s-text>{formatPercent(margin)}</s-text>
        )}
      </s-table-cell>
      <s-table-cell>
        {status ? (
          <s-badge tone={status.type === "success" ? "success" : "critical"}>
            {status.message}
          </s-badge>
        ) : row.cost === null ? (
          <s-badge tone="warning">Missing</s-badge>
        ) : isZeroAmount(row.cost) ? (
          <s-badge tone="caution">Zero</s-badge>
        ) : null}
      </s-table-cell>
    </s-table-row>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
