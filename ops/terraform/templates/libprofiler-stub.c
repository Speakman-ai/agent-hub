/*
 * Minimal no-op shared library substituting for gperftools libprofiler.so.0.
 *
 * Some Amazon Linux 2023 nginx builds link libprofiler.so.0; the stock
 * libprofiler initializer can segfault nginx at startup (see card 55c14278).
 * This stub exports the public profiler ABI with safe no-ops so nginx loads.
 *
 * SONAME must stay libprofiler.so.0 (see user-data gcc -Wl,-soname,...).
 */
#include <string.h>
#include <time.h>

struct ProfilerOptions {
  int (*filter_in_thread)(void *arg);
  void *filter_in_thread_arg;
};

struct ProfilerState {
  int enabled;
  time_t start_time;
  char profile_name[1024];
  int samples_gathered;
};

int ProfilerStart(const char *fname) {
  (void)fname;
  return 1;
}

int ProfilerStartWithOptions(const char *fname, const struct ProfilerOptions *options) {
  (void)fname;
  (void)options;
  return 1;
}

void ProfilerStop(void) {}

void ProfilerFlush(void) {}

void ProfilerEnable(void) {}

void ProfilerDisable(void) {}

int ProfilingIsEnabledForAllThreads(void) {
  return 0;
}

void ProfilerRegisterThread(void) {}

void ProfilerUnregisterThread(void) {}

void ProfilerGetCurrentState(struct ProfilerState *state) {
  if (!state) {
    return;
  }
  memset(state, 0, sizeof(*state));
}

int ProfilerGetStackTrace(void **result, int max_depth, int skip_count, const void *uc) {
  (void)result;
  (void)max_depth;
  (void)skip_count;
  (void)uc;
  return 0;
}
