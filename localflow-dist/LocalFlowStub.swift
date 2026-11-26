// LocalFlow.app launcher for the copy TerminAI installs (derived from LocalFlow's packaging/LocalFlowStub.swift).
// It is the bundle macOS gives the Microphone and Accessibility permissions to: it starts the bundled Python app
// (Contents/Resources/run.sh) as its child, and children inherit the permissions as the responsible process.
// It also asks for the microphone once at the first start, and writes what macOS allows to
// ~/.local/share/localflow/permissions.json, so TerminAI's setup can show each permission as it is granted.
import AppKit
import AVFoundation
import ApplicationServices

// $HOME like the Python app (Path.home()), so a test run with another HOME stays out of the real one.
let home = ProcessInfo.processInfo.environment["HOME"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser
let bundled = Bundle.main.resourceURL!.appendingPathComponent("run.sh").path
let runScript = FileManager.default.isExecutableFile(atPath: bundled)
    ? bundled : home.appendingPathComponent(".config/localflow/run.sh").path

guard FileManager.default.isExecutableFile(atPath: runScript) else {
    FileHandle.standardError.write("LocalFlow: missing or non-executable \(runScript)\n".data(using: .utf8)!)
    exit(1)
}

let child = Process()
child.executableURL = URL(fileURLWithPath: "/bin/sh")
child.arguments = [runScript]
var env = ProcessInfo.processInfo.environment
env["LOCALFLOW_APP"] = Bundle.main.bundlePath
child.environment = env
child.standardOutput = FileHandle.standardOutput
child.standardError = FileHandle.standardError
child.terminationHandler = { p in
    DispatchQueue.main.async { exit(p.terminationStatus) }
}

signal(SIGTERM, SIG_IGN)
let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
src.setEventHandler { child.terminate() }
src.resume()

do {
    try child.run()
} catch {
    FileHandle.standardError.write("LocalFlow: failed to launch: \(error)\n".data(using: .utf8)!)
    exit(1)
}

// What macOS allows LocalFlow, for TerminAI's setup screen. Written only when it changes.
let statusDir = home.appendingPathComponent(".local/share/localflow")
let statusFile = statusDir.appendingPathComponent("permissions.json")
var lastStatus = ""
func micState() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "notDetermined"
    }
}
func writeStatus() {
    let s = "{\"microphone\":\"\(micState())\",\"accessibility\":\(AXIsProcessTrusted()),\"pid\":\(getpid())}\n"
    if s == lastStatus { return }
    lastStatus = s
    try? FileManager.default.createDirectory(at: statusDir, withIntermediateDirectories: true)
    try? s.write(to: statusFile, atomically: true, encoding: .utf8)
}
writeStatus()
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in writeStatus() }
if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined && ProcessInfo.processInfo.environment["LOCALFLOW_NO_MIC_PROMPT"] == nil {
    AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { writeStatus() } }
}

final class StubDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        DistributedNotificationCenter.default().postNotificationName(
            Notification.Name("com.livio.localflow.reopen"),
            object: nil, userInfo: nil, deliverImmediately: true
        )
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard child.isRunning else { return .terminateNow }
        child.terminationHandler = { _ in
            DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        }
        child.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(0) }
        return .terminateLater
    }
}

let app = NSApplication.shared
let stubDelegate = StubDelegate()
app.delegate = stubDelegate
app.setActivationPolicy(.regular)
app.run()
