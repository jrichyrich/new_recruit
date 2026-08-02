# RosterPilot Keychain broker

`NewRecruitKeychainBroker.swift` is the macOS-only credential boundary for the
RosterPilot local agent, New Recruit companion, and Tessera adapter.

- It uses the traditional macOS login Keychain so the local command-line
  companion does not require Apple developer provisioning.
- Each provider has a dedicated service identifier and application ACL that
  trusts the installed broker itself for restricted reads.
- Configuration uses an AppKit secure text field.
- Only the isolated browser worker invokes `retrieve`; MCP and CLI responses
  never contain the returned credential.
- The broker does not perform network requests or browser automation.

The supported first-time installation is:

```bash
npm run setup -- --profile new-recruit
# Or use --profile tessera when both browser-backed providers are needed.
```

Build the broker alone with:

```bash
npm run companion:build
```

The ignored staging executable is written to
`native/.build/rosterpilot-keychain`. The lower-level
`npm run rosterpilot -- agent install` command copies it to
`~/Library/Application Support/RosterPilot/bin/rosterpilot-keychain`, writes
the per-user LaunchAgent, and starts the local service.

After the checkout or runtime changes, use
`npm run rosterpilot -- agent ensure-current`. Inspect provider readiness with
`npm run rosterpilot -- new-recruit status` and
`npm run rosterpilot -- tessera status`; personal-plugin verification is a
separate Codex integration check.

The broker may be used directly only for manual `configure` and `forget`
commands. Automated roster work calls the local agent, which invokes
`retrieve` inside its short-lived browser worker and never returns the
credential through its socket.
