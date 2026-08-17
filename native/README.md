# RosterPilot Keychain broker

`NewRecruitKeychainBroker.swift` is the macOS-only Keychain boundary retained
for the RosterPilot local agent, New Recruit companion, and Tessera adapter.

- `status` reports whether a New Recruit or Tessera item is present. It never
  serializes the stored value.
- `retrieve` returns the stored credential only to the installed LaunchAgent.
  That process holds a per-install consumer token next to the broker and in
  its environment. Unauthenticated callers, including Cursor or Codex shells,
  receive `CREDENTIAL_RELEASE_DISABLED`.
- `configure` stores a credential through a local AppKit prompt. Values are
  never returned to MCP clients.
- `forget` remains available so an existing New Recruit or Tessera item can be
  removed.

Build and install the broker with:

```bash
npm run companion:build
npm run rosterpilot -- agent install
```

The ignored staging executable is written to
`native/.build/rosterpilot-keychain`. The lower-level
`npm run rosterpilot -- agent install` command copies it to
`~/Library/Application Support/RosterPilot/bin/rosterpilot-keychain`, writes
the per-user LaunchAgent, and starts the local service.

After the checkout or runtime changes, use `npm run rosterpilot -- agent
ensure-current`. The first retrieve after a new broker binary may prompt
macOS Keychain for access; choose Always Allow so later local-agent runs can
unlock New Recruit or Tessera Premium without a shell-side retrieve.

The installed broker retains explicit `forget new-recruit` and `forget tessera`
commands so stored items can be removed without reading their values.
