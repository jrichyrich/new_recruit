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
}

private struct BrokerResponse: Codable {
    let ok: Bool
    let configured: Bool?
    let code: String?
    let message: String?

    init(
        ok: Bool,
        configured: Bool? = nil,
        code: String? = nil,
        message: String? = nil
    ) {
        self.ok = ok
        self.configured = configured
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

private func credentialReleaseStatus(_ provider: Provider) -> Never {
    let status = keychainStatus(provider)
    let configured: Bool
    if status == errSecSuccess {
        configured = true
    } else if status == errSecItemNotFound {
        configured = false
    } else {
        emitKeychainFailure(status, operation: "STATUS")
    }
    emit(
        BrokerResponse(
            ok: false,
            configured: configured,
            code: "CREDENTIAL_RELEASE_DISABLED",
            message:
                "Reusable \(provider.rawValue) credential release is disabled until RosterPilot has an authenticated native consumer. Local workflows remain available."
        ),
        exitCode: 5
    )
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
    credentialReleaseDisabled(provider)
case "status":
    credentialReleaseStatus(provider)
case "retrieve":
    credentialReleaseDisabled(provider)
case "forget":
    forget(provider)
default:
    emit(BrokerResponse(ok: false, code: "UNKNOWN_COMMAND", message: "Expected configure, status, retrieve, or forget."), exitCode: 2)
}
