# REPORT — host-check (plugin smoke)

- **Plugin:** `host-check` (`app.skipi.plugins.host-check`) v0.1.0
- **Purpose:** fixture to validate a Skipi home plugin-host: bundled artifact load,
  `mount`/`unmount` lifecycle, and the narrow `hostApi`.

## Checks

- **Level 0 (logic):** registers `window.SkipiPlugins["host-check"]` with
  `mount(container, hostApi)` and `unmount()`.
- **Level 1 (UI):** renders a panel showing host theme, a namespaced storage
  counter, granted permissions, a disclaimer, and a close button.
- **Declared capabilities:** `local_storage`, `theme` only. `network`,
  `documents`, `account`, `analytics` = none; `server_upload` = false.
- **No undeclared access:** no `fetch`/`XMLHttpRequest`, no DOM access outside the
  provided container, no host globals touched beyond the passed `hostApi`.

## Host smoke (Broker)

`Apps → Проверка хоста → Установить → permissions/safety screen → Установить и
открыть → плагин монтируется → Закрыть/Отключить → unmount`. Theme follows host
light/dark. No mailbox/account/Bazaar access.
