# Contributing to CostCheck

Thanks for helping make CostCheck better! Bug reports, ideas, docs fixes and code are all welcome.

## Ways to help

- **Report a bug:** [open a bug report](https://github.com/Sachinsagarmishra/costcheck_shopify_app/issues/new?template=bug_report.yml).
- **Suggest a feature:** [open a feature request](https://github.com/Sachinsagarmishra/costcheck_shopify_app/issues/new?template=feature_request.yml).
- **Improve the docs:** typos, clearer steps and translations are all valuable.
- **Send code:** pick an open issue, or open one first for bigger changes so we can agree on the approach.

## Local setup

You need Node.js 20.19+ or 22.12+ and a free [Shopify Partner](https://dev.shopify.com) account with a development store.

```bash
git clone https://github.com/<your-username>/costcheck_shopify_app.git
cd costcheck_shopify_app
npm install
npm run dev
```

On the first `npm run dev`, choose **Create a new app**. This links the project to your own test app and writes its `client_id` to `shopify.app.toml`. **Don't commit your `client_id` change** in a pull request.

## Project principles

CostCheck is intentionally small. Please keep changes in line with these:

- **Lightweight:** no storefront code, no new runtime dependencies unless really needed. Prefer the template's Polaris web components.
- **Minimal permissions:** new features should work with `read_products` and `write_inventory`. If a feature needs a new scope, explain why in the issue first.
- **No data copies:** don't store product or customer data. Fetch on demand.
- **No tracking or third-party services.**
- **GraphQL Admin API** only, with pagination and rate limits handled.

## Pull request checklist

1. Create a branch from `main`, for example `fix/csv-semicolon` or `feat/vendor-sort`.
2. Make your change. Keep it focused, one topic per PR.
3. Run the checks (CI runs them too):
   ```bash
   npm run typecheck
   npm run lint
   npm run build
   ```
4. Test it in a development store. Include screenshots for UI changes.
5. Open the PR and fill in the template.

## Code style

- TypeScript, formatted with Prettier (`npx prettier --write <file>`).
- Server-only code lives in `*.server.ts` files. Shared helpers go in `app/lib/`.
- Match the surrounding code: naming, comment density, and small focused functions.

## Code of conduct

By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
