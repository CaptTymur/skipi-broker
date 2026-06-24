# Changelog — host-check

## 0.1.0 — 2026-06-23
- Initial bundled first-party fixture plugin for Skipi home plugin-host readiness.
- Exercises the narrow hostApi: `theme.get`/`theme.subscribe`, `storage.get`/`storage.set`
  (namespaced per plugin), `navigation.setTitle`/`navigation.closePlugin`,
  `permissions.listGranted`.
- Capabilities: `local_storage`, `theme` only. No network, documents, account,
  analytics; no server upload; no remote code.
