import SwiftUI

@main
struct TerminAITeamApp: App {
    @StateObject private var store = Store()
    var body: some Scene {
        WindowGroup { Root().environmentObject(store) }
    }
}

let accent = Color(light: Color(red: 0.43, green: 0.36, blue: 0.82), dark: Color(red: 0.55, green: 0.49, blue: 0.96))
extension Color {
    init(light: Color, dark: Color) { self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) }) }
}
func initials(_ name: String) -> String { name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased() }

struct Root: View {
    @EnvironmentObject var store: Store
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Group {
            if store.token.isEmpty { Welcome() }
            else if store.me != nil && store.teams.isEmpty { NoTeam() }
            else {
                TabView {
                    NotesList().tabItem { Label("My notes", systemImage: "lock") }
                    TeamBoard().tabItem { Label("Team", systemImage: "person.3") }
                    Settings().tabItem { Label("Settings", systemImage: "gearshape") }
                }
                .task { await store.refresh() }
            }
        }
        .tint(accent)
        .onChange(of: phase) { _, now in if now == .active { Task { await store.refresh() } } }
    }
}

struct ErrorBanner: View {
    @EnvironmentObject var store: Store
    var body: some View {
        if !store.error.isEmpty {
            Text(store.error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                .onTapGesture { store.error = "" }
        }
    }
}

// MARK: - Sign in, start a team, join one

struct Welcome: View {
    @EnvironmentObject var store: Store
    enum Mode: String, CaseIterable { case signIn = "Sign in", start = "Start a team", join = "Join" }
    @State private var mode = Mode.signIn
    @State private var name = ""
    @State private var team = ""
    @State private var email = ""
    @State private var password = ""
    @State private var invite = ""
    var ready: Bool {
        switch mode {
        case .signIn: return !email.isEmpty && !password.isEmpty
        case .start: return !name.isEmpty && !team.isEmpty && !email.isEmpty && password.count >= 12
        case .join: return !invite.isEmpty && !name.isEmpty && password.count >= 12
        }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("›_").font(.system(.title2, design: .monospaced).weight(.semibold)).foregroundStyle(accent)
                        Text("TerminAI Team").font(.title.bold())
                        Text("Your private notes and your team’s board, the same as in the Mac app and on the web.").foregroundStyle(.secondary)
                    }.listRowBackground(Color.clear)
                    Picker("", selection: $mode) { ForEach(Mode.allCases, id: \.self) { Text($0.rawValue) } }
                        .pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
                Section {
                    if mode == .join { TextField("Invitation link", text: $invite).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    if mode != .signIn { TextField("Your name", text: $name).textContentType(.name) }
                    if mode == .start { TextField("Team or company", text: $team) }
                    if mode != .join { TextField("Email", text: $email).keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never) }
                    SecureField(mode == .signIn ? "Password" : "Password (12+ characters)", text: $password).textContentType(mode == .signIn ? .password : .newPassword)
                } footer: {
                    Text(mode == .join ? "Paste the link a teammate sent you." : mode == .start ? "You’ll own the team and can invite anyone from the Mac app or the web." : "")
                }
                Section {
                    Button {
                        Task {
                            switch mode {
                            case .signIn: await store.signIn(email: email, password: password)
                            case .start: await store.signUp(name: name, team: team, email: email, password: password)
                            case .join: await store.join(invite: invite, name: name, password: password)
                            }
                        }
                    } label: { HStack { Spacer(); if store.loading { ProgressView() } else { Text(mode == .start ? "Create team" : mode == .join ? "Join team" : "Sign in").bold() }; Spacer() } }
                    .disabled(!ready || store.loading)
                    ErrorBanner()
                }
                Section("Server") {
                    TextField("Team server", text: $store.server).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).font(.footnote)
                }
            }
        }
    }
}

struct NoTeam: View {
    @EnvironmentObject var store: Store
    @State private var name = ""
    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("Team name", text: $name); Button("Create team") { Task { await store.createTeam(name) } }.disabled(name.isEmpty) }
                    header: { Text("You’re not in a team yet") } footer: { Text("Or open an invitation link from a teammate.") }
                Section { ErrorBanner(); Button("Sign out", role: .destructive) { Task { await store.signOut() } } }
            }.navigationTitle("Welcome")
        }
    }
}

// MARK: - Notes

struct NoteRow: View {
    @EnvironmentObject var store: Store
    let note: Note
    var showOwner = false
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button { Task { await store.update(note, ["status": note.isDone ? "open" : "done"]) } } label: {
                Image(systemName: note.isDone ? "checkmark.circle.fill" : "circle").font(.title3).foregroundStyle(note.isDone ? accent : .secondary)
            }.buttonStyle(.plain).disabled(note.visibility == "company" && !store.canEditBoard)
            NavigationLink(value: note.id) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(note.title).strikethrough(note.isDone).foregroundStyle(note.isDone ? .secondary : .primary)
                    if !note.body.isEmpty { Text(note.body).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                    if showOwner, let by = note.updatedByName { Text(note.updatedBy == store.me?.id ? "You" : by).font(.caption2).foregroundStyle(.tertiary) }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct AddField: View {
    @EnvironmentObject var store: Store
    let placeholder: String
    let visibility: String
    var assignee: String?
    @State private var text = ""
    @FocusState private var focused: Bool
    var body: some View {
        HStack {
            Image(systemName: "plus").foregroundStyle(accent)
            TextField(placeholder, text: $text).focused($focused).submitLabel(.done).onSubmit {
                let t = text.trimmingCharacters(in: .whitespaces); guard !t.isEmpty else { return }
                text = ""; focused = true
                Task { await store.add(t, visibility: visibility, assignee: assignee) }
            }
        }
    }
}

struct NotesList: View {
    @EnvironmentObject var store: Store
    @State private var showDone = false
    var open: [Note] { store.notes.filter { $0.visibility == "private" && !$0.isDone }.sorted { $0.position < $1.position } }
    var done: [Note] { store.notes.filter { $0.visibility == "private" && $0.isDone } }
    var body: some View {
        NavigationStack {
            List {
                Section { AddField(placeholder: "Add a note", visibility: "private") } footer: { Text("Only you can see these.") }
                Section {
                    ForEach(open) { NoteRow(note: $0) }
                        .onMove { from, to in Task { await store.move(open, from: from, to: to) } }
                        .onDelete { idx in for i in idx { let n = open[i]; Task { await store.delete(n) } } }
                }
                if !done.isEmpty {
                    Section(isExpanded: $showDone) { ForEach(done) { NoteRow(note: $0) } } header: { Text("Done (\(done.count))") }
                }
                ErrorBanner()
            }
            .listStyle(.sidebar)
            .navigationTitle("My notes")
            .navigationDestination(for: String.self) { NoteDetail(id: $0) }
            .toolbar { EditButton() }
            .refreshable { await store.refresh() }
        }
    }
}

struct TeamBoard: View {
    @EnvironmentObject var store: Store
    @State private var column: String = "all"
    var columns: [(id: String, label: String)] {
        [("all", "All")] + store.members.map { ($0.id, $0.id == store.me?.id ? "Me" : String($0.name.split(separator: " ").first ?? "")) } + [("none", "Unassigned")]
    }
    func items(_ id: String) -> [Note] {
        store.notes.filter { $0.visibility == "company" && !$0.isDone && (id == "all" || ($0.assigneeId ?? "none") == id) }.sorted { $0.position < $1.position }
    }
    var groups: [(id: String, label: String)] {
        column == "all" ? store.members.map { ($0.id, $0.id == store.me?.id ? "\($0.name) (you)" : $0.name) } + [("none", "Unassigned")] : columns.filter { $0.id == column }
    }
    var body: some View {
        NavigationStack {
            List {
                Picker("Column", selection: $column) { ForEach(columns, id: \.id) { Text($0.label).tag($0.id) } }
                    .pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                ForEach(groups, id: \.id) { g in
                    let list = items(g.id)
                    Section {
                        if store.canEditBoard { AddField(placeholder: g.id == store.me?.id ? "Add for yourself" : "Add", visibility: "company", assignee: g.id == "none" ? nil : g.id) }
                        ForEach(list) { NoteRow(note: $0, showOwner: true) }
                            .onMove { from, to in Task { await store.move(list, from: from, to: to) } }
                    } header: { Text("\(g.label) · \(list.count)") }
                }
                ErrorBanner()
            }
            .navigationTitle(store.team?.name ?? "Team")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { NoteDetail(id: $0) }
            .refreshable { await store.refresh() }
        }
    }
}

struct NoteDetail: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var title = ""
    @State private var body_ = ""
    @State private var confirmDelete = false
    var note: Note? { store.notes.first { $0.id == id } }
    var body: some View {
        if let note {
            let readOnly = note.visibility == "company" && !store.canEditBoard
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical).font(.headline).disabled(readOnly)
                    TextField("Details", text: $body_, axis: .vertical).lineLimit(4...).disabled(readOnly)
                }
                if note.visibility == "company" && store.canEditBoard {
                    Section("Assigned to") {
                        Picker("Assigned to", selection: Binding(get: { note.assigneeId ?? "" }, set: { v in Task { await store.update(note, ["assigneeId": v.isEmpty ? nil : v]) } })) {
                            Text("Unassigned").tag("")
                            ForEach(store.members) { Text($0.name).tag($0.id) }
                        }.pickerStyle(.menu).labelsHidden()
                    }
                }
                Section {
                    if note.visibility == "private" && store.canEditBoard { Button("Share with team") { Task { await store.update(note, ["visibility": "company"]) } } }
                    if note.visibility == "company" && note.ownerId == store.me?.id { Button("Make private") { Task { await store.update(note, ["visibility": "private"]) } } }
                    if note.ownerId == store.me?.id || store.isAdmin { Button("Delete", role: .destructive) { confirmDelete = true } }
                } footer: { if let by = note.updatedByName { Text("Last changed by \(note.updatedBy == store.me?.id ? "you" : by)") } }
            }
            .navigationTitle(note.visibility == "private" ? "Private note" : "Team note")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { title = note.title; body_ = note.body }
            .onDisappear {
                var patch: [String: Any?] = [:]
                if !title.trimmingCharacters(in: .whitespaces).isEmpty && title != note.title { patch["title"] = title }
                if body_ != note.body { patch["body"] = body_ }
                if !patch.isEmpty { Task { await store.update(note, patch) } }
            }
            .confirmationDialog("Delete this note?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) { Task { await store.delete(note); dismiss() } }
            }
        } else { ContentUnavailableView("Note removed", systemImage: "note.text") }
    }
}

struct Settings: View {
    @EnvironmentObject var store: Store
    var body: some View {
        NavigationStack {
            Form {
                if let me = store.me {
                    Section {
                        HStack(spacing: 12) {
                            Text(initials(me.name)).font(.footnote.bold()).foregroundStyle(.white).frame(width: 36, height: 36).background(Circle().fill(accent))
                            VStack(alignment: .leading) { Text(me.name).bold(); Text(me.email).font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                }
                if store.teams.count > 1 {
                    Section("Team") {
                        Picker("Team", selection: Binding(get: { store.team?.id ?? "" }, set: { v in Task { await store.switchTeam(v) } })) { ForEach(store.teams) { Text($0.name).tag($0.id) } }
                    }
                }
                Section {
                    LabeledContent("Team", value: store.team?.name ?? "—")
                    LabeledContent("Your role", value: store.team?.role.capitalized ?? "—")
                    LabeledContent("Members", value: "\(store.members.count)")
                    if let url = URL(string: store.server) { Link("Invite people on the web", destination: url) }
                } footer: { Text("Notes are stored on \(URL(string: store.server)?.host ?? store.server), shared with the TerminAI Mac app and the website.") }
                Section { Button("Sign out", role: .destructive) { Task { await store.signOut() } } }
            }
            .navigationTitle("Settings")
        }
    }
}
