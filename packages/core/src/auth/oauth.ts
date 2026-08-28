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
    /**
     * 로그인이 없거나 만료됐을 때 **어떻게** 하는가. 안 주면 방법을 말하지 않는다.
     *
     * 🔴 **문마다 다르다.** 확장 안에서는 누를 단추가 있어 「다시 로그인해 주세요」로 참이지만,
     *    터미널 도구·MCP 서버에서는 그 문장이 **나갈 길이 없는 막다른 길**이다 — 모델이 그것을
     *    사장님께 그대로 옮긴다(심의 실측). 형제 `fetchHandshake` 의 `upgradeHow` 와 같은 자리다.
     */
    loginHow?: string;
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
 * **갱신은 한 번에 하나만 난다.** 진행 중인 갱신이 있으면 그것을 나눠 쓴다.
 *
 * ⚠ **없으면 병렬 호출이 refresh 를 확정적으로 두 번 던진다** — 경합이 아니라 결정론이다:
 *   같은 틱에 시작한 둘이 **둘 다 낡은 토큰을 읽고 둘 다 갱신한다**(실측: 왕복 2회·보관소 쓰기 2회).
 *   Keycloak 렘에 **재사용 폐기**가 켜져 있으면 둘째 교환이 실패하고, 이 함수는 실패를
 *   `store.clear()` + 재로그인 요구로 환원하므로 **이유 없는 강제 재로그인**이 된다.
 *   창은 좁지 않다 — `REFRESH_SKEW_MS`(20초) 안이면 열려 있고, 편집기를 켜 둔 채 명령을
 *   누르는 흔한 상황이 곧 그 창이다.
 *
 * ⚠ **키는 보관소다.** 창마다 확장 호스트가 따로이므로 이 가드는 **프로세스 안**에서만 산다 —
 *   창을 둘 열면 여전히 둘이 갱신할 수 있다. 그것까지 막으려면 보관소 잠금이 필요하고 별건이다.
 */
const refreshing = new WeakMap<TokenStore, Promise<string>>();

/**
 * **로그아웃 세대.** 로그아웃이 이 값을 올리고, 진행 중인 갱신은 **쓰기 직전에** 자기가 시작할 때
 * 본 값과 견준다.
 *
 * ⚠ **없으면 로그아웃이 되살아난다.** 갱신은 read → 교환 → **write** 인데, 그 사이에 로그아웃의
 *   `clear()` 가 끼면 **write 가 로그아웃을 되돌린다** — 보관소에 토큰이 남고, 화면은 로그아웃인데
 *   다음 명령이 조용히 인증된다. 도달 가능하다: 미리보기 자격증명 갱신 타이머가 배경에서 갱신을
 *   돌리므로, 사람이 로그아웃을 누르는 순간과 겹칠 수 있다(보안 심의).
 *
 * ⚠ **다시 읽어 견주는 것으로는 안 닫힌다.** 읽기와 쓰기 사이가 또 창이다. 세대는 그 창이 없다 —
 *   비교와 쓰기 사이에 `await` 이 없다.
 *
 * ⚠ **프로세스 안에서만 산다.** 창마다 확장 호스트가 따로이므로 다른 창의 로그아웃은 못 본다 —
 *   그쪽은 보관소 잠금이 필요하고 별건이다(형제 [refreshing] 과 같은 한계).
 */
const logoutEpoch = new WeakMap<TokenStore, number>();

const epochOf = (store: TokenStore): number => logoutEpoch.get(store) ?? 0;

/**
 * 쓸 수 있는 access 토큰을 돌려준다. 만료가 가까우면 refresh 로 갱신하고 보관소를 갱신한다.
 *
 * **refresh 실패는 재로그인 요구로 환원한다** — 만료·폐기·발급자 변경을 구분해 봐야 사람이 할 일은
 * 하나(다시 로그인)라서다.
 */
export async function getAccessToken(config: AuthConfig, store: TokenStore): Promise<string> {
    const inFlight = refreshing.get(store);
    if (inFlight) return inFlight;
    const run = refreshToken(config, store);
    refreshing.set(store, run);
    try {
        return await run;
    } finally {
        // **반드시 푼다.** 성공 경로에서만 풀면 한 번 실패한 창이 영영 낡은 프라미스를 나눠 준다.
        refreshing.delete(store);
    }
}

async function refreshToken(config: AuthConfig, store: TokenStore): Promise<string> {
    // **시작 시점의 세대를 붙든다** — 쓰기 직전에 이 값과 견준다.
    const epoch = epochOf(store);
    const current = await store.read();
    if (!current) {
        throw new DevtoolsError("NOT_AUTHENTICATED", "로그인이 필요합니다.", config.loginHow ?? "먼저 잘커라에 로그인해 주세요.");
    }
    if (current.issuer !== config.issuer) {
        // 서버(발급자)가 바뀌었으면 남은 토큰은 다른 세계의 것이다. 조용히 쓰면 401 을 이유 없이 만난다.
        await store.clear();
        throw new DevtoolsError("NOT_AUTHENTICATED", "서버가 바뀌어 다시 로그인해야 합니다.", config.loginHow);
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
            config.loginHow ?? "다시 로그인해 주세요.",
            cause,
        );
    }
    // ⚠ **교환하는 사이에 로그아웃이 났으면 쓰지 않는다.** 쓰면 로그아웃이 되살아난다.
    //    견주기와 쓰기 사이에 `await` 이 없어야 한다 — 있으면 그 자리가 다시 창이다.
    if (epochOf(store) !== epoch) {
        throw new DevtoolsError(
            "NOT_AUTHENTICATED",
            "로그아웃되었습니다.",
            "다시 로그인해 주세요.",
        );
    }
    await store.write(refreshed);
    return refreshed.accessToken;
}

/**
 * 로그아웃 — 보관소를 비운다. 서버 세션 종료(백채널)는 확장이 별도로 부른다.
 *
 * ⚠ **세대를 먼저 올린다.** 그래야 진행 중인 갱신의 쓰기가 무효가 된다(아래 [logoutEpoch]).
 *   비우기보다 **앞**이어야 한다 — 뒤에 올리면 그 사이에 끝난 갱신이 여전히 되살린다.
 */
export async function logout(store: TokenStore): Promise<void> {
    logoutEpoch.set(store, epochOf(store) + 1);
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
