# RosterPilot New Recruit Keychain broker

`NewRecruitKeychainBroker.swift` is the macOS-only credential boundary for the
local New Recruit companion.

- It uses the traditional macOS login Keychain so the local command-line
  companion does not require Apple developer provisioning.
- The item has a dedicated service identifier and an application ACL that
  trusts the broker itself for restricted reads.
- Configuration uses an AppKit secure text field.
- Only the isolated browser worker invokes `retrieve`; MCP and CLI responses
  never contain the returned credential.
- The broker does not perform network requests or browser automation.

Build it with:

```bash
npm run companion:build
```

The ignored executable is written to `native/.build/rosterpilot-keychain`.
