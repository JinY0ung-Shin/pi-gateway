// pi-gateway egress proxy — sandbox의 유일한 바깥 출구.
//
// Stripe Smokescreen(고정 버전)을 라이브러리로 쓰는 얇은 실행 파일이다.
//
//   - unix socket(/run/pi-proxy/proxy.sock)에서만 듣는다. TCP 포트는 열지 않는다.
//     sandbox 컨테이너는 network_mode none이고, 안의 sbx-proxy-bridge가 127.0.0.1:3128을 이 socket으로 잇는다.
//
//   - HTTP CONNECT(HTTPS 등)와 절대 URI의 일반 HTTP 요청을 받는다.
//
//   - 허용 목록(SANDBOX_EGRESS_ALLOW)에 있는 목적지만 연다. 나머지는 모두 거부한다.
//     항목은 도메인(정확히 일치), "*.도메인"(그 아래의 모든 하위 도메인) 또는 IP/CIDR이고,
//     ":PORT"를 붙이면 그 포트만 연다 (쉼표·공백 구분).
//     예: github.corp.com:443, *.corp.net:443, 10.1.2.3, 10.20.0.0/16:8080
//
//   - 목적지 이름은 프록시가 직접 해석하고, 해석된 IP로 연결한다 (DNS rebinding 방지).
//     loopback·link-local(169.254/16, metadata 포함)은 허용한 도메인이 그 주소로 해석돼도 거부한다.
//     이 대역과 겹치는 IP 항목이 있으면 시작하지 않는다.
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
	"net/http"
	"os"
	"regexp"
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

// allowEntry: SANDBOX_EGRESS_ALLOW의 한 항목. domain과 net 중 하나만 있다. port 0 = 모든 포트
// wildcard면 domain 자신이 아니라 그 아래의 하위 도메인에 맞는다 ("*.corp.net" → a.corp.net, a.b.corp.net).
type allowEntry struct {
	domain   string
	wildcard bool
	net      *net.IPNet
	port     int
}

func (e allowEntry) matchesDomain(host string) bool {
	if e.wildcard {
		return strings.HasSuffix(host, "."+e.domain)
	}
	return e.domain == host
}

var domainRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)

// parseEntry: "도메인", "IP", "CIDR", 각각 ":PORT"를 붙일 수 있다
func parseEntry(entry string) (allowEntry, error) {
	host, port := entry, 0
	if i := strings.LastIndex(entry, ":"); i > 0 && !strings.Contains(entry[:i], ":") {
		p, err := strconv.Atoi(entry[i+1:])
		if err != nil || p < 1 || p > 65535 {
			return allowEntry{}, fmt.Errorf("invalid port in %q", entry)
		}
		host, port = entry[:i], p
	}
	if ip := net.ParseIP(host); ip != nil || strings.Contains(host, "/") {
		if ip != nil {
			if ip.To4() != nil {
				host += "/32"
			} else {
				host += "/128"
			}
		}
		_, n, err := net.ParseCIDR(host)
		if err != nil {
			return allowEntry{}, fmt.Errorf("invalid CIDR in %q", entry)
		}
		for _, bad := range neverAllow {
			if overlaps(n, bad) {
				return allowEntry{}, fmt.Errorf("%q overlaps %s, which can never be allowed", entry, bad)
			}
		}
		return allowEntry{net: n, port: port}, nil
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	wildcard := strings.HasPrefix(host, "*.")
	if wildcard {
		host = host[2:]
		// "*.com"처럼 최상위 도메인 전체를 여는 항목은 받지 않는다.
		if !strings.Contains(host, ".") {
			return allowEntry{}, fmt.Errorf("wildcard in %q must cover at least two labels (e.g. *.corp.net)", entry)
		}
	}
	if !domainRe.MatchString(host) {
		return allowEntry{}, fmt.Errorf("invalid domain in %q (a wildcard is only allowed as a leading \"*.\")", entry)
	}
	return allowEntry{domain: host, wildcard: wildcard, port: port}, nil
}

func parseAllow() ([]allowEntry, error) {
	var out []allowEntry
	for _, entry := range splitList(os.Getenv("SANDBOX_EGRESS_ALLOW")) {
		e, err := parseEntry(entry)
		if err != nil {
			return nil, fmt.Errorf("SANDBOX_EGRESS_ALLOW: %w", err)
		}
		out = append(out, e)
	}
	return out, nil
}

// destPort: CONNECT는 Host에 포트가 있다. 일반 HTTP는 없으면 scheme의 기본 포트다
func destPort(req *http.Request) int {
	if _, p, err := net.SplitHostPort(req.Host); err == nil {
		if n, err := strconv.Atoi(p); err == nil {
			return n
		}
	}
	if req.URL != nil && req.URL.Scheme == "https" {
		return 443
	}
	return 80
}

// allowDecider: 허용 목록의 도메인·IP(와 포트)만 허용하고, 클라이언트가 고른 upstream 프록시는 거부한다.
type allowDecider struct{ entries []allowEntry }

func (d allowDecider) Decide(args acl.DecideArgs) (acl.Decision, error) {
	if args.ConnectProxyHost != "" {
		return acl.Decision{Result: acl.Deny, Reason: "client-selected upstream proxy is not allowed"}, nil
	}
	host := strings.TrimSuffix(strings.ToLower(args.Host), ".")
	ip := net.ParseIP(host)
	port := destPort(args.Req)
	for _, e := range d.entries {
		if e.port != 0 && e.port != port {
			continue
		}
		if (ip != nil && e.net != nil && e.net.Contains(ip)) || (ip == nil && e.domain != "" && e.matchesDomain(host)) {
			return acl.Decision{Result: acl.Allow, Reason: "in SANDBOX_EGRESS_ALLOW"}, nil
		}
	}
	return acl.Decision{Result: acl.Deny, Reason: "not in SANDBOX_EGRESS_ALLOW"}, nil
}

// sandbox가 mount하는 proxy-sock 볼륨 안의 socket
const socketPath = "/run/pi-proxy/proxy.sock"

func run() error {
	path := socketPath
	allow, err := parseAllow()
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
	// 목적지는 allowDecider가 정한다. 사내망 주소로 연결해야 하므로 사설 대역 차단은 끈다
	// (loopback·link-local은 그래도 거부된다). IP 항목은 CGNAT 등 기본 거부 대역이어도 연결되게 AllowRanges에도 넣는다.
	conf.UnsafeAllowPrivateRanges = true
	for _, e := range allow {
		if e.net != nil {
			conf.AllowRanges = append(conf.AllowRanges, smokescreen.RuleRange{Net: *e.net, Port: e.port})
		}
	}
	conf.EgressACL = allowDecider{allow}
	conf.AllowMissingRole = true
	conf.ConnectTimeout = 10 * time.Second
	conf.IdleTimeout = 10 * time.Minute
	conf.Network = "ip4"

	for _, e := range allow {
		dest := e.domain
		if e.net != nil {
			dest = e.net.String()
		}
		conf.Log.WithFields(log.Fields{"destination": dest, "port": e.port}).Info("egress allow")
	}
	if len(allow) == 0 {
		conf.Log.Warn("SANDBOX_EGRESS_ALLOW is empty; all egress is denied")
	}
	conf.Log.WithField("socket", path).Info("egress proxy listening")
	smokescreen.StartWithConfig(conf, nil)
	return nil
}

func healthcheck() int {
	c, err := net.DialTimeout("unix", socketPath, 2*time.Second)
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
