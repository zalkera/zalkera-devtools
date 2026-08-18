import { ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { ZalkeraApi } from "./api.ts";
import { DevtoolsError } from "./errors.ts";

function api(handler: (url: string, init: RequestInit) => Response): ZalkeraApi {
    return new ZalkeraApi({
        apiBase: "https://api.zalkera.com",
        accessToken: async () => "token-abc",
        tenantCode: () => "acme",
        fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
            handler(String(input), init ?? {})) as unknown as typeof fetch,
    });
}

test("파트너 호출은 Bearer 와 X-Tenant 를 함께 싣는다", async () => {
    let seen: RequestInit = {};
    let seenUrl = "";
    const client = api((url, init) => {
        seenUrl = url;
        seen = init;
        return Response.json({ status: 201, data: { id: 1, key: "oqsk_x", revokedPrevious: 0 } });
    });

    await client.issuePreviewKey("노트북");

    strictEqual(seenUrl, "https://api.zalkera.com/api/partner/storefront-keys/preview");
    const headers = seen.headers as Record<string, string>;
    strictEqual(headers["authorization"], "Bearer token-abc");
    strictEqual(headers["x-tenant"], "acme");
    strictEqual(seen.body, JSON.stringify({ label: "노트북" }));
});

test("/api/me 는 테넌트 헤더를 요구하지 않는다(닭과 달걀)", async () => {
    let headers: Record<string, string> = {};
    const client = api((_url, init) => {
        headers = init.headers as Record<string, string>;
        return Response.json({ status: 200, data: { tenants: [{ code: "acme", name: "에이크미" }] } });
    });

    const tenants = await client.listMyTenants();

    strictEqual(tenants[0]?.code, "acme");
    ok(!("x-tenant" in headers), "테넌트를 고르기 전에 부르는 경로다");
});

test("401 은 재로그인, 403 은 권한 안내로 옮긴다", async () => {
    await rejects(
        () => api(() => new Response("{}", { status: 401 })).listRevisions(),
        (error: unknown) => error instanceof DevtoolsError && error.code === "NOT_AUTHENTICATED",
    );

    await rejects(
        () => api(() => Response.json({ message: "권한이 없습니다." }, { status: 403 })).issuePreviewKey(),
        (error: unknown) =>
            error instanceof DevtoolsError &&
            error.code === "FORBIDDEN" &&
            // 순수 STAFF 계정이 프리뷰 키를 못 받는 것이 이 403 의 진짜 원인이다 — 그 사실을 사람에게 말한다.
            (error.hint ?? "").includes("관리자 권한"),
    );
});

test("연결 자체가 실패하면 프록시·주소를 짚어 준다", async () => {
    const client = new ZalkeraApi({
        apiBase: "https://api.zalkera.com",
        accessToken: async () => "t",
        tenantCode: () => "acme",
        fetchImpl: (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch,
    });

    await rejects(
        () => client.listRevisions(),
        (error: unknown) =>
            error instanceof DevtoolsError &&
            error.code === "SERVER_UNREACHABLE" &&
            (error.hint ?? "").includes("프록시"),
    );
});

test("경로가 있는 베이스 주소도 잘리지 않는다", async () => {
    let seenUrl = "";
    const client = new ZalkeraApi({
        apiBase: "https://gateway.example.com/zalkera",
        accessToken: async () => "t",
        tenantCode: () => "acme",
        fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
            seenUrl = String(input);
            return Response.json({ status: 200, data: [] });
        }) as unknown as typeof fetch,
    });

    await client.listRevisions();
    ok(seenUrl.startsWith("https://gateway.example.com/"), `베이스 보존 실패: ${seenUrl}`);
});

// ── 응답 파싱 ────────────────────────────────────────────────────────────────
// 200 이어도 본문이 우리 형식이라는 보장이 없다. 캡티브 포털·사내망 프록시는 HTML 을 준다.
// 종전에는 raw `SyntaxError`/`TypeError` 가 고객 대화상자로 그대로 나갔다.

test("200 이지만 JSON 이 아니면 — 사람 말로 끊는다", async () => {
    const client = api(() => new Response("<html>로그인이 필요합니다</html>", {status: 200}));
    await rejects(
        () => client.listRevisions(),
        (error: unknown) => {
            ok(error instanceof DevtoolsError, "DevtoolsError 가 아니면 raw SyntaxError 가 나간 것이다");
            strictEqual(error.code, "SERVER_UNREACHABLE");
            ok(!/SyntaxError|JSON/i.test(error.humanMessage), "파서 용어가 사용자에게 나갔다");
            return true;
        },
    );
});

test("200 이고 JSON 이지만 data 가 없으면 — 여기서 끊는다", async () => {
    // 통과시키면 `undefined` 가 호출부까지 흘러가 원인에서 먼 곳에서 raw TypeError 가 된다.
    const client = api(() => Response.json({status: 200}));
    await rejects(
        () => client.listRevisions(),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            strictEqual(error.code, "SERVER_UNREACHABLE");
            return true;
        },
    );
});

test("본문이 JSON null 이어도 끊는다", async () => {
    const client = api(() => new Response("null", {status: 200, headers: {"content-type": "application/json"}}));
    await rejects(
        () => client.listRevisions(),
        (error: unknown) => error instanceof DevtoolsError && error.code === "SERVER_UNREACHABLE",
    );
});

test("양성 통제군 — 정상 봉투는 그대로 통과한다", async () => {
    // 위 셋은 "언제나 던지는" 파서로도 통과한다. 정상 응답이 살아 있는 것을 따로 못 박는다.
    const client = api(() => Response.json({status: 200, data: []}));
    const revisions = await client.listRevisions();
    ok(Array.isArray(revisions));
});

test("오류 응답의 errorCode 도 소독을 지난다", async () => {
    // `message` 만 막고 `errorCode` 를 열어 두면 같은 서버가 같은 알림으로 링크를 밀어 넣는다.
    const evil = "X](command:workbench.action.terminal.new)";
    const client = api(() => Response.json({message: "거절", errorCode: evil}, {status: 400}));
    await rejects(
        () => client.listRevisions(),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            ok(!/\]\(command:/.test(error.humanMessage), "errorCode 가 링크로 살아 있다");
            return true;
        },
    );
});
