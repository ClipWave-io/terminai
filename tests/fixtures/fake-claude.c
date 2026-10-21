// A stand-in for claude in the account test: logs where its requests would go and what it is typed.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  const char *base = getenv("ANTHROPIC_BASE_URL"), *proxy = getenv("HTTPS_PROXY"), *ca = getenv("NODE_EXTRA_CA_CERTS"), *log = getenv("FAKE_CLAUDE_LOG"), *dir = getenv("FAKE_PROJECT_DIR");
  const char *sid = "";
  for (int i = 1; i < argc - 1; i++) if (!strcmp(argv[i], "--session-id") || !strcmp(argv[i], "--resume")) sid = argv[i + 1];
  FILE *f = fopen(log, "a");
  fprintf(f, "start sid=%s base=%s proxy=%s ca=%s args=", sid, base ? base : "none", proxy ? proxy : "none", ca ? ca : "none");
  for (int i = 1; i < argc; i++) fprintf(f, "%s ", argv[i]);
  fprintf(f, "\n");
  fclose(f);
  if (*sid && dir) { char path[2048]; snprintf(path, sizeof path, "%s/%s.jsonl", dir, sid); fclose(fopen(path, "a")); }
  printf("fake claude ready\n");
  fflush(stdout);
  char line[8192];
  while (fgets(line, sizeof line, stdin)) { f = fopen(log, "a"); fprintf(f, "input %s", line); fclose(f); }
  return 0;
}
