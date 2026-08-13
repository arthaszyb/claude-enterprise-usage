# Claude Enterprise Usage

Shows the current Claude Code quota in VS Code and records a local month-to-date history.

It uses the OAuth credential already created by `claude /login`; it never sends credentials to any service other than Anthropic. A completed Claude Code response updates the current-response and session estimates immediately from its local session log. The API-backed Enterprise monthly usage is cached and requested at most once per 15 minutes; after an HTTP 429, the extension keeps the last known monthly figure and waits at least 30 minutes (or Anthropic's `Retry-After` value).

`Now` and `Session` are token-based estimates using public API list pricing. `MTD` is the server-reported Enterprise spend/limit and is authoritative; it can lag a just-completed request briefly.

## Enterprise caveat

Claude's member Usage page is the source of truth for Enterprise monthly usage. The same OAuth usage endpoint used by Claude Code generally exposes rolling quota windows, but it does not currently document a guaranteed monthly Enterprise field. When such a field is returned, this extension displays it. Otherwise it estimates month-to-date activity from locally observed refreshes and labels it as an estimate.

For exact organization-wide spend, use the Enterprise Analytics API with an administrator-provided Analytics API key rather than a personal credential.
