// sbx-proxy-bridge — 네트워크가 없는(network_mode none) sandbox 안에서 127.0.0.1:3128을
// egress 프록시의 unix socket(/run/pi-proxy/proxy.sock, 읽기 전용 mount)으로 잇는다.
// sandbox의 HTTP_PROXY/HTTPS_PROXY가 이 주소를 가리킨다. 컨테이너의 주 프로세스로 돌며,
// 연결마다 자식 프로세스 하나가 양방향으로 바이트를 넘긴다 (프로토콜은 해석하지 않는다).
//
//   sbx-proxy-bridge [port] [socket]     기본: 3128 /run/pi-proxy/proxy.sock

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

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

static void relay(int client, const char *path) {
  int up = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  if (up < 0 || strlen(path) >= sizeof addr.sun_path) return;
  strcpy(addr.sun_path, path);
  if (connect(up, (struct sockaddr *)&addr, sizeof addr) < 0) return;

  int fds[2] = {client, up};
  int open_read[2] = {1, 1};
  static char buf[65536];
  while (open_read[0] || open_read[1]) {
    struct pollfd p[2];
    int n = 0, idx[2];
    for (int i = 0; i < 2; i++) {
      if (!open_read[i]) continue;
      p[n].fd = fds[i];
      p[n].events = POLLIN;
      p[n].revents = 0;
      idx[n++] = i;
    }
    if (poll(p, (nfds_t)n, -1) < 0) {
      if (errno == EINTR) continue;
      return;
    }
    for (int k = 0; k < n; k++) {
      if (!(p[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      int i = idx[k];
      ssize_t got = read(fds[i], buf, sizeof buf);
      if (got > 0) {
        if (write_all(fds[1 - i], buf, (size_t)got) < 0) return;
      } else if (got == 0 || (errno != EINTR && errno != EAGAIN)) {
        // 한쪽이 끝나면 반대쪽에 쓰기 종료를 알린다 (응답은 계속 받는다)
        open_read[i] = 0;
        shutdown(fds[1 - i], SHUT_WR);
      }
    }
  }
}

int main(int argc, char **argv) {
  int port = argc > 1 ? atoi(argv[1]) : 3128;
  const char *path = argc > 2 ? argv[2] : "/run/pi-proxy/proxy.sock";
  if (port < 1 || port > 65535) {
    fprintf(stderr, "sbx-proxy-bridge: invalid port\n");
    return 2;
  }
  signal(SIGCHLD, SIG_IGN); // 자식은 자동으로 회수된다
  signal(SIGPIPE, SIG_IGN);

  int lfd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (lfd < 0) {
    perror("sbx-proxy-bridge: socket");
    return 1;
  }
  int one = 1;
  setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in sa;
  memset(&sa, 0, sizeof sa);
  sa.sin_family = AF_INET;
  sa.sin_port = htons((unsigned short)port);
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(lfd, (struct sockaddr *)&sa, sizeof sa) < 0 || listen(lfd, 128) < 0) {
    perror("sbx-proxy-bridge: bind/listen");
    return 1;
  }
  for (;;) {
    int c = accept4(lfd, NULL, NULL, SOCK_CLOEXEC);
    if (c < 0) {
      if (errno == EINTR || errno == ECONNABORTED) continue;
      if (errno == EMFILE || errno == ENFILE || errno == ENOMEM) {
        usleep(100000);
        continue;
      }
      perror("sbx-proxy-bridge: accept");
      return 1;
    }
    pid_t pid = fork();
    if (pid == 0) {
      close(lfd);
      relay(c, path);
      _exit(0);
    }
    close(c);
  }
}
