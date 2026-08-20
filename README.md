# Claude Enterprise Usage

Shows the current Claude Code quota in VS Code and records a local month-to-date history.

It uses the OAuth credential already created by `claude /login`; it never sends credentials to any service other than Anthropic. A completed Claude Code response updates the current-response and session estimates immediately from its local session log. The API-backed Enterprise monthly usage is cached and requested at most once per 15 minutes; after an HTTP 429, the extension keeps the last known monthly figure and waits at least 30 minutes (or Anthropic's `Retry-After` value).

`Current` is the cost of the complete current chat turn, including every model request caused by tool calls. `Session` is the whole Claude Code session. Both deduplicate repeated streaming log entries by request ID and use public API list pricing. `Monthly` is the server-reported Enterprise spend/limit and is authoritative; it can lag a just-completed request briefly. Personal-plan 5-hour and weekly quotas are intentionally not shown.

## Enterprise caveat

Claude's member Usage page is the source of truth for Enterprise monthly usage. The same OAuth usage endpoint used by Claude Code generally exposes rolling quota windows, but it does not currently document a guaranteed monthly Enterprise field. When such a field is returned, this extension displays it. Otherwise it estimates month-to-date activity from locally observed refreshes and labels it as an estimate.

For exact organization-wide spend, use the Enterprise Analytics API with an administrator-provided Analytics API key rather than a personal credential.

## Releases

Releases are built by GitHub Actions when a semantic version tag such as `v0.3.1` is pushed. The tag must match the version in `package.json`. Every tag creates a GitHub Release with the installable VSIX attached. If `VSCE_PAT` is configured, the same package is also published to Visual Studio Marketplace.

One-time Marketplace setup:

1. Create an Azure DevOps Personal Access Token for **All accessible organizations** with **Marketplace → Manage** permission.
2. Open the GitHub repository's **Settings → Secrets and variables → Actions**.
3. Add a repository secret named `VSCE_PAT` containing that token.

To release a patch update:

```sh
npm run version:patch
git push origin main --follow-tags
```

Use `version:minor` for backward-compatible features and `version:major` for breaking changes. VS Code automatically offers Marketplace updates to users who have extension auto-update enabled.

> Microsoft plans to retire global Azure DevOps PATs on December 1, 2026. The Marketplace does not yet expose GitHub OIDC trusted-publisher policies generally. Migrate when Microsoft makes that flow generally available, or use the documented Microsoft Entra workload-identity flow in Azure Pipelines.
