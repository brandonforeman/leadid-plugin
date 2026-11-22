# LeadID plugin (Agent Plugin, v0.1.0)

LeadID from FRG: a read-only MCP server + skill for website-visitor lead intelligence. Zero dependencies; needs Node 18+.

## Setup
1. Create an API key in your LeadID dashboard (https://leadid.familyresourcegroupinc.com/) under **Configuration > API Integration** (name it and copy the key; it is shown once, max 5 keys per account).
2. Expose it to the plugin as an environment variable before launching your client:
   `export LEADID_API_KEY=...`
   Alternative: put the key in a file named `api-key` inside the plugin's `PLUGIN_DATA` directory.
   (Agent Plugins forbids secrets in `plugin.json`/`mcp.json` and expands only `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`, so the key is read from the process environment.)
3. Optional env vars:
   - `LEADID_AUTH_SCHEME`: e.g. `Bearer` to send `Authorization: Bearer <key>`. Default sends the raw key as documented.
   - `LEADID_API_BASE`: override the API base URL (default unchanged; the dashboard host above serves only the web app, not the API). Include the version path, e.g. `https://<host>/api/v1`.
   - `LEADID_CUSTOMER_ID`: partner accounts: adds `?customerId=` to act for a customer.

## Tools (all read-only)
`search_leads`, `get_lead`, `search_companies`, `get_company`, `search_contacts` (flags only), `list_reference_values`, `list_icps`, `get_download_limits`.

Not exposed: credit-spending calls (contact detail reveal, bulk jobs, bulk confirm) and every write/delete endpoint.

Limits per docs: 200 requests/20 min per IP, 5,000 calls/day per key, page size max 200, max 50 pages. +PlusEmployee / +PlusPerson endpoints need the matching plan.

`docs-cache/` holds the scraped API reference pages and merged schemas used to build the filter definitions (`server/filters.json`).
