import { httpUrl } from "../serverUrl.ts";
import { DevtoolsError } from "../errors.ts";
import { startLoopbackReceiver } from "./loopback.ts";
import { createPkce, createState } from "./pkce.ts";
import type { StoredTokens, TokenStore } from "./store.ts";

/** 로그인에 필요한 좌표. **핸드셰이크가 준 값을 그대로 쓴다**(하드코딩 금지 — 이 레포는 공개다). */
export interface AuthConfig {
    issuer: string;
    clientId: string;
    scopes: string[];
}

export interface LoginOptions {
    /**
     * 브라우저를 여는 방법. 확장은 `vscode.env.openExternal`, CLI 는 OS 열기 명령을 꽂는다.
     *
     * ⚠ **열지 못했으면 `CANCELLED` 로 던져라.** 호스트가 "외부 사이트를 여시겠습니까?" 같은 확인을
     * 띄우고 사용자가 거절할 수 있다(VS Code 는 그때 `openExternal` 이 `false` 를 준다).
     * 조용히 넘어가면 **브라우저는 열리지도 않았는데** 여기서 콜백을 기다려 매달린다.
     */
    openBrowser(url: string): Promise<void>;
    /** 사람이 로그인하는 시간. 기본 5분. */
    timeoutMs?: number;
    /**
     * 취소 신호. 사람이 그만두면 수신기를 닫고 `CANCELLED` 로 끝난다.
     * 없으면 타임아웃까지 매달리므로 **UI 는 반드시 넘긴다**.
     */
    signal?: AbortSignal;
}

/** access 토큰을 이만큼 남기고 미리 갱신한다 — 서버와의 시계 오차·왕복 지연을 흡수한다. */
const REFRESH_SKEW_MS = 20_000;

/**
 * 인가 코드 흐름(PKCE + 루프백)으로 로그인한다.
 *
 * 순서: 수신기 기동 → 브라우저 열기 → 코드 수신 → **state 대조** → 토큰 교환 → 보관.
 * state 대조를 빼먹으면 남이 시작시킨 로그인의 코드를 내 것으로 착각해 삼킬 수 있다(CSRF).
 */
export async function login(config: AuthConfig, store: TokenStore, options: LoginOptions): Promise<StoredTokens> {
    const pkce = createPkce();
    const state = createState();
    const receiver = await startLoopbackReceiver({
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    try {
        // ⚠ **`issuer` 는 서버가 준 값이다.** `new URL` 은 `javascript:`·`vscode:`·`file:` 도 순순히
        //   파고, 그 결과가 곧 브라우저(또는 URI 핸들러)로 열린다. 판정이 안 서면 **연다는 선택 자체를
        //   하지 않는다** — 매뉴얼 주소와 달리 물러설 기본값이 없다.
        const issuer = httpUrl(trimSlash(config.issuer));
        if (!issuer) {
            throw new DevtoolsError(
                "SERVER_REJECTED",
                "서버가 보낸 로그인 주소를 쓸 수 없습니다.",
                "브라우저를 열지 않았습니다. 잘커라에 문의해 주세요.",
            );
        }
        const authorizeUrl = new URL(`${trimSlash(issuer.toString())}/protocol/openid-connect/auth`);
        authorizeUrl.searchParams.set("client_id", config.clientId);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("redirect_uri", receiver.redirectUri);
        authorizeUrl.searchParams.set("scope", config.scopes.join(" "));
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
        authorizeUrl.searchParams.set("code_challenge_method", pkce.method);

        // **열기 직전에 한 번 더 본다.** 수신기는 이미 취소를 알지만, 여는 것은 부수효과라
        // 취소된 뒤에 창이 튀어나오면 사람이 혼란스럽다(테스트가 잡은 자리).
        if (options.signal?.aborted) throw new DevtoolsError("CANCELLED", "로그인을 취소했습니다.");
        await options.openBrowser(authorizeUrl.toString());
        const result = await receiver.waitForCode();
        if (result.state !== state) {
            throw new DevtoolsError(
                "NOT_AUTHENTICATED",
                "로그인 응답이 이 요청의 것이 아닙니다.",
                "브라우저 창을 모두 닫고 다시 로그인해 주세요.",
            );
        }

        const tokens = await exchange(config, {
            grant_type: "authorization_code",
            code: result.code,
            redirect_uri: receiver.redirectUri,
            code_verifier: pkce.verifier,
        });
        await store.write(tokens);
        return tokens;
    } finally {
        receiver.close();
    }
}

/**
 * 쓸 수 있는 access 토큰을 돌려준다. 만료가 가까우면 refresh 로 갱신하고 보관소를 갱신한다.
 *
 * **refresh 실패는 재로그인 요구로 환원한다** — 만료·폐기·발급자 변경을 구분해 봐야 사람이 할 일은
 * 하나(다시 로그인)라서다.
 */
export async function getAccessToken(config: AuthConfig, store: TokenStore): Promise<string> {
    const current = await store.read();
    if (!current) {
        throw new DevtoolsError("NOT_AUTHENTICATED", "로그인이 필요합니다.", "먼저 잘커라에 로그인해 주세요.");
    }
    if (current.issuer !== config.issuer) {
        // 서버(발급자)가 바뀌었으면 남은 토큰은 다른 세계의 것이다. 조용히 쓰면 401 을 이유 없이 만난다.
        await store.clear();
        throw new DevtoolsError("NOT_AUTHENTICATED", "서버가 바뀌어 다시 로그인해야 합니다.");
    }
    if (current.expiresAt - REFRESH_SKEW_MS > Date.now()) return current.accessToken;

    let refreshed: StoredTokens;
    try {
        refreshed = await exchange(config, { grant_type: "refresh_token", refresh_token: current.refreshToken });
    } catch (cause) {
        await store.clear();
        throw new DevtoolsError(
            "NOT_AUTHENTICATED",
            "로그인이 만료되었습니다.",
            "다시 로그인해 주세요.",
            cause,
        );
    }
    await store.write(refreshed);
    return refreshed.accessToken;
}

/** 로그아웃 — 보관소를 비운다. 서버 세션 종료(백채널)는 확장이 별도로 부른다. */
export async function logout(store: TokenStore): Promise<void> {
    await store.clear();
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
}

async function exchange(config: AuthConfig, params: Record<string, string>): Promise<StoredTokens> {
    const body = new URLSearchParams({ client_id: config.clientId, ...params });
    const response = await fetch(`${trimSlash(config.issuer)}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
    });
    if (!response.ok) {
        const detail = await safeText(response);
        throw new DevtoolsError("NOT_AUTHENTICATED", "토큰 발급에 실패했습니다.", detail || undefined);
    }
    const token = (await response.json()) as TokenResponse;
    if (!token.refresh_token) {
        // refresh 가 없으면 2분짜리 세션이 된다 — 조용히 진행하면 곧 "이유 없이 로그아웃됨"으로 보인다.
        throw new DevtoolsError(
            "NOT_AUTHENTICATED",
            "서버가 갱신 토큰을 주지 않았습니다.",
            "잘커라에 문의해 주세요(확장 클라이언트 설정 문제일 수 있습니다).",
        );
    }
    return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        issuer: config.issuer,
    };
}

async function safeText(response: Response): Promise<string> {
    try {
        return (await response.text()).slice(0, 200);
    } catch {
        return "";
    }
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/, "");
}
