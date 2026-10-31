import Foundation
import Security
import SwiftUI

// The sync server is the one place notes live: this app, the TerminAI Mac app and the website read and write the same ones.
let defaultServer = "https://terminai-manager-production.up.railway.app"

struct Me: Decodable { let id: String; let email: String; let name: String }
struct Team: Decodable, Identifiable, Hashable { let id: String; let name: String; let role: String }
struct Member: Decodable, Identifiable, Hashable { let id: String; let name: String; let email: String; let role: String }
struct Note: Decodable, Identifiable, Equatable {
    let id: String
    var ownerId: String
    var visibility: String      // private | company
    var title: String
    var body: String
    var status: String          // open | done
    var assigneeId: String?
    var position: Double
    var updatedBy: String?
    var updatedByName: String?
    var updatedAt: String
    var kind: String?           // card (an old board card) | doc (a shared note, like Apple Notes)
    var files: [NoteFile]?
    var isDone: Bool { status == "done" }
}
/// A task of the To-do's shared page, as the Mac app writes it (its repo file); the server keeps a copy.
struct TaskItem: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var notes: String
    var images: [String]?
    var status: String          // open | doing | done
    var assignee: String?       // ilai | livio | both (Together) | nil (Unassigned)
    var product: String
    var order: Double?
    var createdAt: String
    var createdBy: String
    var updatedAt: String?
    var updatedBy: String
    var updatedVia: String?
    var isDone: Bool { status == "done" }
    /// The Mac's order: a moved task has `order`, otherwise it sorts by when it was made.
    var sortKey: Double { order ?? (ISO8601DateFormatter.lenient(createdAt)?.timeIntervalSince1970 ?? 0) * 1000 }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(title, forKey: .title); try c.encode(notes, forKey: .notes)
        try c.encodeIfPresent(images, forKey: .images); try c.encode(status, forKey: .status)
        try c.encode(assignee, forKey: .assignee)   // null means Unassigned, so it is always sent
        try c.encode(product, forKey: .product); try c.encodeIfPresent(order, forKey: .order)
        try c.encode(createdAt, forKey: .createdAt); try c.encode(createdBy, forKey: .createdBy)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt); try c.encode(updatedBy, forKey: .updatedBy); try c.encodeIfPresent(updatedVia, forKey: .updatedVia)
    }
}
struct Person: Decodable { let id: String; let name: String }
struct NoteFile: Decodable, Identifiable, Hashable { let id: String; let name: String; let size: Int }
private struct TasksResponse: Decodable { let tasks: [TaskItem]; let people: [String: Person]; let me: String? }
private struct TaskResponse: Decodable { let task: TaskItem }
private struct InviteResponse: Decodable { let inviteUrl: String }
private struct MeResponse: Decodable { let user: Me; let companies: [Team] }
private struct SignedIn: Decodable { let token: String? }
struct DeviceStart: Decodable { let code: String; let pollToken: String; let verifyUrl: String }
private struct DevicePoll: Decodable { let pending: Bool?; let token: String? }
private struct NotesResponse: Decodable { let notes: [Note] }
private struct NoteResponse: Decodable { let note: Note }
private struct MembersResponse: Decodable { let members: [Member] }
private struct APIError: Decodable { let error: String }

extension ISO8601DateFormatter {
    /// The Mac writes 2026-10-20T16:21:03.120+02:00, the server 2026-10-20T14:21:03.120Z: both parse.
    static func lenient(_ text: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime]; return f.date(from: text)
    }
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

/// An invitation arrives as a link (…/#invite=TOKEN) or the bare token.
func inviteToken(_ text: String) -> String {
    let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if let range = raw.range(of: "invite=") { return String(raw[range.upperBound...].prefix(43)) }
    return raw
}

@MainActor
final class Store: ObservableObject {
    @Published var server = UserDefaults.standard.string(forKey: "server") ?? defaultServer
    @Published private(set) var token = Keychain.get("team-token") ?? ""
    @Published var me: Me?
    @Published var teams: [Team] = []
    @Published var teamId = UserDefaults.standard.string(forKey: "team") ?? ""
    @Published var members: [Member] = []
    @Published var notes: [Note] = []            // the shared notes (docs)
    @Published var tasks: [TaskItem] = []
    @Published var people: [String: Person] = [:]
    @Published var myColumn: String?             // ilai | livio: which To-do column is this account
    @Published var error = ""
    @Published var loading = false

    var team: Team? { teams.first { $0.id == teamId } ?? teams.first }
    var canEditBoard: Bool { team?.role != "viewer" }
    var isAdmin: Bool { ["owner", "admin"].contains(team?.role ?? "") }
    func name(_ id: String?) -> String { members.first { $0.id == id }?.name ?? "Unassigned" }

    private func call<T: Decodable>(_ path: String, _ method: String = "GET", _ body: [String: Any?]? = nil, as: T.Type = T.self) async throws -> T {
        guard let url = URL(string: server + path) else { throw Failure("Check the server address.") }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body.mapValues { $0 ?? NSNull() })
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401, !token.isEmpty { signOutLocally() }
            throw Failure((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "The server answered \(status).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    struct Failure: LocalizedError { let message: String; init(_ m: String) { message = m }; var errorDescription: String? { message } }
    private func attempt(_ work: () async throws -> Void) async {
        loading = true; defer { loading = false }
        do { try await work(); error = "" } catch { self.error = error.localizedDescription }
    }

    // MARK: account
    func signIn(email: String, password: String) async { await authenticate("/api/auth/login", ["email": email, "password": password]) }
    func signUp(name: String, email: String, password: String) async {
        await authenticate("/api/auth/signup", ["name": name, "email": email, "password": password])
    }
    func join(invite: String, name: String, password: String) async {
        await authenticate("/api/auth/accept-invite", ["token": inviteToken(invite), "name": name, "password": password.isEmpty ? nil : password])
    }
    private func authenticate(_ path: String, _ body: [String: Any?]) async {
        await attempt {
            var body = body; body["client"] = "desktop"   // a bearer session, like the Mac app's
            let result: SignedIn = try await call(path, "POST", body)
            guard let t = result.token else { throw Failure("The server did not return a session.") }
            token = t; Keychain.set("team-token", t); UserDefaults.standard.set(server, forKey: "server")
            try await loadAll()
        }
    }
    /// Sign in with the browser: the app shows a code, the person allows it on the website wherever they are
    /// signed in (this phone's Safari, or the Mac), and the app collects its session. No password is typed here.
    @Published var device: DeviceStart?
    func startBrowserSignIn() async -> URL? {
        var link: URL?
        await attempt {
            let started: DeviceStart = try await call("/api/auth/device/start", "POST", [:])
            device = started; link = URL(string: started.verifyUrl)
        }
        return link
    }
    func waitForBrowserSignIn() async {
        while let started = device, token.isEmpty {
            do {
                let result: DevicePoll = try await call("/api/auth/device/poll", "POST", ["pollToken": started.pollToken])
                if let t = result.token {
                    token = t; Keychain.set("team-token", t); UserDefaults.standard.set(server, forKey: "server"); device = nil
                    await refresh(); return
                }
            } catch { self.error = error.localizedDescription; device = nil; return }
            try? await Task.sleep(for: .seconds(2))
        }
    }
    func cancelBrowserSignIn() { device = nil }
    func signOut() async {
        if !token.isEmpty { _ = try? await call("/api/auth/logout", "POST", [:], as: [String: Bool].self) }
        signOutLocally()
    }
    private func signOutLocally() { token = ""; Keychain.set("team-token", nil); me = nil; teams = []; notes = []; members = []; tasks = []; people = [:]; myColumn = nil }

    // MARK: data
    func refresh() async { guard !token.isEmpty else { return }; await attempt { try await loadAll() } }
    private func loadAll() async throws {
        let r: MeResponse = try await call("/api/me")
        me = r.user; teams = r.companies
        if !teams.contains(where: { $0.id == teamId }) { teamId = teams.first?.id ?? "" }
        UserDefaults.standard.set(teamId, forKey: "team")
        guard !teamId.isEmpty else { notes = []; members = []; tasks = []; return }
        // The To-do lives in the workspace where this account has its column; a fresh account looks at the first one.
        if (try? await call("/api/companies/\(teamId)/tasks", as: TasksResponse.self))?.me == nil {
            for team in teams where team.id != teamId {
                if let r = try? await call("/api/companies/\(team.id)/tasks", as: TasksResponse.self), r.me != nil { teamId = team.id; UserDefaults.standard.set(teamId, forKey: "team"); break }
            }
        }
        async let n: NotesResponse = call("/api/companies/\(teamId)/notes")
        async let m: MembersResponse = call("/api/companies/\(teamId)/members")
        async let t: TasksResponse = call("/api/companies/\(teamId)/tasks")
        notes = try await n.notes.filter { $0.kind == "doc" && $0.visibility == "company" }.sorted { $0.updatedAt > $1.updatedAt }
        members = try await m.members
        let board = try await t; tasks = board.tasks; people = board.people; myColumn = board.me
    }
    func createTeam(_ name: String) async { await attempt { let _: [String: String] = try await call("/api/companies", "POST", ["name": name]); try await loadAll() } }
    func switchTeam(_ id: String) async { teamId = id; await refresh() }

    // MARK: the To-do's shared page
    func name(column: String?) -> String {
        switch column {
        case "both": return "Together"
        case nil: return "Unassigned"
        case let key?: return people[key]?.name.split(separator: " ").first.map(String.init) ?? (key == "ilai" ? "Ilai" : "Matteo")
        }
    }
    func claim(_ column: String) async {
        await attempt { let _: [String: Bool] = try await call("/api/companies/\(teamId)/tasks/people", "PUT", ["key": column]); try await loadAll() }
    }
    private func save(_ task: TaskItem) async {
        var next = task; next.updatedAt = nil; next.updatedBy = myColumn ?? task.updatedBy; next.updatedVia = "iphone"
        if let i = tasks.firstIndex(where: { $0.id == task.id }) { tasks[i] = next } else { tasks.append(next) }   // at once; the answer replaces it
        await attempt {
            let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(next))
            let r: TaskResponse = try await call("/api/companies/\(teamId)/tasks/\(task.id)", "PUT", ["task": body])
            if let i = tasks.firstIndex(where: { $0.id == task.id }) { tasks[i] = r.task }
        }
    }
    func addTask(_ title: String, to column: String?) async {
        let now = ISO8601DateFormatter().string(from: Date()), me = myColumn ?? "ilai"
        await save(TaskItem(id: UUID().uuidString.lowercased(), title: title, notes: "", images: nil, status: "open", assignee: column, product: "", order: nil,
                            createdAt: now, createdBy: me, updatedAt: nil, updatedBy: me, updatedVia: nil))
    }
    func edit(_ task: TaskItem, _ change: (inout TaskItem) -> Void) async { var next = task; change(&next); if next != task { await save(next) } }
    func deleteTask(_ task: TaskItem) async {
        tasks.removeAll { $0.id == task.id }
        await attempt { let _: [String: Bool] = try await call("/api/companies/\(teamId)/tasks/\(task.id)", "DELETE") }
    }

    // MARK: shared notes (docs)
    func addDoc() async -> String? {
        var made: String?
        await attempt {
            let r: NoteResponse = try await call("/api/companies/\(teamId)/notes", "POST", ["kind": "doc", "visibility": "company", "title": "New note", "body": ""])
            notes.insert(r.note, at: 0); made = r.note.id
        }
        return made
    }
    func update(_ note: Note, _ patch: [String: Any?]) async {
        await attempt {
            let r: NoteResponse = try await call("/api/companies/\(teamId)/notes/\(note.id)", "PATCH", patch)
            if let i = notes.firstIndex(where: { $0.id == note.id }) { notes[i] = r.note }
        }
    }
    func delete(_ note: Note) async {
        await attempt {
            let _: [String: Bool] = try await call("/api/companies/\(teamId)/notes/\(note.id)", "DELETE")
            notes.removeAll { $0.id == note.id }
        }
    }
    /// A file of a shared note, saved where Quick Look can show it.
    func download(_ file: NoteFile, of note: Note) async -> URL? {
        guard let url = URL(string: server + "/api/companies/\(teamId)/notes/\(note.id)/files/\(file.id)") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 60); request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 else { error = "Could not open \(file.name)."; return nil }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(file.id, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let out = dir.appendingPathComponent(file.name.replacingOccurrences(of: "/", with: "-"))
        do { try data.write(to: out); return out } catch { self.error = error.localizedDescription; return nil }
    }

    // MARK: people
    func invite(_ email: String) async -> String? {
        var link: String?
        await attempt { let r: InviteResponse = try await call("/api/companies/\(teamId)/invites", "POST", ["email": email, "role": "admin"]); link = r.inviteUrl }
        return link
    }
    func rename(_ name: String) async {
        await attempt { let _: [String: Me] = try await call("/api/me", "PATCH", ["name": name]); try await loadAll() }
    }
    /// Allows a code shown by another device (a Mac, another phone) to sign in as this account.
    func approve(code: String) async -> Bool {
        var ok = false
        await attempt { let _: [String: Bool] = try await call("/api/auth/device/approve", "POST", ["code": code]); ok = true }
        return ok
    }
}
