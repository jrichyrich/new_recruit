import AppKit
import Security

private let service = "com.jasonricha.rosterpilot.newrecruit"
private let account = "credentials"

private struct StoredCredentials: Codable {
    let username: String
    let password: String
}

private struct BrokerResponse: Codable {
    let ok: Bool
    let configured: Bool?
    let username: String?
    let password: String?
    let code: String?
    let message: String?

    init(
        ok: Bool,
        configured: Bool? = nil,
        username: String? = nil,
        password: String? = nil,
        code: String? = nil,
        message: String? = nil
    ) {
        self.ok = ok
        self.configured = configured
        self.username = username
        self.password = password
        self.code = code
        self.message = message
    }
}

private func emit(_ response: BrokerResponse, exitCode: Int32 = 0) -> Never {
    let encoder = JSONEncoder()
    let data = (try? encoder.encode(response)) ?? Data(
        #"{"ok":false,"code":"ENCODING_FAILED","message":"Response encoding failed."}"#.utf8
    )
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(exitCode)
}

private func baseQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

private func keychainStatus() -> OSStatus {
    var query = baseQuery()
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &result)
}

private func emitKeychainFailure(_ status: OSStatus, operation: String) -> Never {
    if status == errSecMissingEntitlement {
        emit(
            BrokerResponse(
                ok: false,
                code: "KEYCHAIN_ENTITLEMENT_MISSING",
                message:
                    "The RosterPilot broker does not have a Keychain entitlement required by this operation."
            ),
            exitCode: 4
        )
    }
    emit(
        BrokerResponse(
            ok: false,
            code: "KEYCHAIN_\(operation)_FAILED",
            message: "Keychain returned status \(status)."
        ),
        exitCode: 2
    )
}

private func configure() -> Never {
    let initialStatus = keychainStatus()
    guard initialStatus == errSecSuccess || initialStatus == errSecItemNotFound else {
        emitKeychainFailure(initialStatus, operation: "STATUS")
    }

    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()

    let alert = NSAlert()
    alert.messageText = "Configure New Recruit"
    alert.informativeText =
        "RosterPilot stores this credential in your macOS login Keychain. It is never returned to MCP clients."
    alert.addButton(withTitle: "Save")
    alert.addButton(withTitle: "Cancel")

    let username = NSTextField(frame: NSRect(x: 0, y: 32, width: 360, height: 24))
    username.placeholderString = "New Recruit username or email"
    let password = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
    password.placeholderString = "New Recruit password"
    let fields = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 56))
    fields.addSubview(username)
    fields.addSubview(password)
    alert.accessoryView = fields

    // A command-line executable does not become an active AppKit application
    // automatically. Force the alert to become the key window and direct
    // keyboard input to the username field before starting the modal loop.
    alert.window.initialFirstResponder = username
    application.activate(ignoringOtherApps: true)
    alert.window.makeKeyAndOrderFront(nil)
    guard alert.runModal() == .alertFirstButtonReturn else {
        emit(BrokerResponse(ok: false, code: "CONFIGURATION_CANCELLED", message: "Credential configuration was cancelled."), exitCode: 2)
    }
    let trimmedUsername = username.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedUsername.isEmpty, !password.stringValue.isEmpty else {
        emit(BrokerResponse(ok: false, code: "INVALID_CREDENTIAL", message: "Username and password are required."), exitCode: 2)
    }

    guard let encoded = try? JSONEncoder().encode(
        StoredCredentials(username: trimmedUsername, password: password.stringValue)
    ) else {
        emit(BrokerResponse(ok: false, code: "ENCODING_FAILED", message: "Credential encoding failed."), exitCode: 2)
    }

    var access: SecAccess?
    let accessStatus = SecAccessCreate(
        "RosterPilot New Recruit credential" as CFString,
        nil,
        &access
    )
    guard accessStatus == errSecSuccess, let access else {
        emit(
            BrokerResponse(
                ok: false,
                code: "ACCESS_CONTROL_FAILED",
                message: "Keychain access control could not be created (status \(accessStatus))."
            ),
            exitCode: 2
        )
    }

    let attributes: [String: Any] = [
        kSecValueData as String: encoded,
        kSecAttrAccess as String: access,
        kSecAttrLabel as String: "RosterPilot New Recruit credential",
    ]
    let status: OSStatus
    if initialStatus == errSecSuccess {
        status = SecItemUpdate(
            baseQuery() as CFDictionary,
            attributes as CFDictionary
        )
    } else {
        var query = baseQuery()
        for (key, value) in attributes {
            query[key] = value
        }
        status = SecItemAdd(query as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
        emitKeychainFailure(status, operation: "WRITE")
    }
    emit(BrokerResponse(ok: true, configured: true))
}

private func retrieve() -> Never {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseOperationPrompt as String] =
        "Allow RosterPilot to sign in to New Recruit for this delivery."
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecUserCanceled || status == errSecAuthFailed {
        emit(BrokerResponse(ok: false, code: "AUTHENTICATION_CANCELLED", message: "Keychain authorization was cancelled."), exitCode: 3)
    }
    guard status == errSecSuccess, let data = result as? Data else {
        let code = status == errSecItemNotFound ? "CREDENTIALS_NOT_CONFIGURED" : "KEYCHAIN_READ_FAILED"
        emit(BrokerResponse(ok: false, code: code, message: "Keychain returned status \(status)."), exitCode: 2)
    }
    guard let credentials = try? JSONDecoder().decode(StoredCredentials.self, from: data) else {
        emit(BrokerResponse(ok: false, code: "DECODING_FAILED", message: "Stored credential could not be decoded."), exitCode: 2)
    }
    emit(BrokerResponse(ok: true, configured: true, username: credentials.username, password: credentials.password))
}

private func forget() -> Never {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        emitKeychainFailure(status, operation: "DELETE")
    }
    emit(BrokerResponse(ok: true, configured: false))
}

switch CommandLine.arguments.dropFirst().first ?? "status" {
case "configure":
    configure()
case "status":
    let status = keychainStatus()
    if status == errSecSuccess {
        emit(BrokerResponse(ok: true, configured: true))
    }
    if status == errSecItemNotFound {
        emit(BrokerResponse(ok: true, configured: false))
    }
    emitKeychainFailure(status, operation: "STATUS")
case "retrieve":
    retrieve()
case "forget":
    forget()
default:
    emit(BrokerResponse(ok: false, code: "UNKNOWN_COMMAND", message: "Expected configure, status, retrieve, or forget."), exitCode: 2)
}
