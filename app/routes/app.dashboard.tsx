import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getShopContext } from "../lib/costcheck.server";
import type { VariantRow } from "../lib/costcheck.server";
import { isZeroAmount } from "../lib/money";
import { useScan } from "../lib/scan-context";
import { BarList, ColumnChart, Donut, INK, STATUS, StatTile } from "../components/Charts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return {
    ...(await getShopContext(admin)),
    storeHandle: session.shop.replace(/\.myshopify\.com$/, ""),
  };
};

const MARGIN_BUCKETS = [
  { label: "Loss", test: (m: number) => m < 0 },
  { label: "0–20%", test: (m: number) => m >= 0 && m < 20 },
  { label: "20–40%", test: (m: number) => m >= 20 && m < 40 },
  { label: "40–60%", test: (m: number) => m >= 40 && m < 60 },
  { label: "60%+", test: (m: number) => m >= 60 },
];

function summarize(rows: VariantRow[], minMargin: number) {
  let missing = 0;
  let zero = 0;
  let costed = 0;
  const margins: number[] = [];
  const products = new Map<
    string,
    { id: string; title: string; variants: number; needsCost: number }
  >();

  for (const row of rows) {
    const isMissing = row.cost === null;
    const isZero = row.cost !== null && isZeroAmount(row.cost);
    if (isMissing) missing++;
    else if (isZero) zero++;
    else {
      costed++;
      const price = Number(row.price);
      const cost = Number(row.cost);
      if (price > 0 && Number.isFinite(cost)) margins.push(((price - cost) / price) * 100);
    }

    const product = products.get(row.productId) ?? {
      id: row.productId,
      title: row.productTitle,
      variants: 0,
      needsCost: 0,
    };
    product.variants++;
    if (isMissing || isZero) product.needsCost++;
    products.set(row.productId, product);
  }

  const productList = [...products.values()];
  const fullyCosted = productList.filter((p) => p.needsCost === 0).length;
  const notCosted = productList.filter((p) => p.needsCost === p.variants).length;

  return {
    total: rows.length,
    missing,
    zero,
    costed,
    productCount: productList.length,
    fullyCosted,
    partlyCosted: productList.length - fullyCosted - notCosted,
    notCosted,
    averageMargin: margins.length
      ? margins.reduce((sum, m) => sum + m, 0) / margins.length
      : null,
    lossMaking: margins.filter((m) => m < 0).length,
    belowMinimum: margins.filter((m) => m < minMargin).length,
    marginBuckets: MARGIN_BUCKETS.map((bucket) => ({
      label: bucket.label,
      value: margins.filter(bucket.test).length,
    })),
    marginSample: margins.length,
    topNeedsCost: productList
      .filter((p) => p.needsCost > 0)
      .sort((a, b) => b.needsCost - a.needsCost || a.title.localeCompare(b.title))
      .slice(0, 8),
  };
}

const share = (value: number, total: number) =>
  total > 0 ? `${Math.round((value / total) * 100)}% of variants` : "—";

const cardStyle: CSSProperties = {
  background: INK.surface,
  borderRadius: 12,
  padding: 20,
  boxShadow: "0 0 0 1px rgba(11,11,11,0.08), 0 1px 2px rgba(11,11,11,0.06)",
  minWidth: 0,
};

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section style={cardStyle}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 650, color: INK.primary }}>{title}</h2>
      {subtitle && (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: INK.muted }}>{subtitle}</p>
      )}
      <div style={{ marginTop: 16 }}>{children}</div>
    </section>
  );
}

export default function Dashboard() {
  const { currencyCode, storeHandle, minMargin } = useLoaderData<typeof loader>();
  const { rows, hasScanned, scanning, scanError, scannedAt, startScan, stopScan } = useScan();
  const stats = useMemo(() => summarize(rows, minMargin), [rows, minMargin]);

  return (
    <s-page heading="Dashboard">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => void startScan()}
        {...(scanning ? { loading: true } : {})}
      >
        {hasScanned ? "Scan again" : "Scan Products"}
      </s-button>

      {scanError && (
        <s-banner tone="critical" heading="Scan failed">
          <s-paragraph>{scanError}</s-paragraph>
        </s-banner>
      )}

      {!hasScanned ? (
        <s-section>
          <s-stack direction="block" gap="base" alignItems="center">
            <s-heading>No scan yet</s-heading>
            <s-paragraph>
              Scan your products to see how many variants are missing a cost,
              how healthy your margins are, and which products need attention
              first. Results stay in this browser tab only.
            </s-paragraph>
            <s-button variant="primary" onClick={() => void startScan()}>
              Scan Products
            </s-button>
          </s-stack>
        </s-section>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <s-stack direction="inline" gap="base" alignItems="center">
            {scanning ? (
              <>
                <s-spinner accessibilityLabel="Scanning" size="base" />
                <s-text>Scanning… {stats.total.toLocaleString()} variants so far</s-text>
                <s-button variant="tertiary" onClick={stopScan}>
                  Stop
                </s-button>
              </>
            ) : (
              <s-text color="subdued">
                {stats.total.toLocaleString()} variants across{" "}
                {stats.productCount.toLocaleString()} products
                {scannedAt ? ` · scanned at ${scannedAt.toLocaleTimeString()}` : ""}
              </s-text>
            )}
          </s-stack>

          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
            }}
          >
            <StatTile
              label="Variants scanned"
              value={stats.total.toLocaleString()}
              detail={`${stats.productCount.toLocaleString()} products`}
            />
            <StatTile
              label="Missing cost"
              value={stats.missing.toLocaleString()}
              detail={share(stats.missing, stats.total)}
              accent={STATUS.critical}
            />
            <StatTile
              label="Zero cost"
              value={stats.zero.toLocaleString()}
              detail={share(stats.zero, stats.total)}
              accent={STATUS.warning}
            />
            <StatTile
              label="Cost set"
              value={stats.costed.toLocaleString()}
              detail={share(stats.costed, stats.total)}
              accent={STATUS.good}
            />
            <StatTile
              label={`Below ${minMargin}% margin`}
              value={stats.belowMinimum.toLocaleString()}
              detail={
                stats.marginSample
                  ? `${Math.round((stats.belowMinimum / stats.marginSample) * 100)}% of costed variants`
                  : "Needs variants with a cost"
              }
              accent={STATUS.critical}
            />
            <StatTile
              label="Average margin"
              value={stats.averageMargin === null ? "—" : `${stats.averageMargin.toFixed(1)}%`}
              detail={
                stats.marginSample
                  ? `${stats.marginSample.toLocaleString()} variants with a cost`
                  : "Needs variants with a cost"
              }
            />
          </div>

          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
            }}
          >
            <Card title="Variant cost status" subtitle="Share of all variants">
              <Donut
                centerLabel="variants"
                segments={[
                  { label: "Cost set", value: stats.costed, color: STATUS.good },
                  {
                    label: "Missing cost",
                    value: stats.missing,
                    color: STATUS.critical,
                    hint: "Never entered",
                  },
                  {
                    label: "Zero cost",
                    value: stats.zero,
                    color: STATUS.warning,
                    hint: "Explicitly 0",
                  },
                ]}
              />
            </Card>

            <Card title="Products by cost coverage" subtitle="Based on each product's variants">
              <Donut
                centerLabel="products"
                segments={[
                  {
                    label: "Fully costed",
                    value: stats.fullyCosted,
                    color: STATUS.good,
                    hint: "Every variant has a cost",
                  },
                  {
                    label: "Partly costed",
                    value: stats.partlyCosted,
                    color: STATUS.warning,
                    hint: "Some variants need a cost",
                  },
                  {
                    label: "No cost",
                    value: stats.notCosted,
                    color: STATUS.critical,
                    hint: "No variant has a cost",
                  },
                ]}
              />
            </Card>

            <Card
              title="Margin distribution"
              subtitle={`Variants with a cost, by gross margin: (price − cost) ÷ price · ${currencyCode}`}
            >
              {stats.marginSample ? (
                <>
                  <ColumnChart bars={stats.marginBuckets} valueSuffix=" variants" />
                  <p style={{ margin: "12px 0 0", fontSize: 13, color: INK.secondary }}>
                    {stats.belowMinimum.toLocaleString()} variant
                    {stats.belowMinimum === 1 ? " is" : "s are"} below your {minMargin}% minimum
                    margin. Use the Low margin filter on the CostCheck page to review them.
                  </p>
                  {stats.lossMaking > 0 && (
                    <p style={{ margin: "12px 0 0", fontSize: 13, color: INK.secondary }}>
                      {stats.lossMaking.toLocaleString()} variant
                      {stats.lossMaking === 1 ? " costs" : "s cost"} more than{" "}
                      {stats.lossMaking === 1 ? "its" : "their"} selling price.
                    </p>
                  )}
                </>
              ) : (
                <s-text color="subdued">
                  No variants with a cost above zero yet. Add costs on the
                  CostCheck page to see margins here.
                </s-text>
              )}
            </Card>

            <Card
              title="Products that need costs"
              subtitle="Variants missing a cost or set to zero, top 8"
            >
              {stats.topNeedsCost.length ? (
                <BarList
                  color={STATUS.critical}
                  valueSuffix=""
                  bars={stats.topNeedsCost.map((p) => ({
                    label: p.title,
                    value: p.needsCost,
                    detail: p.id,
                  }))}
                  renderLabel={(bar) => (
                    <s-link
                      href={`https://admin.shopify.com/store/${storeHandle}/products/${bar.detail?.split("/").pop()}`}
                      target="_blank"
                    >
                      {bar.label}
                    </s-link>
                  )}
                />
              ) : (
                <s-text color="subdued">Every product has a cost. Nice work!</s-text>
              )}
            </Card>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
