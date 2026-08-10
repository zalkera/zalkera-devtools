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
