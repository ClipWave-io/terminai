// TerminAI Browser inside TerminAI: loaded into our Chromium (DYLD_INSERT_LIBRARIES, set by src/main/chromium.ts), it
// keeps the browser window on TerminAI's browser pane. TerminAI writes where the pane is to $TERMINAI_GLUE_FILE:
//   {"mode":"glued"|"hidden"|"free","target":<TerminAI's CGWindowID>,"x":..,"y":..,"w":..,"h":..}   (Cocoa screen points)
// glued: the window takes that frame, without traffic lights, not movable, and is kept ordered right above TerminAI's
// window (macOS lets a background app order its window relative to another app's, without taking focus), so clicking
// the terminal never covers it. hidden: ordered out (TerminAI minimised or hidden, or the pane closed). free: a normal
// window again. Extension popups and the side panel are child windows of the browser window: they come along.
// Built by scripts/build-browser.sh: clang -dynamiclib -fobjc-arc -framework Cocoa native/browser-glue.m
#import <Cocoa/Cocoa.h>
#include <sys/stat.h>

static NSString *gluePath;
static NSDictionary *want;
static struct timespec seen;
static __weak NSWindow *glued;
static NSRect freeFrame;

static BOOL isBrowserWindow(NSWindow *w) {
  return [NSStringFromClass(w.class) containsString:@"NativeWidget"] && w.parentWindow == nil && (w.styleMask & NSWindowStyleMaskTitled) && w.contentView.frame.size.width > 300;
}
static NSWindow *browserWindow(void) {
  if (glued && glued.isVisible) return glued;
  for (NSWindow *w in NSApp.orderedWindows) if (isBrowserWindow(w)) return w;
  return glued;
}
static void buttons(NSWindow *w, BOOL hidden) {
  for (NSWindowButton b = NSWindowCloseButton; b <= NSWindowZoomButton; b++) [w standardWindowButton:b].hidden = hidden;
}
static BOOL rightAbove(NSWindow *w, CGWindowID target) {
  // The windows above TerminAI's, front to back: ours must be the nearest one of this app (child popups sit above it).
  NSArray *above = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow, target));
  for (NSInteger i = (NSInteger)above.count - 1; i >= 0; i--) {
    NSDictionary *d = above[i];
    if ([d[(id)kCGWindowNumber] integerValue] == w.windowNumber) return YES;
    if ([d[(id)kCGWindowLayer] integerValue] == 0 && [d[(id)kCGWindowOwnerPID] intValue] != getpid()) return NO;
  }
  return NO;
}
static void readWant(void) {
  struct stat st; if (stat(gluePath.fileSystemRepresentation, &st) != 0) return;
  if (st.st_mtimespec.tv_sec == seen.tv_sec && st.st_mtimespec.tv_nsec == seen.tv_nsec) return;
  seen = st.st_mtimespec;
  NSData *data = [NSData dataWithContentsOfFile:gluePath]; if (!data) return;
  id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if ([json isKindOfClass:NSDictionary.class]) want = json;
}
static void tick(void) {
  readWant(); if (!want) return;
  NSString *mode = want[@"mode"]; NSWindow *w = browserWindow(); if (!w) return;
  if ([mode isEqual:@"glued"]) {
    CGWindowID target = (CGWindowID)[want[@"target"] unsignedIntValue];
    NSRect frame = NSMakeRect([want[@"x"] doubleValue], [want[@"y"] doubleValue], [want[@"w"] doubleValue], [want[@"h"] doubleValue]);
    if (frame.size.width < 50 || frame.size.height < 50 || !target) return;
    if (glued != w) { if (glued) { buttons(glued, NO); glued.movable = YES; } freeFrame = w.frame; glued = w; }
    if (w.styleMask & NSWindowStyleMaskFullScreen) return;
    if (w.isMiniaturized) [w deminiaturize:nil];
    buttons(w, YES); w.movable = NO;
    if (!NSEqualRects(w.frame, frame)) [w setFrame:frame display:YES];
    if (!w.isVisible || !rightAbove(w, target)) [w orderWindow:NSWindowAbove relativeTo:(NSInteger)target];
  } else if ([mode isEqual:@"hidden"]) {
    if (glued && glued.isVisible) [glued orderOut:nil];
  } else if (glued) {
    NSWindow *g = glued; glued = nil; buttons(g, NO); g.movable = YES;
    if (!NSIsEmptyRect(freeFrame)) [g setFrame:freeFrame display:YES];
    [g makeKeyAndOrderFront:nil];
  }
  // TerminAI reads this to know the browser can be glued (an older browser without this file is placed beside it).
  static BOOL acked; if (!acked) { acked = YES; [[NSString stringWithFormat:@"%d", getpid()] writeToFile:[gluePath stringByAppendingString:@".ack"] atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
}

__attribute__((constructor)) static void start(void) {
  const char *path = getenv("TERMINAI_GLUE_FILE"); if (!path || !*path) return;
  gluePath = [NSString stringWithUTF8String:path];
  // Only this process: Chromium's helpers (GPU, renderers) must not inherit it.
  unsetenv("DYLD_INSERT_LIBRARIES"); unsetenv("TERMINAI_GLUE_FILE");
  dispatch_async(dispatch_get_main_queue(), ^{
    NSTimer *t = [NSTimer timerWithTimeInterval:0.08 repeats:YES block:^(NSTimer *_) { tick(); }];
    [NSRunLoop.mainRunLoop addTimer:t forMode:NSRunLoopCommonModes];
  });
}
