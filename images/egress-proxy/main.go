// pi-gateway egress proxy — sandbox의 유일한 바깥 출구.
//
// Stripe Smokescreen(고정 버전)을 라이브러리로 쓰는 얇은 실행 파일이다.
//
//   - unix socket(PROXY_SOCKET, 기본 /run/pi-proxy/proxy.sock)에서만 듣는다. TCP 포트는 열지 않는다.
//     sandbox 컨테이너는 network_mode none이고, 안의 sbx-proxy-bridge가 127.0.0.1:3128을 이 socket으로 잇는다.
//
//   - HTTP CONNECT(HTTPS 등)와 절대 URI의 일반 HTTP 요청을 받는다.
//
//   - 목적지 이름은 프록시가 직접 해석하고, 해석된 IP를 검사한 뒤 그 IP로 연결한다 (DNS rebinding 방지).
//
//   - 거부: loopback, link-local(169.254/16, metadata 포함), 사설 대역, CGNAT, 자기 자신, IPv6에 IPv4를 넣은 주소,
//     SANDBOX_PROXY_DENY(쉼표 구분 CIDR, 예: 호스트의 공인 주소).
//
//   - 허용 예외: SANDBOX_EGRESS_ALLOW(공백 또는 쉼표 구분 CIDR[:PORT]). loopback·link-local과 겹치면 시작하지 않는다.
//
//   - 클라이언트가 X-Upstream-Https-Proxy로 다음 단계 프록시를 지정하는 기능은 막는다 (IP 검사 우회 경로).
//
//   - 모든 요청을 JSON 한 줄로 기록한다 (목적지, 허용 여부, 이유).
//
//     egress-proxy              프록시 실행
//     egress-proxy healthcheck  socket에 연결해 보고 종료 코드로 알린다 (Docker HEALTHCHECK용)
package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	log "github.com/sirupsen/logrus"
	"github.com/stripe/smokescreen/pkg/smokescreen"
	acl "github.com/stripe/smokescreen/pkg/smokescreen/acl/v1"
)

// 허용 목록으로도 열 수 없는 대역
var neverAllow = mustParseNets("127.0.0.0/8", "169.254.0.0/16", "0.0.0.0/8", "::1/128", "fe80::/10")

func mustParseNets(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(err)
		}
		out = append(out, n)
	}
	return out
}

func overlaps(a, b *net.IPNet) bool {
	return a.Contains(b.IP) || b.Contains(a.IP)
}

func splitList(raw string) []string {
	return strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' })
}

// parseRange: "CIDR", "IP", "CIDR:PORT", "IP:PORT"
func parseRange(entry string) (smokescreen.RuleRange, error) {
	host, port := entry, 0
	if i := strings.LastIndex(entry, ":"); i > 0 && !strings.Contains(entry[:i], ":") {
		p, err := strconv.Atoi(entry[i+1:])
		if err != nil || p < 1 || p > 65535 {
			return smokescreen.RuleRange{}, fmt.Errorf("invalid port in %q", entry)
		}
		host, port = entry[:i], p
	}
	if !strings.Contains(host, "/") {
		if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
			host += "/32"
		} else {
			host += "/128"
		}
	}
	_, n, err := net.ParseCIDR(host)
	if err != nil {
		return smokescreen.RuleRange{}, fmt.Errorf("invalid CIDR in %q", entry)
	}
	return smokescreen.RuleRange{Net: *n, Port: port}, nil
}

func parseRanges(name string, allow bool) ([]smokescreen.RuleRange, error) {
	var out []smokescreen.RuleRange
	for _, entry := range splitList(os.Getenv(name)) {
		r, err := parseRange(entry)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if allow {
			for _, bad := range neverAllow {
				if overlaps(&r.Net, bad) {
					return nil, fmt.Errorf("%s: %q overlaps %s, which can never be allowed", name, entry, bad)
				}
			}
		}
		out = append(out, r)
	}
	return out, nil
}

// openDecider: 목적지 이름은 모두 허용하고(IP 규칙이 그 뒤에 적용된다), 클라이언트가 고른 upstream 프록시는 거부한다.
type openDecider struct{}

func (openDecider) Decide(args acl.DecideArgs) (acl.Decision, error) {
	if args.ConnectProxyHost != "" {
		return acl.Decision{Result: acl.Deny, Reason: "client-selected upstream proxy is not allowed"}, nil
	}
	return acl.Decision{Result: acl.Allow, Reason: "open egress; IP rules apply"}, nil
}

func socketPath() string {
	if p := os.Getenv("PROXY_SOCKET"); p != "" {
		return p
	}
	return "/run/pi-proxy/proxy.sock"
}

func run() error {
	path := socketPath()
	allow, err := parseRanges("SANDBOX_EGRESS_ALLOW", true)
	if err != nil {
		return err
	}
	deny, err := parseRanges("SANDBOX_PROXY_DENY", false)
	if err != nil {
		return err
	}

	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("listen %s: %w", path, err)
	}
	// sandbox(uid 1000)가 연결할 수 있어야 한다. 이 socket은 sandbox와 프록시만 mount한다.
	if err := os.Chmod(path, 0o666); err != nil {
		return fmt.Errorf("chmod socket: %w", err)
	}

	conf := smokescreen.NewConfig()
	conf.Log.SetFormatter(&log.JSONFormatter{TimestampFormat: time.RFC3339Nano})
	conf.Log.SetOutput(os.Stdout)
	conf.Listener = ln
	conf.AllowRanges = allow
	conf.DenyRanges = deny
	conf.EgressACL = openDecider{}
	conf.AllowMissingRole = true
	conf.ConnectTimeout = 10 * time.Second
	conf.IdleTimeout = 10 * time.Minute
	conf.Network = "ip4"

	for _, r := range allow {
		conf.Log.WithFields(log.Fields{"cidr": r.Net.String(), "port": r.Port}).Info("egress allow range")
	}
	for _, r := range deny {
		conf.Log.WithFields(log.Fields{"cidr": r.Net.String(), "port": r.Port}).Info("egress deny range")
	}
	conf.Log.WithField("socket", path).Info("egress proxy listening")
	smokescreen.StartWithConfig(conf, nil)
	return nil
}

func healthcheck() int {
	c, err := net.DialTimeout("unix", socketPath(), 2*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, "unhealthy:", err)
		return 1
	}
	_ = c.Close()
	return 0
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "egress-proxy:", err)
		os.Exit(1)
	}
}
