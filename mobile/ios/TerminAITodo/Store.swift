import Foundation
import Security
import SwiftUI

/// One shared task: the JSON file `tasks/<id>.json` of the build-tasks repo, the same one TerminAI reads and writes.
struct TodoTask: Identifiable, Equatable, Hashable {
    var id: String
    var title: String
    var notes: String
    var images: [String]?
    var status: String          // open | doing | done
    var assignee: String?       // livio | ilai | both | nil (Unassigned)
    var product: String
    var order: Double?
    var createdAt: String
    var createdBy: String
    var updatedAt: String
    var updatedBy: String
    var updatedVia: String?     // "ai": an agent in a TerminAI tab made the last change
    /// The blob sha GitHub needs to overwrite the file; nil for a task not saved yet.
    var sha: String?

    var rank: Double { order ?? (Self.date(createdAt)?.timeIntervalSince1970 ?? 0) * 1000 }
    var isDone: Bool { status == "done" }

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    init?(json: [String: Any], sha: String?) {
        guard let id = json["id"] as? String, let title = json["title"] as? String else { return nil }
        self.id = id
        self.title = title
        notes = json["notes"] as? String ?? ""
        images = json["images"] as? [String]
        status = json["status"] as? String ?? "open"
        assignee = json["assignee"] as? String
        product = json["product"] as? String ?? ""
        order = (json["order"] as? NSNumber)?.doubleValue
        createdAt = json["createdAt"] as? String ?? ""
        createdBy = json["createdBy"] as? String ?? ""
        updatedAt = json["updatedAt"] as? String ?? ""
        updatedBy = json["updatedBy"] as? String ?? ""
        updatedVia = json["updatedVia"] as? String
        self.sha = sha
    }

    init(title: String, assignee: String?, product: String, user: String) {
        let now = romeIso()
        id = UUID().uuidString.lowercased()
        self.title = title
        notes = ""
        status = "open"
        self.assignee = assignee
        self.product = product
        createdAt = now; createdBy = user; updatedAt = now; updatedBy = user
    }

    /// The file exactly as TerminAI writes it: JSON.stringify(task, null, 2) in its field order, and a newline.
    var fileText: String {
        var fields: [(String, String)] = [("id", q(id)), ("title", q(title)), ("notes", q(notes))]
        if let images, !images.isEmpty { fields.append(("images", "[\n" + images.map { "    " + q($0) }.joined(separator: ",\n") + "\n  ]")) }
        fields += [("status", q(status)), ("assignee", assignee.map(q) ?? "null"), ("product", q(product))]
        if let order { fields.append(("order", order == order.rounded() && abs(order) < 1e15 ? String(Int64(order)) : String(order))) }
        fields += [("createdAt", q(createdAt)), ("createdBy", q(createdBy)), ("updatedAt", q(updatedAt)), ("updatedBy", q(updatedBy))]
        if updatedVia == "ai" { fields.append(("updatedVia", q("ai"))) }
        return "{\n" + fields.map { "  \(q($0.0)): \($0.1)" }.joined(separator: ",\n") + "\n}\n"
    }
}

/// A JSON string literal, escaped the way JSON.stringify does.
private func q(_ s: String) -> String {
    var out = "\""
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        default:
            if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
        }
    }
    return out + "\""
}

/// "2026-10-23T16:44:54.380+02:00": TerminAI's dates, in Europe/Rome.
func romeIso(_ date: Date = Date()) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "Europe/Rome")
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSxxx"
    return f.string(from: date)
}

/// One commit of the build-tasks repo: who changed what, for the Activity tab.
struct Change: Identifiable {
    let id: String
    let at: Date
    let by: String
    let ai: Bool
    let phone: Bool
    let message: String
}

let names = ["livio": "Matteo", "ilai": "Ilai", "both": "Together"]
func mentions(_ text: String) -> Set<String> {
    var found = Set<String>()
    let regex = try! NSRegularExpression(pattern: "(?:^|[^\\w@])@(matteo|livio|ilai)\\b", options: .caseInsensitive)
    for m in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        if let r = Range(m.range(at: 1), in: text) { found.insert(text[r].lowercased() == "ilai" ? "ilai" : "livio") }
    }
    return found
}

enum Keychain {
    static func get(_ key: String) -> String? {
        var out: AnyObject?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key, kSecReturnData as String: true]
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func set(_ key: String, _ value: String?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard let value, !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}

struct GitHubError: LocalizedError { let errorDescription: String? }

/// The shared To-do through the GitHub API: one GraphQL query reads every task, each change is one commit.
@MainActor
final class Store: ObservableObject {
    static let owner = "ClipWave-io", repo = "build-tasks", branch = "main"

    @Published var tasks: [TodoTask] = []
    @Published var changes: [Change] = []
    @Published var loading = false
    @Published var error: String?
    @Published var lastSync: Date?
    @AppStorage("user") var user: String = ""
    @AppStorage("products") var productFilter: String = ""     // "\n"-joined; empty: every product
    @Published var token: String = Store.debugToken ?? Keychain.get("github-token") ?? ""
    /// Simulator previews only: a token handed in at launch, never stored. Not compiled into release builds.
    private static var debugToken: String? {
        #if DEBUG
        return ProcessInfo.processInfo.environment["TERMINAI_GITHUB_TOKEN"]
        #else
        return nil
        #endif
    }

    var picked: [String] { productFilter.isEmpty ? [] : productFilter.components(separatedBy: "\n") }
    var products: [String] { Array(Set(tasks.map { $0.product.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })).sorted() }

    func saveToken(_ value: String) {
        token = value.trimmingCharacters(in: .whitespacesAndNewlines)
        Keychain.set("github-token", token)
    }

    private func request(_ path: String, method: String = "GET", body: Any? = nil) async throws -> (Any, Int) {
        var req = URLRequest(url: URL(string: "https://api.github.com\(path)")!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) ?? [:]
        if code == 401 { throw GitHubError(errorDescription: "GitHub refused the token. Check it in Settings.") }
        if code == 404 { throw GitHubError(errorDescription: "The token cannot see ClipWave-io/build-tasks. Give it access to that repo.") }
        if code >= 400 && code != 409 && code != 422 {
            throw GitHubError(errorDescription: ((json as? [String: Any])?["message"] as? String) ?? "GitHub error \(code)")
        }
        return (json, code)
    }

    func refresh() async {
        guard !token.isEmpty else { return }
        loading = true
        defer { loading = false }
        do {
            let query = """
            query { repository(owner: "\(Self.owner)", name: "\(Self.repo)") { object(expression: "\(Self.branch):tasks") { ... on Tree { entries { name oid object { ... on Blob { text } } } } } } }
            """
            let (json, _) = try await request("/graphql", method: "POST", body: ["query": query])
            if let errors = (json as? [String: Any])?["errors"] as? [[String: Any]], let first = errors.first {
                throw GitHubError(errorDescription: first["message"] as? String ?? "GitHub error")
            }
            let entries = (((json as? [String: Any])?["data"] as? [String: Any])?["repository"] as? [String: Any]).flatMap { ($0["object"] as? [String: Any])?["entries"] as? [[String: Any]] } ?? []
            tasks = entries.compactMap { entry in
                guard let name = entry["name"] as? String, name.hasSuffix(".json"),
                      let text = (entry["object"] as? [String: Any])?["text"] as? String,
                      let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return nil }
                return TodoTask(json: obj, sha: entry["oid"] as? String)
            }
            try await loadChanges()
            lastSync = Date()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadChanges() async throws {
        let (json, _) = try await request("/repos/\(Self.owner)/\(Self.repo)/commits?path=tasks&per_page=80&sha=\(Self.branch)")
        changes = (json as? [[String: Any]] ?? []).compactMap { item in
            guard let sha = item["sha"] as? String, let commit = item["commit"] as? [String: Any], let message = commit["message"] as? String else { return nil }
            let subject = message.components(separatedBy: "\n").first ?? message
            let parts = subject.split(separator: ":", maxSplits: 1).map { String($0) }
            let dateText = ((commit["committer"] as? [String: Any])?["date"] as? String) ?? ""
            return Change(id: sha, at: ISO8601DateFormatter().date(from: dateText) ?? Date(), by: parts.count == 2 ? parts[0] : "",
                          ai: message.contains("Via: AI"), phone: message.contains("Via: iPhone"),
                          message: (parts.count == 2 ? parts[1] : subject).trimmingCharacters(in: .whitespaces))
        }
    }

    /// Writes one task as one commit, "<user>: <verb> <title>" like TerminAI. A file changed meanwhile is re-read and the edit tried once more.
    func save(_ task: TodoTask, verb: String, apply: ((inout TodoTask) -> Void)? = nil) async -> Bool {
        var next = task
        apply?(&next)
        next.updatedAt = romeIso()
        next.updatedBy = user
        next.updatedVia = nil
        for attempt in 0..<2 {
            do {
                var body: [String: Any] = [
                    "message": "\(user): \(verb) \(next.title)\n\nVia: iPhone app",
                    "content": Data(next.fileText.utf8).base64EncodedString(),
                    "branch": Self.branch,
                ]
                if let sha = next.sha { body["sha"] = sha }
                let (json, code) = try await request("/repos/\(Self.owner)/\(Self.repo)/contents/tasks/\(next.id).json", method: "PUT", body: body)
                if code == 409 || code == 422 {
                    guard attempt == 0 else { throw GitHubError(errorDescription: "Changed on another device at the same time. Pull to refresh and try again.") }
                    await refresh()
                    if let fresh = tasks.first(where: { $0.id == task.id }) { next = fresh; apply?(&next); next.updatedAt = romeIso(); next.updatedBy = user; next.updatedVia = nil }
                    continue
                }
                next.sha = ((json as? [String: Any])?["content"] as? [String: Any])?["sha"] as? String
                if let i = tasks.firstIndex(where: { $0.id == next.id }) { tasks[i] = next } else { tasks.append(next) }
                error = nil
                Task { try? await loadChanges() }
                return true
            } catch {
                self.error = error.localizedDescription
                return false
            }
        }
        return false
    }

    func add(title: String, assignee: String?, product: String) async -> Bool {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return false }
        var task = TodoTask(title: t, assignee: assignee, product: product.trimmingCharacters(in: .whitespaces), user: user)
        // At the end of its column, the way TerminAI places a new row.
        task.order = (tasks.filter { $0.assignee == assignee && !$0.isDone }.map(\.rank).max() ?? Date().timeIntervalSince1970 * 1000) + 1
        return await save(task, verb: "add")
    }

    func delete(_ task: TodoTask) async {
        guard let sha = task.sha else { return }
        do {
            _ = try await request("/repos/\(Self.owner)/\(Self.repo)/contents/tasks/\(task.id).json", method: "DELETE",
                                  body: ["message": "\(user): delete \(task.title)\n\nVia: iPhone app", "sha": sha, "branch": Self.branch])
            tasks.removeAll { $0.id == task.id }
        } catch { self.error = error.localizedDescription }
    }

    /// A picture under a task's note, read with the token (the repo is private).
    func image(_ task: TodoTask, _ name: String) async -> UIImage? {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(Self.owner)/\(Self.repo)/contents/images/\(task.id)/\(name)?ref=\(Self.branch)")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github.raw", forHTTPHeaderField: "Accept")
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return UIImage(data: data)
    }
}
