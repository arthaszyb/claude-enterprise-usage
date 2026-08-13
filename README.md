# Claude Enterprise Usage

Shows the current Claude Code quota in VS Code and records a local month-to-date history.

It uses the OAuth credential already created by `claude /login`; it never sends credentials to any service other than Anthropic. A completed Claude Code response updates the current-response and session estimates immediately from its local session log. The API-backed Enterprise monthly usage is cached and requested at most once per 15 minutes; after an HTTP 429, the extension keeps the last known monthly figure and waits at least 30 minutes (or Anthropic's `Retry-After` value).

`Current` is the cost of the complete current chat turn, including every model request caused by tool calls. `Session` is the whole Claude Code session. Both deduplicate repeated streaming log entries by request ID and use public API list pricing. `Monthly` is the server-reported Enterprise spend/limit and is authoritative; it can lag a just-completed request briefly. Personal-plan 5-hour and weekly quotas are intentionally not shown.

## Enterprise caveat

Claude's member Usage page is the source of truth for Enterprise monthly usage. The same OAuth usage endpoint used by Claude Code generally exposes rolling quota windows, but it does not currently document a guaranteed monthly Enterprise field. When such a field is returned, this extension displays it. Otherwise it estimates month-to-date activity from locally observed refreshes and labels it as an estimate.

For exact organization-wide spend, use the Enterprise Analytics API with an administrator-provided Analytics API key rather than a personal credential.

## Releases

Marketplace releases are published from GitHub Actions when a semantic version tag such as `v0.3.1` is pushed. The tag must match the version in `package.json`.

One-time setup: under the `SeanYangZhou` publisher in Visual Studio Marketplace, configure trusted publishing for:

- GitHub owner: `arthaszyb`
- Repository: `claude-enterprise-usage`
- Workflow: `.github/workflows/publish.yml`

To release a patch update:

```sh
npm run version:patch
git push origin main --follow-tags
```

Use `version:minor` for backward-compatible features and `version:major` for breaking changes. VS Code automatically offers Marketplace updates to users who have extension auto-update enabled.
