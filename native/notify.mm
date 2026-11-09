// TerminAI's macOS notification permission, from inside the app's own process (Electron never asks for it, so macOS
// drops every notification with "not allowed"). status() and ask() resolve with authorized | denied | provisional |
// notDetermined. Built by scripts/build-notify.sh into resources/notify.node.
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

struct Job { napi_deferred deferred; napi_threadsafe_function tsfn; };
static const char *name(UNAuthorizationStatus s) {
  switch (s) { case UNAuthorizationStatusAuthorized: return "authorized"; case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusProvisional: return "provisional"; case UNAuthorizationStatusNotDetermined: return "notDetermined"; default: return "other"; }
}
static void settle(napi_env env, napi_value, void *context, void *data) {
  Job *job = (Job *)context; napi_value v;
  napi_create_string_utf8(env, (const char *)data, NAPI_AUTO_LENGTH, &v);
  napi_resolve_deferred(env, job->deferred, v);
  napi_release_threadsafe_function(job->tsfn, napi_tsfn_release); delete job;
}
static napi_value start(napi_env env, bool ask) {
  napi_value promise, label; Job *job = new Job();
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "notify", NAPI_AUTO_LENGTH, &label);
  napi_create_threadsafe_function(env, nullptr, nullptr, label, 0, 1, nullptr, nullptr, job, settle, &job->tsfn);
  UNUserNotificationCenter *c = [UNUserNotificationCenter currentNotificationCenter];
  void (^report)(void) = ^{ [c getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    napi_call_threadsafe_function(job->tsfn, (void *)name(s.authorizationStatus), napi_tsfn_blocking); }]; };
  if (ask) [c requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                            completionHandler:^(BOOL, NSError *) { report(); }];
  else report();
  return promise;
}
static napi_value Status(napi_env env, napi_callback_info) { return start(env, false); }
static napi_value Ask(napi_env env, napi_callback_info) { return start(env, true); }
static napi_value Init(napi_env env, napi_value exports) {
  napi_value f;
  napi_create_function(env, "status", NAPI_AUTO_LENGTH, Status, nullptr, &f); napi_set_named_property(env, exports, "status", f);
  napi_create_function(env, "ask", NAPI_AUTO_LENGTH, Ask, nullptr, &f); napi_set_named_property(env, exports, "ask", f);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
