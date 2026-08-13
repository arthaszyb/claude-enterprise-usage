# Changelog

All notable changes to this extension are documented here.

## 0.3.0

- Calculate the complete current chat-turn cost rather than only the final model request.
- Deduplicate repeated Claude Code streaming records by request ID.
- Correct cache creation pricing so 1-hour cache tokens are not counted twice.
- Show Enterprise monthly usage without personal-plan session or weekly quotas.
- Cache the last successful monthly response and back off after HTTP 429 responses.

