import { BlockList, isIPv4, isIPv6 } from "node:net";
import { parseCidr } from "../config.js";

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * 관리 화면 접근 허용 목록. CIDR 목록이 비어 있으면 null(제한 없음)을 돌려준다.
 * IPv4-mapped IPv6 주소(`::ffff:10.1.2.3`)는 IPv4로 바꿔서 검사한다.
 */
export function createIpAllowlist(cidrs: readonly string[]): ((ip: string) => boolean) | null {
  if (cidrs.length === 0) return null;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (!parsed) throw new Error(`invalid CIDR '${cidr}'`);
    list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return (ip: string) => {
    const address = MAPPED_V4.exec(ip)?.[1] ?? ip;
    if (isIPv4(address)) return list.check(address, "ipv4");
    if (isIPv6(address)) return list.check(address, "ipv6");
    return false;
  };
}
