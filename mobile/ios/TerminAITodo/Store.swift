import Foundation
import Security
import SwiftUI

// The team server is the one place notes live: this app, the TerminAI Mac app and the website read and write the same ones.
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
    var isDone: Bool { status == "done" }
}
private struct MeResponse: Decodable { let user: Me; let companies: [Team] }
private struct SignedIn: Decodable { let token: String? }
private struct NotesResponse: Decodable { let notes: [Note] }
private struct NoteResponse: Decodable { let note: Note }
private struct MembersResponse: Decodable { let members: [Member] }
private struct APIError: Decodable { let error: String }

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
    @Published var notes: [Note] = []
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
            throw Failure((try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "The team server answered \(status).")
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
    func signUp(name: String, team: String, email: String, password: String) async {
        await authenticate("/api/auth/signup", ["name": name, "companyName": team, "email": email, "password": password])
    }
    func join(invite: String, name: String, password: String) async {
        await authenticate("/api/auth/accept-invite", ["token": inviteToken(invite), "name": name, "password": password])
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
    func signOut() async {
        if !token.isEmpty { _ = try? await call("/api/auth/logout", "POST", [:], as: [String: Bool].self) }
        signOutLocally()
    }
    private func signOutLocally() { token = ""; Keychain.set("team-token", nil); me = nil; teams = []; notes = []; members = [] }

    // MARK: data
    func refresh() async { guard !token.isEmpty else { return }; await attempt { try await loadAll() } }
    private func loadAll() async throws {
        let r: MeResponse = try await call("/api/me")
        me = r.user; teams = r.companies
        if !teams.contains(where: { $0.id == teamId }) { teamId = teams.first?.id ?? "" }
        UserDefaults.standard.set(teamId, forKey: "team")
        guard !teamId.isEmpty else { notes = []; members = []; return }
        async let n: NotesResponse = call("/api/companies/\(teamId)/notes")
        async let m: MembersResponse = call("/api/companies/\(teamId)/members")
        notes = try await n.notes; members = try await m.members
    }
    func createTeam(_ name: String) async { await attempt { let _: [String: String] = try await call("/api/companies", "POST", ["name": name]); try await loadAll() } }
    func switchTeam(_ id: String) async { teamId = id; await refresh() }

    func add(_ title: String, visibility: String, assignee: String?) async {
        await attempt {
            let r: NoteResponse = try await call("/api/companies/\(teamId)/notes", "POST", ["title": title, "visibility": visibility, "assigneeId": assignee])
            notes.append(r.note)
        }
    }
    func update(_ note: Note, _ patch: [String: Any?]) async {
        if let i = notes.firstIndex(where: { $0.id == note.id }) {   // show it at once; the server answer replaces it
            if let s = patch["status"] as? String { notes[i].status = s }
            if let t = patch["title"] as? String { notes[i].title = t }
        }
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
    /// Moves a note within a list the way the website does: halfway between its new neighbours.
    func move(_ list: [Note], from: IndexSet, to: Int) async {
        guard let index = from.first else { return }
        var rest = list; let note = rest.remove(at: index)
        let at = to > index ? to - 1 : to
        let before: Double? = at > 0 ? rest[at - 1].position : nil
        let after: Double? = at < rest.count ? rest[at].position : nil
        let position: Double
        switch (before, after) {
        case let (b?, a?): position = (b + a) / 2
        case let (b?, nil): position = b + 1
        case let (nil, a?): position = a - 1
        default: position = 1
        }
        if let i = notes.firstIndex(where: { $0.id == note.id }) { notes[i].position = position }
        await update(note, ["position": position])
    }
}
