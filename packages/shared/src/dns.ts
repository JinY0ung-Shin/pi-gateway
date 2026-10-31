import type { LookupAddress } from "node:dns";
import { lookup as systemLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

/**
 * 연결할 때마다 이름을 새로 찾지 않게 한다.
 * Docker 내장 DNS는 dockerd가 답한다. sandbox를 한꺼번에 많이 만들면 dockerd가 바빠 조회가 몇 초씩 늦고,
 * libuv는 이름 조회를 스레드 두 개로만 돌리므로 새 연결이 줄을 서다 fetch의 10초 connect timeout에 걸린다
 * (세션 200개를 동시에 열면 broker·sandboxd 연결이 대부분 이렇게 실패했다).
 * 그래서 이름별로 결과를 기억하고, 같은 이름의 조회는 하나로 합치고, 오래된 값은 쓰면서 뒤에서 새로 찾는다.
 * 새로 찾다 실패하면 이전 값을 계속 쓴다.
 */
const FRESH_MS = 30_000;

type Resolve = (hostname: string) => Promise<LookupAddress[]>;

/** `net.connect`의 `lookup` 옵션으로 쓴다. */
export function createCachedLookup(
  resolve: Resolve = (hostname) => systemLookup(hostname, { all: true }),
  now: () => number = Date.now,
): LookupFunction {
  const cache = new Map<string, { addresses: LookupAddress[]; at: number }>();
  const inflight = new Map<string, Promise<LookupAddress[]>>();

  const refresh = (hostname: string): Promise<LookupAddress[]> => {
    let pending = inflight.get(hostname);
    if (!pending) {
      pending = resolve(hostname)
        .then((addresses) => {
          cache.set(hostname, { addresses, at: now() });
          return addresses;
        })
        .finally(() => inflight.delete(hostname));
      inflight.set(hostname, pending);
    }
    return pending;
  };

  return (hostname, options, callback) => {
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : Number(options.family ?? 0);
    const answer = (addresses: LookupAddress[]) => {
      const matching = family ? addresses.filter((a) => a.family === family) : addresses;
      if (matching.length === 0) {
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname }), options.all ? [] : "");
      } else if (options.all) {
        callback(null, matching);
      } else {
        callback(null, matching[0]!.address, matching[0]!.family);
      }
    };
    const cached = cache.get(hostname);
    if (cached) {
      if (now() - cached.at > FRESH_MS) refresh(hostname).catch(() => {});
      // net은 lookup 콜백이 비동기라고 가정한다.
      process.nextTick(answer, cached.addresses);
      return;
    }
    refresh(hostname).then(answer, (err: Error) => callback(err, options.all ? [] : ""));
  };
}
