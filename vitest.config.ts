import { defineConfig } from "vitest/config";

// 워크스페이스 패키지를 dist가 아닌 src로 해석한다 (package.json의 "pi-gateway-source" 조건).
export default defineConfig({
  resolve: { conditions: ["pi-gateway-source"] },
  ssr: { resolve: { conditions: ["pi-gateway-source"], externalConditions: ["pi-gateway-source"] } },
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
