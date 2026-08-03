import { ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DevtoolsError } from "../errors.ts";
import { getAccessToken, type AuthConfig } from "./oauth.ts";
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
