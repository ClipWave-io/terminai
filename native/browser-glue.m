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
static void addMenu(void);
static void showControls(NSWindow *w, BOOL show);
static void showBackIn(NSWindow *w, BOOL show);
static __weak NSWindow *glued;
static NSRect freeFrame;

// The browser window: the biggest normal window that can be main (tabs, toolbar). Chromium 159's windows were missed by a
// class-name test (it only ever matched a stand-in in tests), so the glue never found the window on a real browser.
static BOOL isBrowserWindow(NSWindow *w) {
  return w.parentWindow == nil && w.level == NSNormalWindowLevel && ![w isKindOfClass:NSPanel.class] && w.canBecomeMainWindow
    && w.frame.size.width > 300 && w.frame.size.height > 200;
}
static NSWindow *browserWindow(void) {
  if (glued && (glued.isVisible || isBrowserWindow(glued))) return glued;
  NSWindow *best = nil; CGFloat area = 0;
  for (NSWindow *w in NSApp.windows) if (isBrowserWindow(w)) { CGFloat a = w.frame.size.width * w.frame.size.height; if (w.isVisible) a *= 4; if (a > area) { area = a; best = w; } }
  return best ?: glued;
}
// What the glue sees, for diagnosis: <glueFile>.diag lists every window of the browser.
static void diag(void) {
  static int n; if (n++ % 25) return;
  NSMutableArray *rows = [NSMutableArray array];
  for (NSWindow *w in NSApp.windows) [rows addObject:[NSString stringWithFormat:@"%@ #%ld level=%ld main=%d visible=%d %@ parent=%d", NSStringFromClass(w.class), (long)w.windowNumber, (long)w.level, w.canBecomeMainWindow, w.isVisible, NSStringFromRect(w.frame), w.parentWindow != nil]];
  [[rows componentsJoinedByString:@"\n"] writeToFile:[gluePath stringByAppendingString:@".diag"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
static void buttons(NSWindow *w, BOOL hidden) {
  for (NSWindowButton b = NSWindowCloseButton; b <= NSWindowZoomButton; b++) [w standardWindowButton:b].hidden = hidden;
}
static BOOL targetOnScreen(CGWindowID target) {
  NSArray *info = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, target));
  return info.count > 0 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
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
  addMenu(); diag();
  readWant(); if (!want) return;
  NSString *mode = want[@"mode"]; NSWindow *w = browserWindow(); if (!w) return;
  if ([mode isEqual:@"glued"]) {
    CGWindowID target = (CGWindowID)[want[@"target"] unsignedIntValue];
    NSRect frame = NSMakeRect([want[@"x"] doubleValue], [want[@"y"] doubleValue], [want[@"w"] doubleValue], [want[@"h"] doubleValue]);
    if (frame.size.width < 50 || frame.size.height < 50 || !target) return;
    if (glued != w) { if (glued) { buttons(glued, NO); glued.movable = YES; showControls(glued, NO); } freeFrame = w.frame; glued = w; }
    if (w.styleMask & NSWindowStyleMaskFullScreen) return;
    // TerminAI's window may be on another Space (desktop) than the browser's: the browser joins every Space while glued
    // and is shown only while TerminAI's window is on screen, so it is always where TerminAI is, and nowhere else.
    // Same Space (desktop) as TerminAI, and only that one: when TerminAI is on screen but the browser is not (it sits on
    // another Space), it joins all Spaces for one moment, is ordered in here, and is a normal one-Space window again on
    // the next tick. So switching desktops or apps moves it together with TerminAI, never showing it anywhere else.
    static BOOL joining;
    if (joining) { w.collectionBehavior &= ~NSWindowCollectionBehaviorCanJoinAllSpaces; joining = NO; }
    if (!targetOnScreen(target)) return;
    if (w.isVisible && !w.isOnActiveSpace) { w.collectionBehavior |= NSWindowCollectionBehaviorCanJoinAllSpaces; joining = YES; }
    if (NSApp.isHidden) [NSApp unhideWithoutActivation];
    if (w.isMiniaturized) [w deminiaturize:nil];
    showBackIn(w, NO); buttons(w, YES); w.movable = NO;
    if (!NSEqualRects(w.frame, frame)) [w setFrame:frame display:YES];
    if (!w.isVisible || !rightAbove(w, target)) [w orderWindow:NSWindowAbove relativeTo:(NSInteger)target];
  } else if ([mode isEqual:@"free"] && !glued) {
    NSWindow *bw = browserWindow(); if (bw && !(bw.styleMask & NSWindowStyleMaskFullScreen)) showBackIn(bw, YES);
  } else if ([mode isEqual:@"hidden"]) {
    // Also before it was ever glued: started in the background (TerminAI opens it at launch so the pane is instant).
    NSWindow *h = glued ?: w; if (h.isVisible) [h orderOut:nil];
  } else if (glued) {
    NSWindow *g = glued; glued = nil; buttons(g, NO); g.movable = YES; showControls(g, NO); showBackIn(g, YES);
    g.collectionBehavior &= ~NSWindowCollectionBehaviorCanJoinAllSpaces;
    if (!NSIsEmptyRect(freeFrame)) [g setFrame:freeFrame display:YES];
    [g makeKeyAndOrderFront:nil];
  }
  // TerminAI reads this to know the browser can be glued (an older browser without this file is placed beside it).
  static BOOL acked; if (!acked) { acked = YES; [[NSString stringWithFormat:@"%d", getpid()] writeToFile:[gluePath stringByAppendingString:@".ack"] atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
}

// A "TerminAI" menu in the browser's menu bar: back into TerminAI's pane when it is a window of its own (⇧⌘I), or out
// of it. TerminAI picks the request up from <glueFile>.req ("pane" or "free") and writes the new mode.
@interface TerminAIGlueMenu : NSObject <NSMenuDelegate>
@end
@implementation TerminAIGlueMenu
- (void)toggle:(id)sender {
  NSString *req = [want[@"mode"] isEqual:@"free"] || !want ? @"pane" : @"free";
  [req writeToFile:[gluePath stringByAppendingString:@".req"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
- (void)menuNeedsUpdate:(NSMenu *)menu {
  menu.itemArray.firstObject.title = [want[@"mode"] isEqual:@"free"] || !want ? @"Show Inside TerminAI" : @"Open in Its Own Window";
}
@end
static TerminAIGlueMenu *menuTarget;

// In the pane, the traffic lights are hidden and their place at the left of the tab strip holds TerminAI's own two
// buttons: × closes the pane (the browser keeps running hidden), the arrow pops it out into a window of its own.
@interface TerminAIGlueButtons : NSObject
@end
@implementation TerminAIGlueButtons
- (void)close:(id)sender { [@"close" writeToFile:[gluePath stringByAppendingString:@".req"] atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
- (void)popIn:(id)sender { [@"pane" writeToFile:[gluePath stringByAppendingString:@".req"] atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
- (void)popOut:(id)sender { [@"free" writeToFile:[gluePath stringByAppendingString:@".req"] atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
@end
static TerminAIGlueButtons *buttonTarget;
static NSView *controls;
static NSButton *symbolButton(NSString *symbol, NSString *tip, SEL action) {
  NSImage *img = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:tip];
  img = [img imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:12 weight:NSFontWeightSemibold]];
  NSButton *b = [NSButton buttonWithImage:img target:buttonTarget action:action];
  b.bordered = NO; b.toolTip = tip; b.contentTintColor = [NSColor secondaryLabelColor];
  b.frame = NSMakeRect(0, 0, 26, 26);
  return b;
}
// As a window of its own: the green zoom button's place holds a button back into TerminAI's pane.
static NSButton *backIn;
static void showBackIn(NSWindow *w, BOOL show) {
  NSButton *zoom = [w standardWindowButton:NSWindowZoomButton];
  if (!show || !zoom.superview) { [backIn removeFromSuperview]; zoom.hidden = NO; return; }
  if (!buttonTarget) buttonTarget = [TerminAIGlueButtons new];
  if (!backIn) backIn = symbolButton(@"arrow.down.left.square", @"Show inside TerminAI  ⇧⌘I", @selector(popIn:));
  backIn.image = [[NSImage imageWithSystemSymbolName:@"arrow.down.left.square" accessibilityDescription:@"Show inside TerminAI"] imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:12 weight:NSFontWeightSemibold]];
  NSRect f = zoom.frame; f = NSMakeRect(NSMidX(f) - 11, NSMidY(f) - 11, 22, 22);
  if (backIn.superview != zoom.superview) { [backIn removeFromSuperview]; [zoom.superview addSubview:backIn positioned:NSWindowAbove relativeTo:nil]; }
  backIn.frame = f; zoom.hidden = YES;
}
static void showControls(NSWindow *w, BOOL show) {
  NSView *frame = w.contentView.superview; if (!frame) return;
  if (!buttonTarget) buttonTarget = [TerminAIGlueButtons new];
  if (!controls) {
    controls = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 64, 30)];
    NSButton *x = symbolButton(@"xmark", @"Close the browser pane (it keeps running for your agents)", @selector(close:));
    NSButton *out = symbolButton(@"arrow.up.forward.square", @"Open in its own window", @selector(popOut:));
    x.frame = NSMakeRect(6, 2, 26, 26); out.frame = NSMakeRect(34, 2, 26, 26);
    [controls addSubview:x]; [controls addSubview:out];
  }
  if (!show) { [controls removeFromSuperview]; return; }
  // Top left of the window, centred on the tab strip (about 40 points high in Chromium's normal density).
  NSRect f = NSMakeRect(8, frame.bounds.size.height - 38, 64, 30);
  if (controls.superview != frame) { [controls removeFromSuperview]; [frame addSubview:controls positioned:NSWindowAbove relativeTo:nil]; }
  if (!NSEqualRects(controls.frame, f)) controls.frame = f;
  controls.autoresizingMask = NSViewMinYMargin | NSViewMaxXMargin;
}
static void addMenu(void) {
  NSMenu *bar = NSApp.mainMenu; if (!bar || menuTarget) return;
  menuTarget = [TerminAIGlueMenu new];
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"TerminAI"]; menu.delegate = menuTarget;
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:@"Show Inside TerminAI" action:@selector(toggle:) keyEquivalent:@"i"];
  item.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift; item.target = menuTarget;
  [menu addItem:item];
  NSMenuItem *top = [[NSMenuItem alloc] initWithTitle:@"TerminAI" action:nil keyEquivalent:@""]; top.submenu = menu;
  [bar insertItem:top atIndex:MIN((NSInteger)2, bar.numberOfItems)];
}

__attribute__((constructor)) static void start(void) {
  const char *path = getenv("TERMINAI_GLUE_FILE"); if (!path || !*path) return;
  gluePath = [NSString stringWithUTF8String:path];
  // Only this process: Chromium's helpers (GPU, renderers) must not inherit it.
  unsetenv("DYLD_INSERT_LIBRARIES"); unsetenv("TERMINAI_GLUE_FILE");
  dispatch_async(dispatch_get_main_queue(), ^{
    NSTimer *t = [NSTimer timerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *_) { tick(); }];
    NSNotificationCenter *ws = NSWorkspace.sharedWorkspace.notificationCenter;
    for (NSNotificationName n in @[NSWorkspaceActiveSpaceDidChangeNotification, NSWorkspaceDidHideApplicationNotification, NSWorkspaceDidUnhideApplicationNotification, NSWorkspaceDidActivateApplicationNotification])
      [ws addObserverForName:n object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *_) { tick(); }];
    [NSRunLoop.mainRunLoop addTimer:t forMode:NSRunLoopCommonModes];
  });
}
