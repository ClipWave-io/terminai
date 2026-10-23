import SwiftUI

@main
struct TerminAITodoApp: App {
    @StateObject private var store = Store()
    var body: some Scene {
        WindowGroup {
            Root().environmentObject(store)
        }
    }
}

let productBlue = Color(light: Color(red: 0.12, green: 0.50, blue: 0.82), dark: Color(red: 0.49, green: 0.77, blue: 1.0))
let personColor: [String: Color] = ["ilai": Color(red: 0.70, green: 0.57, blue: 0.91), "livio": Color(red: 0.56, green: 0.70, blue: 0.89)]

extension Color {
    init(light: Color, dark: Color) {
        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
    }
}

struct Root: View {
    @EnvironmentObject var store: Store
    var body: some View {
        Group {
            if store.token.isEmpty || store.user.isEmpty { Setup() }
            else {
                TabView {
                    Board().tabItem { Label("To-do", systemImage: "checklist") }
                    Activity().tabItem { Label("Activity", systemImage: "bell") }
                    Settings().tabItem { Label("Settings", systemImage: "gearshape") }
                }
                .task { await store.refresh() }
            }
        }
        .tint(productBlue)
    }
}

// MARK: - First launch

struct Setup: View {
    @EnvironmentObject var store: Store
    @State private var token = ""
    @State private var checking = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("The shared To-do from TerminAI, on your phone. It reads and writes the same build-tasks repo, so changes show on both Macs at their next sync.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Section("Who are you?") {
                    Picker("You are", selection: $store.user) {
                        Text("Choose").tag("")
                        Text("Ilai").tag("ilai")
                        Text("Matteo").tag("livio")
                    }
                }
                Section {
                    SecureField("GitHub token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Link("Make a token on GitHub", destination: URL(string: "https://github.com/settings/tokens/new?scopes=repo&description=TerminAI%20To-do%20iPhone")!)
                } header: { Text("GitHub access") } footer: {
                    Text("A token that can read and write ClipWave-io/build-tasks. It stays in this iPhone's keychain.")
                }
                if let error = store.error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button(checking ? "Connecting…" : "Connect") {
                        checking = true
                        store.saveToken(token)
                        Task { await store.refresh(); checking = false }
                    }.disabled(token.isEmpty || store.user.isEmpty || checking)
                }
            }
            .navigationTitle("TerminAI To-do")
        }
    }
}

// MARK: - Board

struct Board: View {
    @EnvironmentObject var store: Store
    @State private var column = "mine"
    @State private var adding = false
    @State private var showDone = false

    private var columns: [(key: String, label: String)] {
        let other = store.user == "ilai" ? "livio" : "ilai"
        return [("mine", names[store.user] ?? "Me"), ("both", "Together"), (other, names[other] ?? ""), ("none", "Unassigned")]
    }
    private var assignee: String? { column == "mine" ? store.user : column == "none" ? nil : column }
    private var visible: [TodoTask] {
        store.tasks.filter { $0.assignee == assignee && (store.picked.isEmpty || store.picked.contains($0.product.trimmingCharacters(in: .whitespaces))) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(visible.filter { !$0.isDone }.sorted { $0.rank < $1.rank }) { TaskRow(task: $0) }
                    if visible.allSatisfy(\.isDone) { Text("Nothing open here.").foregroundStyle(.secondary) }
                }
                let done = visible.filter(\.isDone).sorted { $0.updatedAt > $1.updatedAt }
                if !done.isEmpty {
                    Section {
                        if showDone { ForEach(done) { TaskRow(task: $0) } }
                        Button(showDone ? "Hide done" : "Show done (\(done.count))") { withAnimation { showDone.toggle() } }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await store.refresh() }
            .safeAreaInset(edge: .top) {
                Picker("Column", selection: $column) { ForEach(columns, id: \.key) { Text($0.label).tag($0.key) } }
                    .pickerStyle(.segmented).padding(.horizontal).padding(.bottom, 6).background(.bar)
            }
            .navigationTitle(columns.first { $0.key == column }?.label ?? "To-do")
            .navigationDestination(for: TodoTask.self) { TaskDetail(task: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ProductMenu() }
                ToolbarItem(placement: .topBarTrailing) { Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("New task") }
            }
            .overlay(alignment: .bottom) { if let error = store.error { ErrorBanner(text: error) } }
            .sheet(isPresented: $adding) { NewTask(assignee: assignee) }
        }
    }
}

struct ProductMenu: View {
    @EnvironmentObject var store: Store
    var body: some View {
        Menu {
            Button { store.productFilter = "" } label: { Label("All products", systemImage: store.picked.isEmpty ? "checkmark" : "") }
            Divider()
            ForEach(store.products, id: \.self) { p in
                Button {
                    var next = store.picked
                    if let i = next.firstIndex(of: p) { next.remove(at: i) } else { next.append(p) }
                    store.productFilter = next.joined(separator: "\n")
                } label: { Label(p, systemImage: store.picked.contains(p) ? "checkmark" : "") }
            }
        } label: {
            Label(store.picked.isEmpty ? "All products" : store.picked.count == 1 ? store.picked[0] : "\(store.picked[0]) +\(store.picked.count - 1)",
                  systemImage: "line.3.horizontal.decrease.circle")
                .labelStyle(.titleAndIcon).font(.subheadline)
        }
    }
}

struct TaskRow: View {
    @EnvironmentObject var store: Store
    let task: TodoTask
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                Task { await store.save(task, verb: task.isDone ? "reopen" : "done") { $0.status = task.isDone ? "open" : "done" } }
            } label: {
                Image(systemName: task.isDone ? "checkmark.circle.fill" : task.status == "doing" ? "circle.dotted" : "circle")
                    .font(.title3).foregroundStyle(task.isDone ? productBlue : .secondary)
            }.buttonStyle(.plain)
            NavigationLink(value: task) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title).strikethrough(task.isDone).foregroundStyle(task.isDone ? .secondary : .primary)
                    HStack(spacing: 6) {
                        if !task.product.isEmpty { ProductTag(product: task.product) }
                        if task.status == "doing" { Text("in progress").font(.caption).italic().foregroundStyle(.secondary) }
                        if mentions(task.notes).contains(store.user) { Text("@you").font(.caption.bold()).foregroundStyle(.orange) }
                        if task.updatedBy != store.user && task.updatedBy != "" {
                            Text("\(names[task.updatedBy] ?? task.updatedBy)\(task.updatedVia == "ai" ? "’s AI" : "")").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if !task.notes.isEmpty { Text(task.notes).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                }
            }
        }
        .swipeActions(edge: .leading) {
            Button { Task { await store.save(task, verb: task.status == "doing" ? "reopen" : "start") { $0.status = task.status == "doing" ? "open" : "doing" } } } label: {
                Label(task.status == "doing" ? "Stop" : "Start", systemImage: "play.circle")
            }.tint(.orange)
        }
    }
}

struct ProductTag: View {
    let product: String
    var body: some View {
        Text(product).font(.caption.weight(.semibold)).foregroundStyle(productBlue)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(productBlue.opacity(0.13), in: RoundedRectangle(cornerRadius: 5))
    }
}

struct ErrorBanner: View {
    let text: String
    var body: some View {
        Text(text).font(.footnote).padding(10).frame(maxWidth: .infinity)
            .background(.red.opacity(0.9), in: RoundedRectangle(cornerRadius: 10)).foregroundStyle(.white).padding()
    }
}

// MARK: - New task and details

struct NewTask: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State var assignee: String?
    @State private var title = ""
    @State private var product = ""
    @State private var saving = false
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            Form {
                TextField("Task", text: $title, axis: .vertical).focused($focused)
                Picker("Column", selection: $assignee) {
                    Text(names[store.user] ?? "Me").tag(Optional(store.user))
                    Text("Together").tag(Optional("both"))
                    let other = store.user == "ilai" ? "livio" : "ilai"
                    Text(names[other] ?? "").tag(Optional(other))
                    Text("Unassigned").tag(String?.none)
                }
                Section("Product") {
                    TextField("e.g. ManyMotions", text: $product)
                    if !store.products.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack { ForEach(store.products, id: \.self) { p in Button { product = p } label: { ProductTag(product: p) }.buttonStyle(.plain) } }
                        }
                    }
                }
            }
            .navigationTitle("New task").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Adding…" : "Add") {
                        saving = true
                        Task { if await store.add(title: title, assignee: assignee, product: product) { dismiss() }; saving = false }
                    }.disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .onAppear {
                focused = true
                if store.picked.count == 1 { product = store.picked[0] }
            }
        }
    }
}

struct TaskDetail: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let task: TodoTask
    @State private var title = ""
    @State private var notes = ""
    @State private var product = ""
    @State private var images: [String: UIImage] = [:]
    @State private var confirmDelete = false

    private var current: TodoTask { store.tasks.first { $0.id == task.id } ?? task }
    private var dirty: Bool { title != current.title || notes != current.notes || product != current.product }

    var body: some View {
        Form {
            Section { TextField("Task", text: $title, axis: .vertical).font(.headline) }
            Section("Note") {
                TextField("Note", text: $notes, axis: .vertical).lineLimit(3...)
                let other = store.user == "ilai" ? "livio" : "ilai"
                if !mentions(notes).contains(other) {
                    Button("Tag \(names[other] ?? "")") { notes += (notes.isEmpty ? "" : "\n") + "@\(names[other] ?? "") " }
                }
            }
            if let names = current.images, !names.isEmpty {
                Section("Pictures") {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(names, id: \.self) { name in
                                Group {
                                    if let image = images[name] { Image(uiImage: image).resizable().scaledToFill() } else { ProgressView() }
                                }
                                .frame(width: 120, height: 120).clipShape(RoundedRectangle(cornerRadius: 8))
                                .task { if images[name] == nil, let img = await store.image(current, name) { images[name] = img } }
                            }
                        }
                    }
                }
            }
            Section("Product") { TextField("Product", text: $product) }
            Section {
                Picker("Status", selection: Binding(get: { current.status }, set: { s in Task { await store.save(current, verb: s == "done" ? "done" : s == "doing" ? "start" : "reopen") { $0.status = s } } })) {
                    Text("Open").tag("open"); Text("In progress").tag("doing"); Text("Done").tag("done")
                }
                Picker("Column", selection: Binding(get: { current.assignee }, set: { a in Task { await store.save(current, verb: "assign to \(a ?? "nobody")") { $0.assignee = a } } })) {
                    Text("Ilai").tag(Optional("ilai")); Text("Together").tag(Optional("both")); Text("Matteo").tag(Optional("livio")); Text("Unassigned").tag(String?.none)
                }
            }
            Section {
                LabeledContent("Created", value: "\(names[current.createdBy] ?? current.createdBy), \(short(current.createdAt))")
                LabeledContent("Last change", value: "\(names[current.updatedBy] ?? current.updatedBy)\(current.updatedVia == "ai" ? "’s AI" : ""), \(short(current.updatedAt))")
            }
            Section { Button("Delete task", role: .destructive) { confirmDelete = true } }
        }
        .navigationTitle("Task").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task {
                        _ = await store.save(current, verb: "edit") { $0.title = title.trimmingCharacters(in: .whitespacesAndNewlines); $0.notes = notes.trimmingCharacters(in: .whitespacesAndNewlines); $0.product = product.trimmingCharacters(in: .whitespaces) }
                    }
                }.disabled(!dirty || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .confirmationDialog("Delete “\(current.title)” for both of you?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await store.delete(current); dismiss() } }
        }
        .onAppear { title = current.title; notes = current.notes; product = current.product }
    }
}

func short(_ iso: String) -> String {
    guard let d = TodoTask.date(iso) else { return iso }
    return d.formatted(date: .abbreviated, time: .shortened)
}

// MARK: - Activity and settings

struct Activity: View {
    @EnvironmentObject var store: Store
    @State private var who = "all"
    var body: some View {
        NavigationStack {
            List {
                Picker("Whose", selection: $who) {
                    Text("All").tag("all"); Text("Ilai").tag("ilai"); Text("Matteo").tag("livio"); Text("AI").tag("ai")
                }.pickerStyle(.segmented).listRowBackground(Color.clear)
                ForEach(store.changes.filter { who == "all" || (who == "ai" ? $0.ai : $0.by == who) }) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(names[c.by] ?? c.by).font(.subheadline.bold()).foregroundStyle(personColor[c.by] ?? .primary)
                            if c.ai { Text("AI").font(.caption2.bold()).padding(.horizontal, 4).overlay(RoundedRectangle(cornerRadius: 4).stroke(.secondary)) }
                            if c.phone { Image(systemName: "iphone").font(.caption2).foregroundStyle(.secondary) }
                            Spacer()
                            Text(c.at, style: .relative).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(c.message).font(.callout)
                    }
                }
            }
            .refreshable { await store.refresh() }
            .navigationTitle("Activity")
        }
    }
}

struct Settings: View {
    @EnvironmentObject var store: Store
    @State private var token = ""
    var body: some View {
        NavigationStack {
            Form {
                Picker("You are", selection: $store.user) { Text("Ilai").tag("ilai"); Text("Matteo").tag("livio") }
                Section("GitHub token") {
                    SecureField("Replace the token", text: $token)
                    Button("Save token") { store.saveToken(token); token = ""; Task { await store.refresh() } }.disabled(token.isEmpty)
                    Button("Sign out", role: .destructive) { store.saveToken("") }
                }
                Section {
                    LabeledContent("Repository", value: "\(Store.owner)/\(Store.repo)")
                    if let last = store.lastSync { LabeledContent("Synced", value: last.formatted(date: .omitted, time: .shortened)) }
                }
            }
            .navigationTitle("Settings")
        }
    }
}
