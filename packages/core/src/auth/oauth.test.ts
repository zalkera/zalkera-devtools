import { ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DevtoolsError } from "../errors.ts";
import { getAccessToken, login, type AuthConfig } from "./oauth.ts";
import { createPkce, createState } from "./pkce.ts";
import { MemoryTokenStore } from "./store.ts";

const config: AuthConfig = {
    issuer: "https://sso.example.com/realms/oneque",
    clientId: "zalkera-devtools",
    scopes: ["openid", "offline_access"],
};

test("PKCE 검증자는 매번 다르고 챌린지는 S256 이다", () => {
    const a = createPkce();
    const b = createPkce();
    ok(a.verifier !== b.verifier, "검증자 재사용 금지");
    strictEqual(a.method, "S256");
    ok(a.verifier.length >= 43 && a.verifier.length <= 128, `길이 규격(${a.verifier.length})`);
    ok(!/[^A-Za-z0-9\-._~]/.test(a.verifier), "URL-safe 문자만");
    ok(a.challenge !== a.verifier, "챌린지는 해시라 검증자와 달라야 한다(plain 금지)");
    ok(createState() !== createState(), "state 도 매번 다르다");
});

test("만료 전 토큰은 그대로 쓴다(불필요한 갱신 없음)", async () => {
    const store = new MemoryTokenStore();
    await store.write({
        accessToken: "live",
        refreshToken: "r",
        expiresAt: Date.now() + 10 * 60_000,
        issuer: config.issuer,
    });
    strictEqual(await getAccessToken(config, store), "live");
});

test("로그인 기록이 없으면 재로그인을 요구한다", async () => {
    await rejects(
        () => getAccessToken(config, new MemoryTokenStore()),
        (error: unknown) => error instanceof DevtoolsError && error.code === "NOT_AUTHENTICATED",
    );
});

test("서버(발급자)가 바뀌면 남은 토큰을 버리고 재로그인을 요구한다", async () => {
    const store = new MemoryTokenStore();
    await store.write({
        accessToken: "stale",
        refreshToken: "r",
        expiresAt: Date.now() + 10 * 60_000,
        issuer: "https://다른서버/realms/oneque",
    });

    await rejects(
        () => getAccessToken(config, store),
        (error: unknown) => error instanceof DevtoolsError && error.code === "NOT_AUTHENTICATED",
    );
    strictEqual(await store.read(), null, "다른 세계의 토큰은 남겨 두지 않는다");
});

test("갱신 실패는 보관소를 비우고 재로그인 요구로 환원한다", async () => {
    const store = new MemoryTokenStore();
    await store.write({ accessToken: "old", refreshToken: "dead", expiresAt: Date.now() - 1, issuer: config.issuer });

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
    try {
        await rejects(
            () => getAccessToken(config, store),
            (error: unknown) => error instanceof DevtoolsError && error.code === "NOT_AUTHENTICATED",
        );
    } finally {
        globalThis.fetch = original;
    }
    strictEqual(await store.read(), null, "죽은 토큰을 남기면 다음 시도도 같은 실패를 반복한다");
});

test("갱신 응답에 refresh 토큰이 없으면 성공으로 치지 않는다", async () => {
    const store = new MemoryTokenStore();
    await store.write({ accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 1, issuer: config.issuer });

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
        Response.json({ access_token: "new", expires_in: 120 })) as unknown as typeof fetch;
    try {
        // refresh 없이 진행하면 2분 뒤 "이유 없이 로그아웃"이 된다 — 그 조용한 실패를 여기서 끊는다.
        await rejects(
            () => getAccessToken(config, store),
            (error: unknown) => error instanceof DevtoolsError && error.code === "NOT_AUTHENTICATED",
        );
    } finally {
        globalThis.fetch = original;
    }
});

test("취소하면 타임아웃을 기다리지 않고 CANCELLED 로 끝난다", async () => {
    // 사람이 브라우저를 닫는 상황. 서버는 아무것도 보내지 않으므로 취소 신호가 없으면 기본 5분을
    // 매달린다 — 그 매달림이 실제 결함이었다(상태 표시줄의 진행 알림이 안 사라진다).
    const controller = new AbortController();
    const store = new MemoryTokenStore();
    const started = Date.now();

    await rejects(
        login(config, store, {
            openBrowser: async () => {
                controller.abort();
            },
            signal: controller.signal,
        }),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            strictEqual(error.code, "CANCELLED");
            return true;
        },
    );
    ok(Date.now() - started < 5_000, "타임아웃(5분)을 기다리면 안 된다");
});

test("이미 취소된 신호를 주면 브라우저를 열기도 전에 끝난다", async () => {
    const store = new MemoryTokenStore();
    let opened = false;
    await rejects(
        login(config, store, {
            openBrowser: async () => {
                opened = true;
            },
            signal: AbortSignal.abort(),
        }),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            strictEqual(error.code, "CANCELLED");
            return true;
        },
    );
    ok(!opened, "이미 취소됐으면 브라우저를 열지 않는다");
});

test("브라우저를 못 열면(호스트 확인창 거절) 기다리지 않고 끝난다", async () => {
    // VS Code 는 외부 주소를 열기 전에 확인창을 띄운다. 거기서 취소하면 브라우저가 열리지 않으므로
    // 콜백이 올 리 없다 — 그런데도 기다리면 진행 알림이 남아 사용자가 취소를 두 번 하게 된다.
    const store = new MemoryTokenStore();
    const started = Date.now();
    await rejects(
        login(config, store, {
            openBrowser: async () => {
                throw new DevtoolsError("CANCELLED", "로그인을 취소했습니다.");
            },
        }),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            strictEqual(error.code, "CANCELLED");
            return true;
        },
    );
    ok(Date.now() - started < 5_000, "타임아웃(5분)을 기다리면 안 된다");
});

/**
 * ─── 로그인 성공 경로와 state 대조 ─────────────────────────────────────────────
 *
 * 위 시험 아홉은 전부 **토큰 갱신·취소**다. 로그인 자체는 재지 않았고, `oauth.ts` 가 스스로
 * *"state 대조를 빼먹으면 남이 시작시킨 로그인의 코드를 내 것으로 착각해 삼킬 수 있다(CSRF)"*
 * 라고 적어 둔 축이 **시험 없이** 있었다 — 지워도 전 시험이 초록이었다.
 *
 * `login` 은 `fetch` 를 주입받지 않으므로 **이 기계의 루프백에 진짜 토큰 엔드포인트를 띄운다.**
 * 밖으로 나가는 요청은 없다.
 */

/** 127.0.0.1 에 토큰 엔드포인트 하나를 띄운다. 호출 수를 밖에서 본다. */
async function tokenServer(): Promise<{ issuer: string; calls: () => number; close: () => Promise<void> }> {
    const { createServer } = await import("node:http");
    let calls = 0;
    const server = createServer((req, res) => {
        if ((req.url ?? "").includes("/token")) {
            calls += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 300 }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return {
        issuer: `http://127.0.0.1:${port}`,
        calls: () => calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/** 수신기에 콜백을 던지는 가짜 브라우저. `state` 를 우리가 정한다. */
function browserThatReturns(state: (ours: string) => string, code = "CODE") {
    return async (url: string) => {
        const parsed = new URL(url);
        const ours = parsed.searchParams.get("state") ?? "";
        const redirect = new URL(parsed.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", state(ours));
        await fetch(redirect);
    };
}

test("로그인 — 우리가 시작한 응답이면 토큰을 받아 보관한다(양성 통제)", async () => {
    const store = new MemoryTokenStore();
    const server = await tokenServer();
    try {
        const tokens = await login({ ...config, issuer: server.issuer }, store, {
            openBrowser: browserThatReturns((ours) => ours),
            timeoutMs: 10_000,
        });
        strictEqual(tokens.accessToken, "AT");
        strictEqual(server.calls(), 1, "토큰 교환을 안 했다");
        strictEqual((await store.read())?.accessToken, "AT");
    } finally {
        await server.close();
    }
});

test("로그인 — **남이 시작시킨 응답은 삼키지 않는다**(state 대조)", async () => {
    const store = new MemoryTokenStore();
    const server = await tokenServer();
    try {
        await rejects(
            () =>
                login({ ...config, issuer: server.issuer }, store, {
                    openBrowser: browserThatReturns(() => "NOT-OURS", "ATTACKER_CODE"),
                    timeoutMs: 10_000,
                }),
            (error: unknown) => error instanceof DevtoolsError,
            "남의 state 를 받아들였다 — 공격자가 시작시킨 로그인의 코드를 삼킨다",
        );
        strictEqual(server.calls(), 0, "state 가 다른데 토큰 교환을 했다");
        strictEqual(await store.read(), null, "state 가 다른데 토큰을 보관했다");
    } finally {
        await server.close();
    }
});

test("수신기는 **127.0.0.1 에만** 바인딩한다 — 같은 망의 다른 기계가 인가 코드를 던질 수 없다", async () => {
    const { startLoopbackReceiver } = await import("./loopback.ts");
    const receiver = await startLoopbackReceiver({ timeoutMs: 2_000 });
    try {
        const url = new URL(receiver.redirectUri);
        strictEqual(url.hostname, "127.0.0.1", `수신기가 ${url.hostname} 에 떴다`);
    } finally {
        receiver.close();
        await receiver.waitForCode().catch(() => undefined);
    }
});

/**
 * ⚠ **경합이 아니라 결정론이었다.** 같은 틱에 시작한 인증 호출 둘은 **둘 다 낡은 토큰을 읽고
 *   둘 다 갱신**한다 — Keycloak 렘에 재사용 폐기가 켜져 있으면 둘째 교환이 실패하고, 이 함수는
 *   실패를 `store.clear()` + 재로그인 요구로 환원하므로 **이유 없는 강제 재로그인**이 된다.
 *   「버전 전환」이 이 레포 최초로 병렬 인증 호출을 세우면서 그 창이 열렸다(성능 심의 실측).
 */
async function withStubbedTokenEndpoint<T>(
    handler: () => Promise<Response>,
    run: () => Promise<T>,
): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => handler()) as unknown as typeof fetch;
    try {
        return await run();
    } finally {
        globalThis.fetch = real;
    }
}

const staleTokens = () => ({
    accessToken: "stale",
    refreshToken: "r",
    expiresAt: Date.now() - 1_000,
    issuer: config.issuer,
});

test("병렬 호출은 갱신을 한 번만 던진다 — 나눠 쓴다", async () => {
    const store = new MemoryTokenStore();
    await store.write(staleTokens());
    let exchanges = 0;
    const [a, b] = await withStubbedTokenEndpoint(
        async () => {
            exchanges += 1;
            // 첫 교환이 끝나기 전에 둘째가 들어올 틈을 준다 — 가드가 없으면 여기서 갈린다.
            await new Promise((r) => setTimeout(r, 5));
            return new Response(
                JSON.stringify({ access_token: "fresh", refresh_token: "r2", expires_in: 300 }),
                { status: 200, headers: { "content-type": "application/json" } },
            );
        },
        () => Promise.all([getAccessToken(config, store), getAccessToken(config, store)]),
    );
    strictEqual(a, "fresh");
    strictEqual(b, "fresh");
    strictEqual(exchanges, 1, `갱신이 ${exchanges}회 났다 — 재사용 폐기 렘에서 강제 재로그인이 된다`);
});

test("갱신이 실패해도 가드가 풀린다 — 한 번 실패한 창이 낡은 프라미스에 갇히지 않는다", async () => {
    const store = new MemoryTokenStore();
    let exchanges = 0;
    await withStubbedTokenEndpoint(
        async () => {
            exchanges += 1;
            return new Response("nope", { status: 400 });
        },
        async () => {
            await store.write(staleTokens());
            await rejects(() => getAccessToken(config, store));
            await store.write(staleTokens());
            await rejects(() => getAccessToken(config, store));
        },
    );
    strictEqual(exchanges, 2, "두 번째 시도가 가드에 갇혀 갱신을 안 던졌다");
});
