import { doesNotThrow, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { apiBaseUrl, httpUrl, isLoopback, mcpServerName } from "./serverUrl.ts";
import { resolveHelpUrl } from "./tenantScope.ts";

/**
 * 서버가 준 값을 쓸지 정하는 판정의 계약.
 *
 * 이 축은 **한 곳에만 걸려 있다가 나머지가 맨몸으로 들어온** 자리다 — 매뉴얼 주소만 검사하고
 * `issuer`(브라우저를 열고 인가 코드를 POST 한다)·MCP 좌표(고객 에이전트의 접속처)·`serverName`
 * (고객 `.mcp.json` 의 **키**)은 그대로 썼다. 그래서 시험도 술어 하나가 아니라 **소비처 전부**를 든다.
 *
 * 두 방향을 같이 잰다. 좁히기만 재면 정상 주소를 막는 변이가 살아남고, 넓히기만 재면 그 반대다.
 */

/** `new URL` 이 순순히 파는 위험한 스킴들 — 이 시험이 무엇을 막는지 보이는 통제군이다. */
const DANGEROUS = ["javascript:alert(1)", "file:///etc/passwd", "vscode://ms-vscode.x/run", "data:text/html,x", "ftp://h/x"];

test("통제군 — `new URL` 은 이 스킴들을 정말 판다(위험이 실재한다)", () => {
    for (const raw of DANGEROUS) {
        doesNotThrow(() => new URL(raw), `${raw} 가 파싱 실패다 — 이 시험의 전제가 깨졌다`);
    }
});

test("httpUrl 은 http(s) 만 통과시킨다", () => {
    for (const raw of DANGEROUS) strictEqual(httpUrl(raw), null, raw);
    strictEqual(httpUrl("https://auth.zalkera.com/realms/z")?.protocol, "https:");
    strictEqual(httpUrl("http://127.0.0.1:8080")?.protocol, "http:");
});

test("httpUrl — 문자열이 아니거나 비었으면 null", () => {
    for (const raw of [undefined, null, 42, {}, [], "", "   "]) strictEqual(httpUrl(raw), null, JSON.stringify(raw));
});

test("httpUrl — 주소가 아닌 문자열은 null(상대경로를 절대 주소로 승격시키지 않는다)", () => {
    for (const raw of ["/realms/z", "auth.zalkera.com", "//auth.zalkera.com"]) strictEqual(httpUrl(raw), null, raw);
});

test("apiBaseUrl — https 는 통과한다", () => {
    strictEqual(apiBaseUrl("https://api.zalkera.com")?.toString(), "https://api.zalkera.com/");
});

test("apiBaseUrl — 평문은 **루프백만** 통과한다(그 경로엔 중간이 없다)", () => {
    for (const raw of ["http://127.0.0.1:8080", "http://localhost:3000", "http://[::1]:9000"]) {
        ok(apiBaseUrl(raw) !== null, raw);
    }
});

test("apiBaseUrl — 루프백을 **닮은** 호스트는 막는다", () => {
    for (const raw of [
        "http://api.zalkera.com",
        "http://127.0.0.1.evil.example",
        "http://localhost.evil.example",
        "http://127.0.0.1@evil.example",
        "http://evil.example/127.0.0.1",
    ]) {
        strictEqual(apiBaseUrl(raw), null, raw);
    }
});

test("isLoopback 은 호스트만 본다", () => {
    strictEqual(isLoopback(new URL("http://127.0.0.1/x")), true);
    strictEqual(isLoopback(new URL("http://127.0.0.1.evil.example/x")), false);
    strictEqual(isLoopback(new URL("https://evil.example/?h=127.0.0.1")), false);
});

test("mcpServerName — 우리 이름 형태만 통과한다", () => {
    for (const n of ["zalkera", "zalkera-site", "a", "a0-1", "constructor"]) strictEqual(mcpServerName(n), n, n);
});

test("통제군 — `__proto__` 는 **항목을 안 적고 성공을 보고한다**(막아야 하는 이유)", () => {
    // 이 형태가 왜 위험한지 먼저 잰다. 안 그러면 무엇을 막았는지 모르는 시험이 된다.
    const servers: Record<string, unknown> = { github: { type: "http" } };
    const entry = { type: "http", url: "https://x" };
    servers["__proto__"] = entry;
    strictEqual(Object.keys(servers).includes("__proto__"), false); // 파일에 안 실린다
    strictEqual(Object.getPrototypeOf(servers), entry); // 대신 프로토타입이 바뀐다
});

test("mcpServerName — 형태가 어긋난 이름을 막는다", () => {
    for (const n of [
        "__proto__", // 위 통제군이 잰 그 형태
        "a/b",
        "a b",
        "A",
        "server.name",
        "-lead",
        "",
        "가나다",
        "x".repeat(64),
        42,
        null,
        undefined,
        {},
    ]) {
        strictEqual(mcpServerName(n as unknown), null, JSON.stringify(n));
    }
});

test("mcpServerName — 경계 길이는 63자다", () => {
    strictEqual(mcpServerName("a".repeat(63)), "a".repeat(63));
    strictEqual(mcpServerName("a".repeat(64)), null);
});

test("resolveHelpUrl — 위험한 스킴은 기본값으로 물러난다(여기만 물러설 자리가 있다)", () => {
    for (const raw of DANGEROUS) {
        const r = resolveHelpUrl(raw, "https://help.example/");
        strictEqual(r.url, "https://help.example/", raw);
        ok(r.note, `${raw} — 조용히 물러났다. 운영자가 설정 오타를 영영 모른다`);
    }
});

test("resolveHelpUrl — 정상 주소는 그대로 쓴다", () => {
    strictEqual(resolveHelpUrl("https://docs.zalkera.com/a", "https://help.example/").url, "https://docs.zalkera.com/a");
});

test("resolveHelpUrl — 없으면 조용히 기본값(알림을 띄우지 않는다)", () => {
    const r = resolveHelpUrl(undefined, "https://help.example/");
    strictEqual(r.url, "https://help.example/");
    strictEqual(r.note, undefined);
});

/**
 * ─── 소비처가 판정을 **실제로 태우는가** ────────────────────────────────────────────────
 *
 * 술어만 재는 시험은 조용히 죽는다 — 호출부에서 그 줄을 지워도 초록이면 아무것도 안 지킨 것이다
 * (이 조직이 형제 레포에서 정확히 그렇게 당했다). 그래서 경계 함수의 **행동**을 잰다.
 */

/** 핸드셰이크 응답 하나를 흉내 낸다. */
function stubHandshake(data: Record<string, unknown>): typeof fetch {
    return (async () =>
        new Response(JSON.stringify({ status: 200, data }), {
            headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
}

const BASE = {
    verdict: "OK",
    message: null,
    minExtensionVersion: "0.1.0",
    recommendedExtensionVersion: "0.1.0",
    minClientVersion: "0.21.0",
    auth: { issuer: "https://auth.zalkera.com/realms/z", clientId: "devtools", scopes: ["openid"] },
    previewKeyTtlSeconds: 300,
};

test("핸드셰이크 — 정상 좌표는 그대로 통과한다(양성 통제)", async () => {
    const { fetchHandshake } = await import("./handshake.ts");
    const h = await fetchHandshake("https://api.zalkera.com", "0.1.0", stubHandshake(BASE));
    strictEqual(h.auth.issuer, "https://auth.zalkera.com/realms/z");
});

test("핸드셰이크 — 로그인 주소가 http(s) 가 아니면 **성립하지 않는다**", async () => {
    const { fetchHandshake } = await import("./handshake.ts");
    for (const issuer of DANGEROUS) {
        let threw = false;
        try {
            await fetchHandshake("https://api.zalkera.com", "0.1.0", stubHandshake({ ...BASE, auth: { ...BASE.auth, issuer } }));
        } catch {
            threw = true;
        }
        ok(threw, `${issuer} 를 로그인 주소로 받아들였다 — 브라우저가 그리로 열린다`);
    }
});

test("핸드셰이크 — MCP 좌표가 수상하면 그 기능만 내린다(로그인·발행은 살린다)", async () => {
    const { fetchHandshake } = await import("./handshake.ts");
    const mcp = {
        serverName: "zalkera",
        sourceUrlTemplate: "https://mcp.zalkera.com/{tenantCode}",
        clientId: "agent",
        authServerMetadataUrl: "vscode://evil/x",
    };
    const h = await fetchHandshake("https://api.zalkera.com", "0.1.0", stubHandshake({ ...BASE, mcp }));
    strictEqual(h.mcp, null, "위험한 좌표를 든 MCP 설정이 살아남았다");
    strictEqual(h.auth.issuer, BASE.auth.issuer, "MCP 때문에 로그인까지 죽었다 — 과잉차단이다");
});

test("핸드셰이크 — 정상 MCP 좌표는 살린다(과잉차단 아님을 보인다)", async () => {
    const { fetchHandshake } = await import("./handshake.ts");
    const mcp = {
        serverName: "zalkera",
        sourceUrlTemplate: "https://mcp.zalkera.com/{tenantCode}",
        clientId: "agent",
        authServerMetadataUrl: "https://auth.zalkera.com/.well-known/oauth-authorization-server",
    };
    const h = await fetchHandshake("https://api.zalkera.com", "0.1.0", stubHandshake({ ...BASE, mcp }));
    ok(h.mcp, "정상 좌표인데 MCP 를 내렸다");
});
