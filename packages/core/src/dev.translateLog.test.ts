/**
 * **키 거절 안내가 실제로 발화하는지 못 박는다.**
 *
 * 종전 조건은 `/401|403/ ∧ /storefront|zalkera/i` 였다. 그런데 `@zalkera/client` 가 키 거절에서
 * 내는 것은 HTTP 숫자가 아니라 **사람용 한국어 문면**이라(`STOREFRONT_KEY_MESSAGES`), 실측한 네
 * 형태가 전부 안 걸렸다 — **안내가 있는데 한 번도 뜨지 않는 상태**였다.
 *
 * 아래 문자열은 `@zalkera/client` 0.23.0 의 `ZalkeraError.fromBody(401|403, …)` 가 실제로 낸
 * `stack` 첫 줄이다. 재현:
 *
 *     node -e 'const {ZalkeraError}=require("@zalkera/client");
 *              console.log(ZalkeraError.fromBody(401,{errorCode:"STOREFRONT_KEY_REQUIRED"}).stack.split("\n")[0])'
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateLog } from "./dev.ts";

const KEY_DENIED = [
    // 401 STOREFRONT_KEY_REQUIRED
    "ZalkeraError: 스토어프론트 시크릿 키가 필요합니다. createZalkeraClient 의 secretKey 옵션을 설정하세요 (파트너 콘솔에서 발급 → 서버 .env 의 ZALKERA_STOREFRONT_KEY). 브라우저 번들에 넣지 마세요.",
    // 403 TENANT_MISMATCH
    "ZalkeraError: secretKey 가 tenant 옵션과 다른 테넌트의 키입니다. 두 값이 같은 테넌트인지 확인하세요.",
    // 남이 만든 숫자 형태(스토어프론트가 자기 문면으로 감쌀 때)
    "Error: Failed to fetch storefront config (401)",
    "  [zalkera] 403 Forbidden",
];

test("키 거절 문면이 안내로 번역된다", () => {
    for (const line of KEY_DENIED) {
        const out = translateLog(line);
        assert.notEqual(out, line, `번역되지 않았다: ${line.slice(0, 60)}`);
        assert.ok(out.includes("한 번에 하나"), "다른 기계에서 켜면 끊긴다는 사실을 말해야 한다");
        assert.ok(out.endsWith(line), "원문을 지우면 개발자가 볼 근거가 사라진다");
    }
});

test("양성 통제군 — 무관한 줄은 건드리지 않는다", () => {
    // 과번역은 결함이다. 평범한 dev 로그가 키 경고로 바뀌면 사람이 엉뚱한 곳을 본다.
    for (const line of [
        " ✓ Compiled /page in 240ms",
        "  - Local:        http://localhost:3000",
        "ZalkeraError: 상품을 찾을 수 없습니다.", // 우리 오류지만 키 축이 아니다
        "GET /api/products 200 in 12ms", // 숫자는 있지만 키 거절이 아니다
        "info  - Loaded env from .env.local",
        "warn  - 403 pages were prerendered", // `403` 이 있지만 zalkera 문맥이 아니다
    ]) {
        assert.equal(translateLog(line), line, `과번역: ${line}`);
    }
});

test("다른 번역들은 그대로 산다", () => {
    assert.match(translateLog("Error: listen EADDRINUSE :::3000"), /포트/);
    assert.match(translateLog("Error: Cannot find module 'next'"), /의존성/);
    assert.match(translateLog("Error: ENOSPC: no space left"), /디스크/);
    assert.match(translateLog("FetchError: ECONNREFUSED 127.0.0.1:8100"), /연결하지 못했습니다/);
});
