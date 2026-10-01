import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getAppInfo } from "../lib/costcheck.server";
import { currencyDecimals } from "../lib/money";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const info = await getAppInfo(admin);
  return {
    ...info,
    decimals: currencyDecimals(info.currencyCode),
  };
};

export default function HelpPage() {
  const { currencyCode, missingScopes, decimals } = useLoaderData<typeof loader>();
  const example = decimals === 0 ? "1250" : `12.${"5".padEnd(decimals, "0")}`;

  return (
    <s-page heading="How to use CostCheck">
      {missingScopes.length > 0 && (
        <s-banner tone="critical" heading="CostCheck is missing permissions">
          <s-paragraph>
            Missing: {missingScopes.join(", ")}. Open the app again from your
            Apps list and approve the permission request, or reinstall the app.
            Scanning and saving won&apos;t work until this is fixed.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="What CostCheck does">
        <s-paragraph>
          Every product variant in Shopify has a &ldquo;Cost per item&rdquo;.
          Shopify uses it for profit and margin reports. CostCheck finds the
          variants where that cost is missing or zero, so you can fix them all
          in one place.
        </s-paragraph>
      </s-section>

      <s-section heading="Step by step">
        <s-ordered-list>
          <s-list-item>
            Open <s-link href="/app">CostCheck</s-link> and click{" "}
            <s-text type="strong">Scan Products</s-text>. The app reads all your
            variants live from Shopify. Large stores can take a little while;
            you can click Stop at any time.
          </s-list-item>
          <s-list-item>
            Use the filters: <s-text type="strong">Missing cost</s-text> shows
            variants with no cost set. <s-text type="strong">Zero cost</s-text>{" "}
            shows variants whose cost is explicitly 0.
          </s-list-item>
          <s-list-item>
            Type the correct cost in the Cost column. Editing a row selects it
            automatically. You can also tick rows with the checkboxes.
          </s-list-item>
          <s-list-item>
            Click <s-text type="strong">Save</s-text>. Each row shows{" "}
            <s-badge tone="success">Saved</s-badge> or an error explaining what
            went wrong. Rows with errors stay selected so you can fix them and
            save again.
          </s-list-item>
          <s-list-item>
            Click a product title to open that product in the Shopify admin in a
            new tab.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="Search, filter and sort">
        <s-unordered-list>
          <s-list-item>
            The <s-text type="strong">search box</s-text> matches product
            name, variant, SKU and vendor.
          </s-list-item>
          <s-list-item>
            Narrow down by <s-text type="strong">Vendor</s-text>,{" "}
            <s-text type="strong">Product type</s-text>,{" "}
            <s-text type="strong">Tag</s-text> or{" "}
            <s-text type="strong">Status</s-text> (Active, Draft, Archived).
            These combine with the Missing, Zero and Low margin buttons.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Sort by</s-text> margin, price, product name,
            or missing cost first.
          </s-list-item>
          <s-list-item>
            Export CSV and Select all always use exactly what you see after
            filtering.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Bulk cost update">
        <s-paragraph>
          Tick the rows you want (or use <s-text type="strong">Select all</s-text>{" "}
          to pick every row in the current filter). A bar appears above the
          table. Type a value there:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Set cost</s-text> gives every selected row the
            same cost, for example 12.50.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Set as % of price</s-text> calculates each
            cost from its own price. For example, 40 sets a 49.99 item to 20.00.
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          This only fills in the cost fields. Check them, then click{" "}
          <s-text type="strong">Save</s-text>.
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Tip, cost by supplier:</s-text> choose a
          Vendor filter, click Select all, enter for example 45 and click Set as
          % of price. Every product from that vendor gets a cost of 45% of
          its price.
        </s-paragraph>
      </s-section>

      <s-section heading="Undo and keyboard shortcuts">
        <s-unordered-list>
          <s-list-item>
            After saving, click <s-text type="strong">Undo last save</s-text>{" "}
            to put the previous costs back, including costs that were not set
            before. It works for the most recent save until you scan again.
          </s-list-item>
          <s-list-item>
            In a cost field, press <s-text type="strong">Enter</s-text> or{" "}
            <s-text type="strong">↓</s-text> to jump to the next row, and{" "}
            <s-text type="strong">Shift+Enter</s-text> or{" "}
            <s-text type="strong">↑</s-text> to go back. Type costs down the
            list without touching the mouse.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="CSV import and export">
        <s-ordered-list>
          <s-list-item>
            Click <s-text type="strong">Export CSV</s-text> to download the
            variants in the current filter. Open it in Excel, Numbers, or Google
            Sheets.
          </s-list-item>
          <s-list-item>
            Fill in the <s-text type="strong">cost</s-text> column and save as
            CSV. A supplier price sheet also works if it has a{" "}
            <s-text type="strong">sku</s-text> column and a{" "}
            <s-text type="strong">cost</s-text> column. Shopify&apos;s own
            product export (&ldquo;Variant SKU&rdquo; and &ldquo;Cost per
            item&rdquo;) works too.
          </s-list-item>
          <s-list-item>
            Click <s-text type="strong">Import CSV</s-text>. You&apos;ll see a
            preview first: which costs change (old and new), which rows already
            match, and which rows are skipped and why (unknown SKU, a SKU
            shared by several variants, invalid amount).
          </s-list-item>
          <s-list-item>
            Click <s-text type="strong">Save</s-text> in the preview. Nothing
            changes in your store before that.
          </s-list-item>
        </s-ordered-list>
        <s-paragraph>
          Rows are matched by inventory item ID, then variant ID, then SKU
          (not case-sensitive). Don&apos;t use commas inside numbers: write
          1234.50, not 1,234.50.
        </s-paragraph>
      </s-section>

      <s-section heading="Low-margin warning">
        <s-paragraph>
          Click <s-text type="strong">Min. margin</s-text> at the top of the
          CostCheck page to set your minimum (default 30%). It&apos;s saved
          for your store. Any variant whose gross margin, (price − cost) ÷
          price, is below it shows a red margin. Use the{" "}
          <s-text type="strong">Low margin</s-text> filter to see them all.
          Each low-margin row also shows the lowest price that would reach your
          minimum, for example &ldquo;Min. price $28.58&rdquo;. The
          Dashboard also shows how many variants are below your minimum.
        </s-paragraph>
      </s-section>

      <s-section heading="Missing vs. zero cost">
        <s-unordered-list>
          <s-list-item>
            <s-badge tone="warning">Missing</s-badge> No cost was ever entered.
            Profit reports can&apos;t include these sales.
          </s-list-item>
          <s-list-item>
            <s-badge tone="caution">Zero</s-badge> The cost was set to 0. This is
            correct for free items, but usually a mistake for products you buy
            or make. CostCheck never treats zero as missing.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Entering costs">
        <s-unordered-list>
          <s-list-item>
            Costs are in your store currency: <s-text type="strong">{currencyCode}</s-text>.
          </s-list-item>
          <s-list-item>
            Use digits and a dot, for example <s-text type="strong">{example}</s-text>.
            Don&apos;t type commas or currency symbols.
          </s-list-item>
          <s-list-item>
            {decimals === 0
              ? `${currencyCode} doesn't use decimals.`
              : `${currencyCode} allows up to ${decimals} decimal places.`}{" "}
            Negative costs are not allowed. 0 is allowed.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Troubleshooting">
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">&ldquo;Access denied&rdquo;</s-text>: the app
            doesn&apos;t have its permissions. Reopen or reinstall the app and
            approve the permission request.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Rate limiting</s-text>: on big stores Shopify
            limits how fast apps can read data. CostCheck waits and retries
            automatically, so a scan may pause briefly.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">A row shows an error after saving</s-text>:
            read the message, correct the cost, and click Save again.
          </s-list-item>
        </s-unordered-list>
      </s-section>


      <s-section heading="Need help?">
        <s-paragraph>
          If you run into any problem with CostCheck, email me at{" "}
          <s-link href="mailto:hi@sachindesign.com" target="_blank">
            hi@sachindesign.com
          </s-link>{" "}
          and I&apos;ll help you out.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Privacy">
        <s-paragraph>
          CostCheck reads products only when you click Scan and changes costs
          only when you click Save. It stores no product or customer data and
          adds nothing to your online store.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
