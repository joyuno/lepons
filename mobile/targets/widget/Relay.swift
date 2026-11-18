import CryptoKit
import Foundation

// The widget's own short link to the PC, for answering a question without opening the app: the relay protocol of
// docs/handoff/2026-10-30-relay-protocol-for-apps.md (mobile/src/relay/protocol.ts is the app's), reconnect only --
// no pairing, no uploads. Open, hello, one or two requests, close.

/// What the app shares for this (mobile/src/widget.ts updateWidgetLink).
struct WidgetLink: Codable {
  let key: String
  let room: String
  let pc: String
  let server: String
  let token: String

  /// expo-secure-store's item: service "<keychainService>:no-auth", account the key's UTF-8, in the App Group.
  static func load() -> WidgetLink? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "lepons.widget:no-auth",
      kSecAttrAccount as String: Data("link".utf8),
      kSecAttrAccessGroup as String: "group.app.lepons.mobile",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
    return try? JSONDecoder().decode(WidgetLink.self, from: data)
  }
}

enum RelayError: Error {
  case closed
  case broken(String)
}

func hexData(_ hex: String) -> Data {
  var data = Data()
  var index = hex.startIndex
  while index < hex.endIndex, let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) {
    if let byte = UInt8(hex[index..<next], radix: 16) { data.append(byte) }
    index = next
  }
  return data
}

func hexString(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

/// The keys of one connection (protocol §5): phone→PC first, PC→phone second.
func relayKeys(phoneStatic: Curve25519.KeyAgreement.PrivateKey, phoneEph: Curve25519.KeyAgreement.PrivateKey, pcStaticPub: Data, pcEphPub: Data, room: Data) throws -> (send: SymmetricKey, receive: SymmetricKey) {
  let pcEph = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: pcEphPub)
  let pcStatic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: pcStaticPub)
  func raw(_ secret: SharedSecret) -> Data { secret.withUnsafeBytes { Data($0) } }
  let ikm = raw(try phoneEph.sharedSecretFromKeyAgreement(with: pcEph))
    + raw(try phoneEph.sharedSecretFromKeyAgreement(with: pcStatic))
    + raw(try phoneStatic.sharedSecretFromKeyAgreement(with: pcEph))
  let info = Data("lepons-relay v1".utf8) + pcStaticPub + phoneStatic.publicKey.rawRepresentation + phoneEph.publicKey.rawRepresentation + pcEphPub
  let okm = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: room, info: info, outputByteCount: 64)
  let bytes = okm.withUnsafeBytes { Data($0) }
  return (SymmetricKey(data: bytes.prefix(32)), SymmetricKey(data: bytes.suffix(32)))
}

/// A data frame (§6): 03 ‖ nonce(direction 4 ‖ counter 8) ‖ AES-256-GCM(plain, AAD 03) ‖ tag.
func sealFrame(_ plain: Data, key: SymmetricKey, direction: UInt32, counter: UInt64) throws -> Data {
  var nonce = Data()
  withUnsafeBytes(of: direction.bigEndian) { nonce.append(contentsOf: $0) }
  withUnsafeBytes(of: counter.bigEndian) { nonce.append(contentsOf: $0) }
  let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: nonce), authenticating: Data([0x03]))
  return Data([0x03]) + nonce + box.ciphertext + box.tag
}

func openFrame(_ frame: Data, key: SymmetricKey, direction: UInt32, counter: UInt64) throws -> Data {
  let bytes = [UInt8](frame)
  guard bytes.count >= 29, bytes[0] == 0x03 else { throw RelayError.broken("frame") }
  var expected = Data()
  withUnsafeBytes(of: direction.bigEndian) { expected.append(contentsOf: $0) }
  withUnsafeBytes(of: counter.bigEndian) { expected.append(contentsOf: $0) }
  guard Data(bytes[1..<13]) == expected else { throw RelayError.broken("counter") }
  let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Data(bytes[1..<13])), ciphertext: Data(bytes[13..<(bytes.count - 16)]), tag: Data(bytes[(bytes.count - 16)...]))
  return try AES.GCM.open(box, using: key, authenticating: Data([0x03]))
}

/// One short connection to the PC as this phone.
final class RelaySession {
  private let link: WidgetLink
  private var task: URLSessionWebSocketTask?
  private var keys: (send: SymmetricKey, receive: SymmetricKey)?
  private var sent: UInt64 = 0
  private var received: UInt64 = 0
  private var nextId = 1

  init(link: WidgetLink) { self.link = link }

  func open() async throws {
    guard let url = URL(string: "\(link.server)/ws?room=\(link.room)&role=phone") else { throw RelayError.broken("url") }
    let task = URLSession.shared.webSocketTask(with: url)
    self.task = task
    task.resume()
    // The PC has to be in the room before a hello means anything (§2).
    while true {
      if case .string(let text) = try await task.receive(), text == "peer-joined" { break }
    }
    let phoneStatic = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hexData(link.key))
    let phoneEph = Curve25519.KeyAgreement.PrivateKey()
    try await task.send(.data(Data([0x01, 0x01]) + phoneEph.publicKey.rawRepresentation + phoneStatic.publicKey.rawRepresentation))
    var pcEphPub = Data()
    while pcEphPub.isEmpty {
      switch try await task.receive() {
      case .data(let data) where data.count == 34 && data[data.startIndex] == 0x02 && data[data.startIndex + 1] == 0x01:
        pcEphPub = data.subdata(in: (data.startIndex + 2)..<(data.startIndex + 34))
      case .string(let text) where text == "peer-left":
        throw RelayError.closed
      default:
        continue
      }
    }
    keys = try relayKeys(phoneStatic: phoneStatic, phoneEph: phoneEph, pcStaticPub: hexData(link.pc), pcEphPub: pcEphPub, room: hexData(link.room))
    try await send(["t": "event", "name": "hello"])
    // Nothing from the PC counts until its first frame opens with these keys (§8.2).
    _ = try await receiveMessage()
  }

  func close() { task?.cancel(with: .normalClosure, reason: nil) }

  /// A request as the app makes it, its status and JSON body.
  func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> (status: Int, body: Any?) {
    let id = nextId
    nextId += 1
    var message: [String: Any] = ["t": "req", "id": id, "method": method, "path": path, "token": link.token]
    if let body { message["body"] = body }
    try await send(message)
    var pieces = Data()
    while true {
      let (head, tail) = try await receiveMessage()
      if head["t"] as? String == "chunk", head["id"] as? Int == id {
        pieces += tail
        if head["last"] as? Bool == true {
          let (whole, _) = try split(pieces)
          return (whole["status"] as? Int ?? 0, whole["body"])
        }
        continue
      }
      if head["t"] as? String == "res", head["id"] as? Int == id { return (head["status"] as? Int ?? 0, head["body"]) }
      if head["t"] as? String == "error" { throw RelayError.broken(head["message"] as? String ?? "error") }
    }
  }

  private func send(_ message: [String: Any]) async throws {
    guard let task, let keys else { throw RelayError.closed }
    let plain = try JSONSerialization.data(withJSONObject: message)
    let frame = try sealFrame(plain, key: keys.send, direction: 1, counter: sent)
    sent += 1
    try await task.send(.data(frame))
  }

  private func receiveMessage() async throws -> ([String: Any], Data) {
    guard let task, let keys else { throw RelayError.closed }
    while true {
      switch try await task.receive() {
      case .data(let frame):
        let plain = try openFrame(frame, key: keys.receive, direction: 2, counter: received)
        received += 1
        return try split(plain)
      case .string(let text) where text == "peer-left":
        throw RelayError.closed
      default:
        continue
      }
    }
  }

  /// A plaintext is JSON, then optionally a newline and raw bytes (§7).
  private func split(_ plain: Data) throws -> ([String: Any], Data) {
    let newline = plain.firstIndex(of: 0x0A)
    let json = newline.map { plain[plain.startIndex..<$0] } ?? plain
    let tail = newline.map { plain[plain.index(after: $0)...] } ?? Data()
    guard let head = try JSONSerialization.jsonObject(with: Data(json)) as? [String: Any] else { throw RelayError.broken("json") }
    return (head, Data(tail))
  }
}
