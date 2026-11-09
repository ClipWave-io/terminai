import SwiftUI
import PhotosUI
import QuickLook

// MARK: - Team chat, the same as the Mac's: last seen, typing, read ticks, photos and files.

struct ChatPerson: Decodable, Identifiable, Hashable { let id: String; let name: String; let seenAt: String?; let readAt: String?; let typing: Bool; let online: Bool }
struct ChatFile: Decodable, Hashable { let id: String?; let name: String?; let mime: String?; let size: Int?; let hidden: Bool? }
struct ChatMessage: Decodable, Identifiable, Hashable { let id: String; let body: String; let at: String; let from: String; let fromName: String; let file: ChatFile? }
private struct ChatPoll: Decodable { let messages: [ChatMessage]; let people: [ChatPerson]; let me: String }
private struct Uploaded: Decodable { let file: ChatFile }

/// Holds the chat while the app is open: one long poll at a time (the server answers as soon as something changes).
@MainActor
final class TeamChatModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var people: [ChatPerson] = []
    @Published var me = ""
    @Published var offline = false
    @Published var sending = false
    private var images: [String: UIImage] = [:]
    private var lastTyping = Date.distantPast

    private func request(_ store: Store, _ path: String, _ method: String = "GET", json: [String: Any]? = nil, data: Data? = nil, timeout: TimeInterval = 20) -> URLRequest? {
        guard let url = URL(string: store.server + "/api/companies/\(store.teamId)" + path) else { return nil }
        var r = URLRequest(url: url, timeoutInterval: timeout); r.httpMethod = method
        r.setValue("Bearer \(store.token)", forHTTPHeaderField: "Authorization")
        if let json { r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = try? JSONSerialization.data(withJSONObject: json) }
        if let data { r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type"); r.httpBody = data }
        return r
    }
    func run(_ store: Store) async {
        var after: String? = messages.last?.at, typing = ""
        while !Task.isCancelled {
            var path = "/chat?wait=\(after == nil ? 0 : 25)&typing=\(typing.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
            if let after { path += "&after=\(after.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" }
            guard let r = request(store, path, timeout: 40) else { return }
            do {
                let (data, resp) = try await URLSession.shared.data(for: r)
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                let p = try JSONDecoder().decode(ChatPoll.self, from: data)
                offline = false; me = p.me; people = p.people
                typing = p.people.filter(\.typing).map(\.id).joined(separator: ",")
                if !p.messages.isEmpty {
                    after = p.messages.last?.at
                    let seen = Set(messages.map(\.id)); messages = Array((messages + p.messages.filter { !seen.contains($0.id) }).suffix(500))
                    if let r = request(store, "/chat/read", "POST", json: [:]) { _ = try? await URLSession.shared.data(for: r) }
                }
            } catch { if Task.isCancelled { return }; offline = true; try? await Task.sleep(for: .seconds(4)) }
        }
    }
    func send(_ store: Store, _ text: String, fileId: String? = nil) async {
        var body: [String: Any] = ["body": text]; if let fileId { body["fileId"] = fileId }
        guard let r = request(store, "/chat", "POST", json: body) else { return }
        _ = try? await URLSession.shared.data(for: r)
    }
    func typed(_ store: Store) {
        guard Date().timeIntervalSince(lastTyping) > 3, let r = request(store, "/chat/typing", "POST", json: [:]) else { return }
        lastTyping = Date(); Task { _ = try? await URLSession.shared.data(for: r) }
    }
    /// A photo or file from the phone: into the team files (visible to everyone in the team), then into the chat.
    func share(_ store: Store, data: Data, name: String, type: String) async {
        sending = true; defer { sending = false }
        let q = "name=\(name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "file")&type=\(type.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")&chat=1"
        guard let r = request(store, "/files?\(q)", "POST", data: data, timeout: 120),
              let (out, resp) = try? await URLSession.shared.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200,
              let up = try? JSONDecoder().decode(Uploaded.self, from: out), let id = up.file.id else { store.error = "Could not send \(name)."; return }
        await send(store, "", fileId: id)
    }
    /// The bytes of a file, only when it is shown or opened; kept for the rest of the session.
    func image(_ store: Store, _ id: String) async -> UIImage? {
        if let i = images[id] { return i }
        guard let r = request(store, "/files/\(id)", timeout: 60), let (data, resp) = try? await URLSession.shared.data(for: r),
              (resp as? HTTPURLResponse)?.statusCode == 200, let img = UIImage(data: data) else { return nil }
        images[id] = img; return img
    }
    func download(_ store: Store, _ file: ChatFile) async -> URL? {
        guard let id = file.id, let r = request(store, "/files/\(id)", timeout: 120), let (data, resp) = try? await URLSession.shared.data(for: r),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { store.error = "Could not open \(file.name ?? "the file")."; return nil }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(id, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let out = dir.appendingPathComponent((file.name ?? "file").replacingOccurrences(of: "/", with: "-"))
        return (try? data.write(to: out)) != nil ? out : nil
    }
}

private func chatDate(_ s: String) -> Date { ISO8601DateFormatter.lenient(s) ?? Date() }
private func lastSeen(_ p: ChatPerson) -> String {
    if p.typing { return "typing…" }
    if p.online { return "online" }
    guard let s = p.seenAt else { return "not on TerminAI yet" }
    let d = chatDate(s), t = d.formatted(date: .omitted, time: .shortened)
    if Calendar.current.isDateInToday(d) { return "last seen today at \(t)" }
    if Calendar.current.isDateInYesterday(d) { return "last seen yesterday at \(t)" }
    return "last seen \(d.formatted(date: .abbreviated, time: .shortened))"
}

struct TeamChatView: View {
    @EnvironmentObject var store: Store
    @StateObject private var chat = TeamChatModel()
    @State private var draft = ""
    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var preview: URL?
    @State private var sheet: TopSheet?
    var others: [ChatPerson] { chat.people.filter { $0.id != chat.me } }
    var subtitle: String {
        if chat.offline { return "connecting…" }
        let t = others.filter(\.typing)
        if !t.isEmpty { return t.map { $0.name.split(separator: " ").first.map(String.init) ?? $0.name }.joined(separator: ", ") + (t.count > 1 ? " are typing…" : " is typing…") }
        if others.count == 1 { return lastSeen(others[0]) }
        return others.isEmpty ? "Invite someone from Members" : "\(others.filter(\.online).count) of \(others.count) online"
    }
    func readByAll(_ m: ChatMessage) -> Bool { !others.isEmpty && others.allSatisfy { ($0.readAt.map(chatDate) ?? .distantPast) >= chatDate(m.at) } }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 4) {
                            if chat.messages.isEmpty { Text("No messages yet. Say hi, or send a photo.").font(.callout).foregroundStyle(.secondary).padding(.top, 40) }
                            ForEach(Array(chat.messages.enumerated()), id: \.element.id) { i, m in
                                let day = chatDate(m.at).formatted(date: .complete, time: .omitted)
                                if i == 0 || chatDate(chat.messages[i - 1].at).formatted(date: .complete, time: .omitted) != day {
                                    Text(Calendar.current.isDateInToday(chatDate(m.at)) ? "Today" : day).font(.caption2).foregroundStyle(.secondary)
                                        .padding(.horizontal, 10).padding(.vertical, 3).background(Capsule().strokeBorder(Color.secondary.opacity(0.3))).padding(.vertical, 8)
                                }
                                Bubble(chat: chat, message: m, mine: m.from == chat.me, showName: others.count > 1 && m.from != chat.me && (i == 0 || chat.messages[i - 1].from != m.from),
                                       read: readByAll(m), open: { f in Task { preview = await chat.download(store, f) } }).id(m.id)
                            }
                        }.padding(.horizontal, 12).padding(.vertical, 8)
                    }
                    .onChange(of: chat.messages.count) { _, _ in if let last = chat.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
                }
                HStack(alignment: .bottom, spacing: 8) {
                    Menu {
                        PhotosPicker(selection: $photo, matching: .any(of: [.images, .videos])) { Label("Photo or video", systemImage: "photo") }
                        Button { importing = true } label: { Label("File", systemImage: "doc") }
                    } label: { Image(systemName: chat.sending ? "hourglass" : "paperclip").font(.title3).frame(width: 34, height: 34) }
                    TextField("Message", text: $draft, axis: .vertical).lineLimit(1...6)
                        .padding(.horizontal, 12).padding(.vertical, 8).background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground)))
                        .onChange(of: draft) { _, v in if !v.isEmpty { chat.typed(store) } }
                    Button {
                        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines); guard !t.isEmpty else { return }; draft = ""
                        Task { await chat.send(store, t) }
                    } label: { Image(systemName: "arrow.up.circle.fill").font(.title).foregroundStyle(accent) }
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }.padding(10)
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(others.count == 1 ? others[0].name : others.isEmpty ? "Team" : others.map { $0.name.split(separator: " ").first.map(String.init) ?? $0.name }.joined(separator: ", ")).font(.headline).lineLimit(1)
                        Text(subtitle).font(.caption2).foregroundStyle(others.contains(where: \.typing) ? accent : .secondary)
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .modifier(TopButtons(sheet: $sheet))
            .task(id: store.teamId) { chat.messages = []; await chat.run(store) }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                Task {
                    defer { photo = nil }
                    guard let data = try? await item.loadTransferable(type: Data.self) else { return }
                    let type = item.supportedContentTypes.first
                    let ext = type?.preferredFilenameExtension ?? "jpg"
                    await chat.share(store, data: data, name: "Photo \(Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false))).\(ext)".replacingOccurrences(of: ":", with: "-"), type: type?.preferredMIMEType ?? "image/jpeg")
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
                guard case .success(let url) = result else { return }
                Task {
                    let ok = url.startAccessingSecurityScopedResource(); defer { if ok { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { return }
                    await chat.share(store, data: data, name: url.lastPathComponent, type: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
                }
            }
            .quickLookPreview($preview)
        }
    }
}

private struct Bubble: View {
    @EnvironmentObject var store: Store
    @ObservedObject var chat: TeamChatModel
    let message: ChatMessage; let mine: Bool; let showName: Bool; let read: Bool; let open: (ChatFile) -> Void
    @State private var image: UIImage?
    var isImage: Bool { (message.file?.mime ?? "").hasPrefix("image/") || (message.file?.name ?? "").range(of: #"\.(png|jpe?g|gif|webp|heic)$"#, options: [.regularExpression, .caseInsensitive]) != nil }
    var body: some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 4) {
                if showName { Text(message.fromName).font(.caption.bold()).foregroundStyle(accent) }
                if let f = message.file {
                    if f.hidden == true { Label("A file you have no access to", systemImage: "lock").font(.caption).foregroundStyle(.secondary) }
                    else if isImage {
                        Button { open(f) } label: {
                            Group { if let image { Image(uiImage: image).resizable().scaledToFit() } else { ProgressView().frame(width: 180, height: 120) } }
                                .frame(maxWidth: 240, maxHeight: 280).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .task { if let id = f.id { image = await chat.image(store, id) } }
                    } else {
                        Button { open(f) } label: {
                            HStack { Image(systemName: "doc.fill").foregroundStyle(accent); VStack(alignment: .leading) { Text(f.name ?? "File").font(.callout).lineLimit(2); Text(ByteCountFormatter.string(fromByteCount: Int64(f.size ?? 0), countStyle: .file)).font(.caption2).foregroundStyle(.secondary) } }
                        }.buttonStyle(.plain)
                    }
                }
                if !message.body.isEmpty { Text(message.body).font(.callout).textSelection(.enabled) }
                HStack(spacing: 3) {
                    Text(chatDate(message.at).formatted(date: .omitted, time: .shortened))
                    if mine { Image(systemName: read ? "checkmark.circle.fill" : "checkmark").foregroundStyle(read ? accent : .secondary) }
                }.font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 14).fill(mine ? accent.opacity(0.2) : Color(.secondarySystemBackground)))
            .fixedSize(horizontal: false, vertical: true)
            if !mine { Spacer(minLength: 40) }
        }
    }
}
