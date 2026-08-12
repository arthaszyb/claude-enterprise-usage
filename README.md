# Claude Enterprise Usage

Shows the current Claude Code quota in VS Code and records a local month-to-date history.

It uses the OAuth credential already created by `claude /login`; it never sends credentials to any service other than Anthropic. The status bar refreshes every five minutes by default, and detects a completed Claude Code response from its local session log to update the current-response and session estimates immediately. Click it for a breakdown and a link to Claude's member Usage page.

`Now` and `Session` are token-based estimates using public API list pricing. `MTD` is the server-reported Enterprise spend/limit and is authoritative; it can lag a just-completed request briefly.

## Enterprise caveat

Claude's member Usage page is the source of truth for Enterprise monthly usage. The same OAuth usage endpoint used by Claude Code generally exposes rolling quota windows, but it does not currently document a guaranteed monthly Enterprise field. When such a field is returned, this extension displays it. Otherwise it estimates month-to-date activity from locally observed refreshes and labels it as an estimate.

For exact organization-wide spend, use the Enterprise Analytics API with an administrator-provided Analytics API key rather than a personal credential.
