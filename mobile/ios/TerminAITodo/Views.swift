import SwiftUI
import QuickLook

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
                    TodoBoard().tabItem { Label("To-do", systemImage: "checklist") }
                    SharedNotes().tabItem { Label("Notes", systemImage: "note.text") }
                }
                .task { await store.refresh() }
                // The Macs copy their edits to the server every minute; the phone looks as often while open.
                .task { while !Task.isCancelled { try? await Task.sleep(for: .seconds(30)); await store.refresh() } }
            }
        }
        .tint(accent)
        .onChange(of: phase) { _, now in if now == .active { Task { await store.refresh() } } }
    }
}

/// Members and Settings, top right on every page; one sheet at a time.
enum TopSheet: String, Identifiable { case members, settings; var id: String { rawValue } }
struct TopButtons: ViewModifier {
    @Binding var sheet: TopSheet?
    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { sheet = .members } label: { Image(systemName: "person.2") }.accessibilityLabel("Members")
                    Button { sheet = .settings } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
                }
            }
            .sheet(item: $sheet) { which in
                switch which {
                case .members: MembersView()
                case .settings: Settings()
                }
            }
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

// MARK: - Sign in, create an account, join with an invitation

struct Welcome: View {
    @EnvironmentObject var store: Store
    @Environment(\.openURL) private var openURL
    @State private var otherServer = false
    enum Mode: String, CaseIterable { case signIn = "Sign in", start = "Create account", join = "Join" }
    @State private var mode = Mode.signIn
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var invite = ""
    var ready: Bool {
        switch mode {
        case .signIn: return !email.isEmpty && !password.isEmpty
        case .start: return !name.isEmpty && !email.isEmpty && password.count >= 12
        case .join: return !invite.isEmpty && !name.isEmpty && (password.isEmpty || password.count >= 12)
        }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("›_").font(.system(.title2, design: .monospaced).weight(.semibold)).foregroundStyle(accent)
                        Text("TerminAI").font(.title.bold())
                        Text("Your notes, synced with the TerminAI Mac app and the web. Use it alone, or invite people later.").foregroundStyle(.secondary)
                    }.listRowBackground(Color.clear)
                    Picker("", selection: $mode) { ForEach(Mode.allCases, id: \.self) { Text($0.rawValue) } }
                        .pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
                if mode == .signIn {
                    Section {
                        if let device = store.device {
                            VStack(spacing: 8) {
                                Text("Allow this code on your Mac").font(.subheadline).foregroundStyle(.secondary)
                                Text(device.code).font(.system(.largeTitle, design: .monospaced).weight(.semibold)).textSelection(.enabled)
                                ProgressView().padding(.top, 2)
                            }.frame(maxWidth: .infinity).padding(.vertical, 6)
                            if let url = URL(string: device.verifyUrl) { Button("Allow it on this phone’s website instead") { openURL(url) } }
                            Button("Cancel", role: .cancel) { store.cancelBrowserSignIn() }
                        } else {
                            Button {
                                Task { _ = await store.startBrowserSignIn() }
                            } label: { HStack { Spacer(); Label("Sign in with a code", systemImage: "key.viewfinder").bold(); Spacer() } }
                            .disabled(store.loading)
                        }
                    } footer: {
                        Text(store.device == nil ? "No password needed: the phone shows a code and you allow it on your Mac. Or sign in with your email and password below."
                             : "On your Mac: TerminAI › Sync (the people icon) › Members › Sign in a phone, and type this code. Or on the website: Account › Enter a code. This phone then signs in by itself.")
                    }
                    .task(id: store.device?.pollToken) { await store.waitForBrowserSignIn() }
                }
                Section {
                    if mode == .join { TextField("Invitation link", text: $invite).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    if mode != .signIn { TextField("Your name", text: $name).textContentType(.name) }
                    if mode != .join { TextField("Email", text: $email).keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never) }
                    SecureField(mode == .signIn ? "Password" : mode == .join ? "Password (optional)" : "Password (12+ characters)", text: $password).textContentType(mode == .signIn ? .password : .newPassword)
                } footer: {
                    Text(mode == .join ? "Paste the link someone sent you. No password needed." : mode == .start ? "Free. Use it by yourself; invite people only if you want to." : "")
                }
                Section {
                    Button {
                        Task {
                            switch mode {
                            case .signIn: await store.signIn(email: email, password: password)
                            case .start: await store.signUp(name: name, email: email, password: password)
                            case .join: await store.join(invite: invite, name: name, password: password)
                            }
                        }
                    } label: { HStack { Spacer(); if store.loading { ProgressView() } else { Text(mode == .start ? "Create account" : mode == .join ? "Join" : "Sign in").bold() }; Spacer() } }
                    .disabled(!ready || store.loading)
                    ErrorBanner()
                }
                // Only for someone running their own TerminAI server; everyone else keeps the default.
                Section {
                    DisclosureGroup("Use your own server", isExpanded: $otherServer) {
                        TextField("Server address", text: $store.server).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).font(.footnote)
                        if store.server != defaultServer { Button("Use TerminAI’s server") { store.server = defaultServer } }
                    }.font(.footnote).foregroundStyle(.secondary)
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
                Section { TextField("Workspace name", text: $name); Button("Create workspace") { Task { await store.createTeam(name) } }.disabled(name.isEmpty) }
                    header: { Text("You don’t have a workspace yet") } footer: { Text("Or open an invitation link someone sent you.") }
                Section { ErrorBanner(); Button("Sign out", role: .destructive) { Task { await store.signOut() } } }
            }.navigationTitle("Welcome")
        }
    }
}

// MARK: - To-do: the shared page, the same columns as the Mac app

struct TaskRow: View {
    @EnvironmentObject var store: Store
    let task: TaskItem
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button { Task { await store.edit(task) { $0.status = task.isDone ? "open" : "done" } } } label: {
                Image(systemName: task.isDone ? "checkmark.circle.fill" : task.status == "doing" ? "circle.lefthalf.filled" : "circle")
                    .font(.title3).foregroundStyle(task.isDone || task.status == "doing" ? accent : .secondary)
            }.buttonStyle(.plain).disabled(!store.canEditBoard)
            NavigationLink(value: task.id) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title).strikethrough(task.isDone).foregroundStyle(task.isDone ? .secondary : .primary)
                    if !task.notes.isEmpty { Text(task.notes).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                    HStack(spacing: 6) {
                        if task.status == "doing" { Text("In progress").font(.caption2.bold()).foregroundStyle(accent) }
                        if !task.product.isEmpty { Text(task.product).font(.caption2).foregroundStyle(.tertiary) }
                        if let n = task.images?.count, n > 0 { Label("\(n)", systemImage: "photo").font(.caption2).foregroundStyle(.tertiary) }
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct AddTask: View {
    @EnvironmentObject var store: Store
    let column: String?
    @State private var text = ""
    @FocusState private var focused: Bool
    var body: some View {
        HStack {
            Image(systemName: "plus").foregroundStyle(accent)
            TextField(column == store.myColumn ? "Add for yourself" : "Add for \(store.name(column: column))", text: $text).focused($focused).submitLabel(.done).onSubmit {
                let t = text.trimmingCharacters(in: .whitespaces); guard !t.isEmpty else { return }
                text = ""; focused = true
                Task { await store.addTask(t, to: column) }
            }
        }
    }
}

struct TodoBoard: View {
    @EnvironmentObject var store: Store
    @State private var column = "mine"
    @State private var showDone = false
    @State private var sheet: TopSheet?
    /// Columns in the Mac's order: you, Together, the other one, Unassigned.
    var columns: [String?] {
        let me = store.myColumn ?? "ilai"
        return [me, "both", me == "ilai" ? "livio" : "ilai", nil]
    }
    func key(_ c: String?) -> String { c ?? "none" }
    func items(_ c: String?, done: Bool) -> [TaskItem] {
        store.tasks.filter { $0.assignee == c && $0.isDone == done }.sorted { done ? ($0.updatedAt ?? "") > ($1.updatedAt ?? "") : $0.sortKey < $1.sortKey }
    }
    var shown: [String?] { column == "all" ? columns : columns.filter { key($0) == (column == "mine" ? key(columns[0]) : column) } }
    var body: some View {
        NavigationStack {
            List {
                if store.myColumn == nil && !store.tasks.isEmpty || store.myColumn == nil && store.members.count > 1 {
                    Section {
                        Button("I’m Ilai") { Task { await store.claim("ilai") } }
                        Button("I’m Matteo") { Task { await store.claim("livio") } }
                    } header: { Text("Which column is yours?") } footer: { Text("Once, so “Add for yourself” and your edits carry your name. Your Mac sets this by itself when it syncs.") }
                }
                Picker("Column", selection: $column) {
                    ForEach(columns, id: \.self) { c in Text(c == columns[0] ? "Me" : store.name(column: c)).tag(c == columns[0] ? "mine" : key(c)) }
                    Text("All").tag("all")
                }
                .pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                ForEach(shown, id: \.self) { c in
                    let list = items(c, done: false)
                    Section {
                        if store.canEditBoard { AddTask(column: c) }
                        ForEach(list) { TaskRow(task: $0) }
                            .onDelete { idx in for i in idx { let t = list[i]; Task { await store.deleteTask(t) } } }
                    } header: { Text("\(c == store.myColumn ? "\(store.name(column: c)) (you)" : store.name(column: c)) · \(list.count)") }
                }
                let done = shown.flatMap { items($0, done: true) }
                if !done.isEmpty {
                    Section(isExpanded: $showDone) { ForEach(done) { TaskRow(task: $0) } } header: { Text("Done (\(done.count))") }
                }
                ErrorBanner()
            }
            .listStyle(.sidebar)
            .navigationTitle("To-do")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { TaskDetail(id: $0) }
            .refreshable { await store.refresh() }
            .modifier(TopButtons(sheet: $sheet))
        }
    }
}

struct TaskDetail: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var title = ""
    @State private var notes = ""
    @State private var confirmDelete = false
    var task: TaskItem? { store.tasks.first { $0.id == id } }
    var body: some View {
        if let task {
            let readOnly = !store.canEditBoard
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical).font(.headline).disabled(readOnly)
                    TextField("Note", text: $notes, axis: .vertical).lineLimit(4...).disabled(readOnly)
                }
                Section {
                    Picker("Column", selection: Binding(get: { task.assignee ?? "" }, set: { v in Task { await store.edit(task) { $0.assignee = v.isEmpty ? nil : v } } })) {
                        ForEach(["ilai", "both", "livio", ""], id: \.self) { Text(store.name(column: $0.isEmpty ? nil : $0)).tag($0) }
                    }
                    Picker("Status", selection: Binding(get: { task.status }, set: { v in Task { await store.edit(task) { $0.status = v } } })) {
                        Text("Open").tag("open"); Text("In progress").tag("doing"); Text("Done").tag("done")
                    }
                }.disabled(readOnly)
                if let n = task.images?.count, n > 0 { Section { Text("\(n) picture\(n > 1 ? "s" : "") under this task: open it in TerminAI on the Mac to see them.").font(.footnote).foregroundStyle(.secondary) } }
                if !readOnly { Section { Button("Delete", role: .destructive) { confirmDelete = true } } footer: { Text("Last changed by \(store.name(column: task.updatedBy))\(task.updatedVia == "ai" ? "’s AI" : "")") } }
            }
            .navigationTitle(store.name(column: task.assignee))
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { title = task.title; notes = task.notes }
            .onDisappear {
                let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
                if (!t.isEmpty && t != task.title) || notes != task.notes { Task { await store.edit(task) { if !t.isEmpty { $0.title = t }; $0.notes = notes } } }
            }
            .confirmationDialog("Delete this task for both of you?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) { Task { await store.deleteTask(task); dismiss() } }
            }
        } else { ContentUnavailableView("Task removed", systemImage: "checklist") }
    }
}

// MARK: - Shared notes, like Apple Notes (made on the Mac or here; files open with Quick Look)

struct SharedNotes: View {
    @EnvironmentObject var store: Store
    @State private var sheet: TopSheet?
    @State private var path: [String] = []
    @State private var query = ""
    var shown: [Note] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? store.notes : store.notes.filter { "\($0.title)\n\($0.body)".lowercased().contains(q) }
    }
    var body: some View {
        NavigationStack(path: $path) {
            List {
                ForEach(shown) { n in
                    NavigationLink(value: n.id) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(n.title.isEmpty ? "Untitled" : n.title).bold().lineLimit(1)
                            HStack(spacing: 6) {
                                Text(ISO8601DateFormatter.lenient(n.updatedAt).map { $0.formatted(.relative(presentation: .named)) } ?? "")
                                Text(n.body.split(separator: "\n").first.map(String.init) ?? "No text").lineLimit(1)
                            }.font(.footnote).foregroundStyle(.secondary)
                            if let f = n.files, !f.isEmpty { Label("\(f.count) file\(f.count > 1 ? "s" : "")", systemImage: "paperclip").font(.caption2).foregroundStyle(.tertiary) }
                        }
                    }
                }
                if shown.isEmpty { Text(query.isEmpty ? "No shared notes yet." : "No matches").foregroundStyle(.secondary) }
                ErrorBanner()
            }
            .searchable(text: $query)
            .navigationTitle("Notes")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { DocDetail(id: $0) }
            .refreshable { await store.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { if let id = await store.addDoc() { path.append(id) } } } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New note").disabled(!store.canEditBoard)
                }
            }
            .modifier(TopButtons(sheet: $sheet))
        }
    }
}

struct DocDetail: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var title = ""
    @State private var text = ""
    @State private var preview: URL?
    @State private var confirmDelete = false
    var note: Note? { store.notes.first { $0.id == id } }
    var body: some View {
        if let note {
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical).font(.title3.bold())
                    TextField("Write here", text: $text, axis: .vertical).lineLimit(8...)
                }.disabled(!store.canEditBoard)
                if let files = note.files, !files.isEmpty {
                    Section("Files") {
                        ForEach(files) { f in
                            Button { Task { preview = await store.download(f, of: note) } } label: {
                                HStack { Image(systemName: "doc"); Text(f.name).lineLimit(1); Spacer(); Text(ByteCountFormatter.string(fromByteCount: Int64(f.size), countStyle: .file)).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
                Section {
                    if store.canEditBoard { Button("Delete for everyone", role: .destructive) { confirmDelete = true } }
                } footer: { if let by = note.updatedByName { Text("Edited by \(by). Add files from TerminAI on the Mac.") } }
            }
            .quickLookPreview($preview)
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { title = note.title; text = note.body }
            .onDisappear {
                var patch: [String: Any?] = [:]
                if !title.trimmingCharacters(in: .whitespaces).isEmpty && title != note.title { patch["title"] = title }
                if text != note.body { patch["body"] = text }
                if !patch.isEmpty { Task { await store.update(note, patch) } }
            }
            .confirmationDialog("Delete this note for everyone?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) { Task { await store.delete(note); dismiss() } }
            }
        } else { ContentUnavailableView("Note removed", systemImage: "note.text") }
    }
}

// MARK: - Members and Settings (the two buttons top right)

struct MembersView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var link: String?
    @State private var code = ""
    @State private var allowed = false
    var body: some View {
        NavigationStack {
            Form {
                Section("In \(store.team?.name ?? "this workspace")") {
                    ForEach(store.members) { m in
                        HStack(spacing: 12) {
                            Text(initials(m.name)).font(.caption.bold()).foregroundStyle(.white).frame(width: 30, height: 30).background(Circle().fill(accent))
                            VStack(alignment: .leading) { Text(m.id == store.me?.id ? "\(m.name) (you)" : m.name); Text(m.email).font(.caption).foregroundStyle(.secondary) }
                            Spacer(); Text(m.role.capitalized).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if store.isAdmin {
                    Section {
                        TextField("Their email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Create invitation link") { Task { link = await store.invite(email.trimmingCharacters(in: .whitespaces)) } }.disabled(!email.contains("@"))
                        if let link, let url = URL(string: link) { ShareLink("Send the link", item: url) }
                    } header: { Text("Invite someone") } footer: { Text("Opening the link signs them in, no password needed. It works for 48 hours.") }
                }
                Section {
                    TextField("ABCD-EFGH", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().font(.system(.body, design: .monospaced))
                    Button(allowed ? "Allowed" : "Allow") { Task { allowed = await store.approve(code: code) } }.disabled(code.count < 8 || allowed)
                } header: { Text("Sign in another device") } footer: { Text("A Mac or phone showing a code to sign in as you: type it here.") }
                ErrorBanner()
            }
            .navigationTitle("Members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct Settings: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    var body: some View {
        NavigationStack {
            Form {
                if let me = store.me {
                    Section {
                        TextField("Your name", text: $name).onSubmit { Task { await store.rename(name) } }
                        LabeledContent("Email", value: me.email)
                    } header: { Text("You") } footer: { Text("Your name is what the others see.") }
                    .onAppear { name = me.name }
                }
                if store.teams.count > 1 {
                    Section("Workspace") {
                        Picker("Workspace", selection: Binding(get: { store.team?.id ?? "" }, set: { v in Task { await store.switchTeam(v) } })) { ForEach(store.teams) { Text($0.name).tag($0.id) } }
                    }
                }
                Section {
                    LabeledContent("Workspace", value: store.team?.name ?? "—")
                    LabeledContent("Your role", value: store.team?.role.capitalized ?? "—")
                    if let c = store.myColumn { LabeledContent("Your To-do column", value: store.name(column: c)) }
                } footer: { Text("The To-do and notes are the same as in TerminAI on the Mac and on the website.") }
                Section { Button("Sign out", role: .destructive) { Task { await store.signOut(); dismiss() } } }
                ErrorBanner()
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { if let me = store.me, name != me.name, !name.isEmpty { Task { await store.rename(name) } }; dismiss() } } }
        }
    }
}
