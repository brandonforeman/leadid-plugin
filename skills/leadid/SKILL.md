---
name: leadid
description: Use when the user asks who visited their website, wants to look up or filter LeadID leads, or search companies/contacts in LeadID. Read-only.
---

# LeadID

Tools (MCP server `leadid`), all read-only:

- `search_leads` (reliable) / `get_lead` (experimental: ids from search_leads currently return "Visitor was not found"; fall back to search_leads data): who visited the site (`product`: `plusEmployee` for B2B company/job data, `plusPerson` for consumer data). Always pass a date range via `filters.visitBeginDate` / `visitEndDate` (`plusPerson` spells it `visitEnddate`).
- `search_companies` / `get_company`: Who To Contact company database.
- `search_contacts`: contact availability flags only (e.g. `hasCompanyEmail`), not contact details.
- `list_icps`, `get_download_limits`: saved Ideal Customer Profiles and remaining contact download quota.
- `list_reference_values`: call this first to get valid values for any range/industry/state/job-level style filter, and send the returned **key**.

Rules:
- Never invent leads, companies, contacts or field values; report only what the tools return, and say so when results are empty.
- Results are paged (max 200 per page, 50 pages). Report `totalRecords` and use `hasNextPage` rather than guessing.
- Credit-spending actions (revealing contact details, bulk jobs) and all writes are NOT available. If asked, say the user must do it in the LeadID dashboard.
- On a 403, the account probably lacks the plan for that product; on 429, stop and tell the user the rate limit was hit.
