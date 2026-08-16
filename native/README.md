# RosterPilot Keychain broker

`NewRecruitKeychainBroker.swift` is the macOS-only Keychain boundary retained
for the RosterPilot local agent, New Recruit companion, and Tessera adapter.

- Reusable credential release is disabled until a separately authenticated,
  sealed native consumer exists.
- `configure`, `status`, and `retrieve` return
  `CREDENTIAL_RELEASE_DISABLED`; `status` may report whether a legacy item is
  present, but no command requests or serializes its value.
- `forget` remains available so an existing New Recruit or Tessera item can be
  removed.
- The response schema has no username, password, or licence-key field, and the
  broker never requests `kSecReturnData`.

Build and install the fail-closed broker with:

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
ensure-current`. Provider status reports credential state `disabled` while
local roster work and the explicit Tessera local-engine backend remain
available.

The installed broker retains explicit `forget new-recruit` and `forget tessera`
commands so legacy stored items can be removed without reading their values.
