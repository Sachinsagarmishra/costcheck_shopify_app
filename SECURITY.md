# Security Policy

## Supported versions

Security fixes are made on the latest version on the `main` branch.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report them privately instead, in either of these ways:

- GitHub: go to the **Security** tab → **Report a vulnerability**, or
- Email: **hi@sachindesign.com** with the subject `CostCheck security`.

Please include:

- What the issue is and what an attacker could do with it
- Steps to reproduce, or a proof of concept
- The affected file or route, if you know it

You'll get a reply within 7 days. Once the issue is confirmed, we'll work on a fix and credit you in the release notes, unless you'd rather stay anonymous.

## Scope

Examples of what we especially want to hear about:

- Bypassing Shopify session or webhook (HMAC) verification
- Reading or changing another shop's data
- Injection through CSV import or export
- Leaking access tokens or secrets

## Notes for self-hosters

- Never commit `.env` files, `prisma/dev.sqlite`, or your app's **Client secret**.
- Keep dependencies updated. Dependabot alerts are recommended.
- Use HTTPS and a managed database in production.
