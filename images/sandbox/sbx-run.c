// sbx-run — pi-gateway sandbox exec 래퍼 (sandboxd가 docker exec로 호출한다)
//
//   sbx-run exec <id> <timeout_sec> <cwd> -- <argv...>
//   sbx-run kill <id> <TERM|KILL>
//
// exec: cwd로 이동한 뒤 argv를 새 세션(= 새 process group)에서 실행한다.
//   cwd가 없으면 "sbx-run: cannot change directory to …" 를 stderr에 쓰고 1로 끝난다
//   (docker exec의 WorkingDir 오류보다 다루기 쉽다). stdout/stderr는 pipe로 받아 그대로 중계한다.
//   명령이 끝나면, 출력이 IDLE_MS 동안 멈추거나 pipe가 모두 닫힐 때 반환한다. 백그라운드 자손이 pipe를
//   쥐고 있어도 기다리지 않는다 (pi 로컬 bash와 같은 동작).
//   pgid는 /tmp/.sbx/<id>.pid 에 남겨서 kill 모드가 group 전체에 신호를 보낼 수 있게 한다.
//   timeout_sec > 0 이면 sandboxd가 죽었을 때를 대비한 자체 시간 제한이다 (SIGTERM, 5초 뒤 SIGKILL).
//   종료 코드: 자식의 종료 코드, 신호로 죽었으면 128+신호.
// kill: pgid 파일을 읽어 group 전체에 신호를 보낸다.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define STATE_DIR "/tmp/.sbx"
#define IDLE_MS 100
#define KILL_GRACE_MS 5000

static int valid_id(const char *id) {
  size_t n = strlen(id);
  if (n == 0 || n > 64) return 0;
  for (size_t i = 0; i < n; i++) {
    char c = id[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return 0;
  }
  return 1;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

static int write_all(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t w = write(fd, buf, len);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    buf += w;
    len -= (size_t)w;
  }
  return 0;
}

static void pid_path(char *out, size_t n, const char *id) { snprintf(out, n, STATE_DIR "/%s.pid", id); }

static int parse_signal(const char *name) {
  if (strcmp(name, "TERM") == 0) return SIGTERM;
  if (strcmp(name, "KILL") == 0) return SIGKILL;
  return -1;
}

static int cmd_kill(const char *id, const char *signame) {
  int sig = parse_signal(signame);
  if (sig < 0) return 2;
  char path[128];
  pid_path(path, sizeof path, id);
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return 1;
  char buf[32];
  ssize_t r = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (r <= 0) return 1;
  buf[r] = 0;
  long pid = strtol(buf, NULL, 10);
  if (pid <= 1) return 1;
  if (kill(-(pid_t)pid, sig) < 0 && errno != ESRCH) return 1;
  return 0;
}

static int cmd_exec(const char *id, long timeout_sec, const char *cwd, char **argv) {
  if (chdir(cwd) < 0) {
    dprintf(STDERR_FILENO, "sbx-run: cannot change directory to %s: %s\n", cwd, strerror(errno));
    return 1;
  }
  int out[2], err[2];
  if (pipe2(out, O_CLOEXEC) < 0 || pipe2(err, O_CLOEXEC) < 0) {
    perror("sbx-run: pipe");
    return 125;
  }
  // 상태 디렉토리를 만들지 못해도 실행은 한다 (kill만 못 할 뿐)
  (void)mkdir(STATE_DIR, 0700);

  pid_t pid = fork();
  if (pid < 0) {
    perror("sbx-run: fork");
    return 125;
  }
  if (pid == 0) {
    setsid();
    signal(SIGPIPE, SIG_DFL);
    dup2(out[1], STDOUT_FILENO);
    dup2(err[1], STDERR_FILENO);
    execvp(argv[0], argv);
    int e = errno;
    dprintf(STDERR_FILENO, "sbx-run: %s: %s\n", argv[0], strerror(e));
    _exit(e == ENOENT ? 127 : 126);
  }
  close(out[1]);
  close(err[1]);

  char path[128];
  pid_path(path, sizeof path, id);
  int pfd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (pfd >= 0) {
    dprintf(pfd, "%d\n", (int)pid);
    close(pfd);
  }

  signal(SIGPIPE, SIG_IGN);
  int fds[2] = {out[0], err[0]};
  const int dst[2] = {STDOUT_FILENO, STDERR_FILENO};
  int discard[2] = {0, 0};
  int open_n = 2;
  int status = 0, exited = 0;
  long long exit_at = 0, last_data = 0;
  long long deadline = timeout_sec > 0 ? now_ms() + timeout_sec * 1000LL : 0;
  int term_sent = 0;
  long long kill_at = 0;
  static char buf[65536];

  for (;;) {
    if (!exited) {
      pid_t w = waitpid(pid, &status, WNOHANG);
      if (w == pid) {
        exited = 1;
        exit_at = now_ms();
      }
    }
    long long t = now_ms();
    if (exited) {
      if (open_n == 0) break;
      long long ref = last_data > exit_at ? last_data : exit_at;
      if (t - ref >= IDLE_MS) break;
    }
    if (deadline && !term_sent && t >= deadline) {
      kill(-pid, SIGTERM);
      term_sent = 1;
      kill_at = t + KILL_GRACE_MS;
    }
    if (kill_at && t >= kill_at) {
      kill(-pid, SIGKILL);
      kill_at = 0;
    }

    struct pollfd p[2];
    int idx[2];
    int n = 0;
    for (int i = 0; i < 2; i++) {
      if (fds[i] >= 0) {
        p[n].fd = fds[i];
        p[n].events = POLLIN;
        p[n].revents = 0;
        idx[n] = i;
        n++;
      }
    }
    int wait_ms = exited ? IDLE_MS / 4 : 50;
    if (n == 0) {
      // pipe는 다 닫혔는데 자식이 아직 안 끝났다 (stdout을 닫고 계속 도는 경우)
      struct timespec ts = {0, (long)wait_ms * 1000000L};
      nanosleep(&ts, NULL);
      continue;
    }
    int r = poll(p, (nfds_t)n, wait_ms);
    if (r < 0) {
      if (errno == EINTR) continue;
      break;
    }
    for (int k = 0; k < n; k++) {
      if (!(p[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      int i = idx[k];
      ssize_t got = read(fds[i], buf, sizeof buf);
      if (got > 0) {
        last_data = now_ms();
        if (!discard[i] && write_all(dst[i], buf, (size_t)got) < 0) discard[i] = 1;
      } else if (got == 0 || (errno != EINTR && errno != EAGAIN)) {
        close(fds[i]);
        fds[i] = -1;
        open_n--;
      }
    }
  }

  if (!exited) waitpid(pid, &status, 0);
  unlink(path);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}

static int usage(void) {
  dprintf(STDERR_FILENO,
          "usage: sbx-run exec <id> <timeout_sec> <cwd> -- <argv...>\n       sbx-run kill <id> <TERM|KILL>\n");
  return 2;
}

int main(int argc, char **argv) {
  if (argc >= 7 && strcmp(argv[1], "exec") == 0 && strcmp(argv[5], "--") == 0) {
    if (!valid_id(argv[2])) return usage();
    char *end = NULL;
    long timeout = strtol(argv[3], &end, 10);
    if (!end || *end != 0 || timeout < 0) return usage();
    return cmd_exec(argv[2], timeout, argv[4], &argv[6]);
  }
  if (argc == 4 && strcmp(argv[1], "kill") == 0) {
    if (!valid_id(argv[2])) return usage();
    return cmd_kill(argv[2], argv[3]);
  }
  return usage();
}
