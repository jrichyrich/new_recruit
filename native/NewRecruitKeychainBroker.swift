import AppKit
import Foundation
import Security

private enum Provider: String {
    case newRecruit = "new-recruit"
    case tessera = "tessera"

    var service: String {
        switch self {
        case .newRecruit: "com.jasonricha.rosterpilot.newrecruit"
        case .tessera: "com.jasonricha.rosterpilot.tessera"
        }
    }

    var account: String {
        switch self {
        case .newRecruit: "credentials"
        case .tessera: "license-key"
        }
    }

    var label: String {
        switch self {
        case .newRecruit: "RosterPilot New Recruit credential"
        case .tessera: "RosterPilot Tessera premium key"
        }
    }
}

private struct StoredCredentials: Codable {
    let username: String
    let password: String
}

private struct StoredTesseraCredential: Codable {
    let licenseKey: String
}

private struct BrokerResponse: Codable {
    let ok: Bool
    let configured: Bool?
    let username: String?
    let password: String?
    let licenseKey: String?
    let code: String?
    let message: String?

    init(
        ok: Bool,
        configured: Bool? = nil,
        username: String? = nil,
        password: String? = nil,
        licenseKey: String? = nil,
        code: String? = nil,
        message: String? = nil
    ) {
        self.ok = ok
        self.configured = configured
        self.username = username
        self.password = password
        self.licenseKey = licenseKey
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

private func baseQuery(_ provider: Provider) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: provider.service,
        kSecAttrAccount as String: provider.account,
    ]
}

private func keychainStatus(_ provider: Provider) -> OSStatus {
    var query = baseQuery(provider)
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
    if status == errSecInteractionNotAllowed || status == errSecNotAvailable {
        emit(
            BrokerResponse(
                ok: false,
                code: "KEYCHAIN_LOCKED",
                message: "The macOS login Keychain is locked or unavailable."
            ),
            exitCode: 3
        )
    }
    if status == errSecParam {
        emit(
            BrokerResponse(
                ok: false,
                code: "KEYCHAIN_ACCESS_UNAVAILABLE",
                message:
                    "This process cannot access the macOS login Keychain. Use the installed RosterPilot local agent."
            ),
            exitCode: 4
        )
    }
    let detail =
        SecCopyErrorMessageString(status, nil) as String?
        ?? "Unknown Keychain error"
    emit(
        BrokerResponse(
            ok: false,
            code: "KEYCHAIN_\(operation)_FAILED",
            message: "Keychain returned status \(status): \(detail)."
        ),
        exitCode: 2
    )
}

private func credentialReleaseDisabled(_ provider: Provider) -> Never {
    emit(
        BrokerResponse(
            ok: false,
            code: "CREDENTIAL_RELEASE_DISABLED",
            message:
                "Reusable \(provider.rawValue) credential release is disabled until RosterPilot has an authenticated native consumer. Local workflows remain available."
        ),
        exitCode: 5
    )
}

private func constantTimeEquals(_ left: String, _ right: String) -> Bool {
    let leftBytes = Array(left.utf8)
    let rightBytes = Array(right.utf8)
    var difference = leftBytes.count ^ rightBytes.count
    let limit = min(leftBytes.count, rightBytes.count)
    if limit > 0 {
        for index in 0..<limit {
            difference |= Int(leftBytes[index] ^ rightBytes[index])
        }
    }
    return difference == 0
}

private func authorizedKeychainConsumer() -> Bool {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0])
        .resolvingSymlinksInPath()
    let tokenURL = executable.appendingPathExtension("consumer")
    guard
        let expected = try? String(contentsOf: tokenURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
        !expected.isEmpty,
        let provided = ProcessInfo.processInfo.environment[
            "ROSTERPILOT_KEYCHAIN_CONSUMER_TOKEN"
        ]?.trimmingCharacters(in: .whitespacesAndNewlines),
        !provided.isEmpty
    else {
        return false
    }
    return constantTimeEquals(expected, provided)
}

private func configure(_ provider: Provider) -> Never {
    let initialStatus = keychainStatus(provider)
    guard initialStatus == errSecSuccess || initialStatus == errSecItemNotFound else {
        emitKeychainFailure(initialStatus, operation: "STATUS")
    }

    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()

    let alert = NSAlert()
    alert.messageText =
        provider == .newRecruit ? "Configure New Recruit" : "Configure Tessera Premium"
    alert.informativeText =
        "RosterPilot stores this credential in your macOS login Keychain. It is never returned to MCP clients."
    alert.addButton(withTitle: "Save")
    alert.addButton(withTitle: "Cancel")

    let firstField = provider == .newRecruit
        ? NSTextField(frame: NSRect(x: 0, y: 32, width: 360, height: 24))
        : NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
    firstField.placeholderString =
        provider == .newRecruit
            ? "New Recruit username or email"
            : "Tessera licence key"
    let password = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
    password.placeholderString = "New Recruit password"
    let fields = NSView(
        frame: NSRect(
            x: 0,
            y: 0,
            width: 360,
            height: provider == .newRecruit ? 56 : 24
        )
    )
    fields.addSubview(firstField)
    if provider == .newRecruit {
        fields.addSubview(password)
    }
    alert.accessoryView = fields

    // A command-line executable does not become an active AppKit application
    // automatically. Force the alert to become the key window and direct
    // keyboard input to the username field before starting the modal loop.
    alert.window.initialFirstResponder = firstField
    application.activate(ignoringOtherApps: true)
    alert.window.makeKeyAndOrderFront(nil)
    guard alert.runModal() == .alertFirstButtonReturn else {
        emit(BrokerResponse(ok: false, code: "CONFIGURATION_CANCELLED", message: "Credential configuration was cancelled."), exitCode: 2)
    }
    let trimmedValue = firstField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let encoded: Data?
    if provider == .newRecruit {
        guard !trimmedValue.isEmpty, !password.stringValue.isEmpty else {
            emit(BrokerResponse(ok: false, code: "INVALID_CREDENTIAL", message: "Username and password are required."), exitCode: 2)
        }
        encoded = try? JSONEncoder().encode(
            StoredCredentials(username: trimmedValue, password: password.stringValue)
        )
    } else {
        guard !trimmedValue.isEmpty else {
            emit(BrokerResponse(ok: false, code: "INVALID_CREDENTIAL", message: "A Tessera licence key is required."), exitCode: 2)
        }
        encoded = try? JSONEncoder().encode(
            StoredTesseraCredential(licenseKey: trimmedValue)
        )
    }
    guard let encoded else {
        emit(BrokerResponse(ok: false, code: "ENCODING_FAILED", message: "Credential encoding failed."), exitCode: 2)
    }

    var access: SecAccess?
    let accessStatus = SecAccessCreate(
        provider.label as CFString,
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
        kSecAttrLabel as String: provider.label,
    ]
    let status: OSStatus
    if initialStatus == errSecSuccess {
        status = SecItemUpdate(
            baseQuery(provider) as CFDictionary,
            attributes as CFDictionary
        )
    } else {
        var query = baseQuery(provider)
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

private func retrieve(_ provider: Provider) -> Never {
    guard authorizedKeychainConsumer() else {
        credentialReleaseDisabled(provider)
    }
    var query = baseQuery(provider)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseOperationPrompt as String] =
        provider == .newRecruit
            ? "Allow RosterPilot to sign in to New Recruit for this delivery."
            : "Allow RosterPilot to unlock Tessera Premium for this simulation."
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecUserCanceled || status == errSecAuthFailed {
        emit(BrokerResponse(ok: false, code: "AUTHENTICATION_CANCELLED", message: "Keychain authorization was cancelled."), exitCode: 3)
    }
    if status == errSecInteractionNotAllowed || status == errSecNotAvailable {
        emit(BrokerResponse(ok: false, code: "KEYCHAIN_LOCKED", message: "The macOS login Keychain is locked or unavailable."), exitCode: 3)
    }
    guard status == errSecSuccess, let data = result as? Data else {
        if status == errSecItemNotFound {
            emit(BrokerResponse(ok: false, code: "CREDENTIALS_NOT_CONFIGURED", message: "\(provider.rawValue) is not configured."), exitCode: 2)
        }
        emitKeychainFailure(status, operation: "READ")
    }
    if provider == .newRecruit {
        guard let credentials = try? JSONDecoder().decode(StoredCredentials.self, from: data) else {
            emit(BrokerResponse(ok: false, code: "DECODING_FAILED", message: "Stored credential could not be decoded."), exitCode: 2)
        }
        emit(BrokerResponse(ok: true, configured: true, username: credentials.username, password: credentials.password))
    }
    guard let credential = try? JSONDecoder().decode(StoredTesseraCredential.self, from: data) else {
        emit(BrokerResponse(ok: false, code: "DECODING_FAILED", message: "Stored Tessera key could not be decoded."), exitCode: 2)
    }
    emit(BrokerResponse(ok: true, configured: true, licenseKey: credential.licenseKey))
}

private func forget(_ provider: Provider) -> Never {
    let status = SecItemDelete(baseQuery(provider) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        emitKeychainFailure(status, operation: "DELETE")
    }
    emit(BrokerResponse(ok: true, configured: false))
}

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? "status"
guard let provider = Provider(rawValue: arguments.dropFirst().first ?? "new-recruit") else {
    emit(BrokerResponse(ok: false, code: "UNKNOWN_PROVIDER", message: "Expected new-recruit or tessera."), exitCode: 2)
}

switch command {
case "configure":
    configure(provider)
case "status":
    let status = keychainStatus(provider)
    if status == errSecSuccess {
        emit(BrokerResponse(ok: true, configured: true))
    }
    if status == errSecItemNotFound {
        emit(BrokerResponse(ok: true, configured: false))
    }
    emitKeychainFailure(status, operation: "STATUS")
case "retrieve":
    retrieve(provider)
case "forget":
    forget(provider)
default:
    emit(BrokerResponse(ok: false, code: "UNKNOWN_COMMAND", message: "Expected configure, status, retrieve, or forget."), exitCode: 2)
}
