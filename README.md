# wukusy-mcp

MCP server for the [Wukusy](https://wukusy.app) dropshipper panel. Wukusy has no public API, so this
scrapes the server-rendered pages for reads and replays the panel's own AJAX calls for writes.
Unofficial: it can break whenever Wukusy changes its pages.

## Setup

```sh
npm install
npm run login        # opens Chrome; log in by hand, the session cookie is saved
claude mcp add --scope user wukusy -- node "$PWD/server.mjs"
```

The session is stored in `~/.config/wukusy-mcp/session.json` (override with `WUKUSY_SESSION_FILE`,
or pass a raw cookie in `WUKUSY_COOKIE`). It lasts about 3 weeks; run `npm run login` again when
tools report the session expired.

## Tools

- **Read:** `get_analytics`, `list_orders`, `list_profit`, `list_ndr`, `get_wallet`, `list_products`,
  `list_wishlist`, `list_stores`, `search`, `search_catalog`, `get_catalog_product`, `get_profile`, `get_page`
- **Write:** orders (confirm, cancel, address, NDR), products and wishlist, stores, profile and bank
  details, document upload, support tickets, wallet recharge and withdrawal

## How writes work

Every write is a form POST with the page's `X-CSRF-TOKEN`. Wukusy replies `{"status":"success"}`
(served as `text/html`); anything else, including HTTP 200 with an error payload or an HTML page, is
raised as an error. A 403 CSRF mismatch refreshes the token and retries once.

Each write tool takes:

- `dry_run: true` returns the exact request (sensitive numbers masked) without sending it.
- `confirm: true` is required to actually send.

`update_profile` / `update_bank_details` read the current profile and resend it with only the named
fields changed, because the endpoint overwrites the whole profile.
