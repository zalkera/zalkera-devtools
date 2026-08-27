/**
 * **CLI 가 「어느 서버·어느 사이트·누구로」를 정하는 자리.**
 *
 * ■ 좌표를 코드에 안 박는다
 *
 * 인증 좌표(`issuer`·`clientId`·`scopes`)는 **핸드셰이크가 준다.** 이 레포는 공개라 박아 두면
 * 좌표를 옮기는 날 이미 깔린 도구가 전부 죽는다 — 확장이 같은 이유로 같은 선택을 했다.
 *
 * ■ 소속은 **폴더가 안다**
 *
 * 사이트 코드는 ⑴ `--site`, ⑵ 폴더의 표식(`.zalkera/source.json`), ⑶ 장부(`sync.json`) 순으로
 * 찾는다. 셋 다 없으면 **묻지 않고 멈춘다** — 아무 사이트나 골라 주면 남의 사이트에 올린다.
 */
import {readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join, resolve} from "node:path";
import {
    DevtoolsError,
    SYNC_LEDGER_PATH,
    SOURCE_MARK_PATH,
    TENANT_CODE,
    ZalkeraApi,
    apiBaseUrl,
    fetchHandshake,
    getAccessToken,
    parseSourceMark,
    parseSyncLedger,
    type AuthConfig,
    type TokenStore,
} from "@zalkera/devtools-core";
import {FileTokenStore} from "./tokenStore.ts";

/** 기본 서버. `ZALKERA_SERVER` 로 덮는다(개발·자체 호스팅). */
export const DEFAULT_SERVER = "https://api.zalkera.com";

export interface Context {
    api: ZalkeraApi;
    auth: AuthConfig;
    store: TokenStore;
    folder: string;
    tenant: string;
    serverUrl: string;
}

export interface ContextOptions {
    folder?: string;
    tenant?: string;
    env?: NodeJS.ProcessEnv;
    store?: TokenStore;
}

/** 서버 주소를 정한다. **http(s) 만** 받는다 — 주소 검사는 코어의 것을 쓴다. */
export function serverUrlOf(env: NodeJS.ProcessEnv = process.env): string {
    const raw = env.ZALKERA_SERVER ?? DEFAULT_SERVER;
    const url = apiBaseUrl(raw);
    if (!url) {
        throw new DevtoolsError(
            "SERVER_UNREACHABLE",
            `서버 주소가 올바르지 않습니다: ${raw}`,
            "`ZALKERA_SERVER` 를 확인해 주세요.",
        );
    }
    return url.toString().replace(/\/$/, "");
}

/** 이 폴더가 어느 사이트에 속하는가. 모르면 `null` — **지어내지 않는다.** */
export async function tenantOf(folder: string, explicit?: string): Promise<string | null> {
    if (explicit) return TENANT_CODE.test(explicit) ? explicit : null;
    const mark = parseSourceMark(await readFile(join(folder, SOURCE_MARK_PATH), "utf8").catch(() => null));
    if (mark) return mark.tenant;
    const text = await readFile(join(folder, SYNC_LEDGER_PATH), "utf8").catch(() => null);
    return text === null ? null : (parseSyncLedger(text)?.tenant ?? null);
}

/**
 * **인증만** 세운다 — 사이트 소속을 안 묻는다.
 *
 * `login` 이 이 문을 쓴다. 소속을 먼저 물으면 빈 폴더에서 처음 쓰는 사람이 로그인조차 못 하고,
 * 정작 소속을 고르려면 로그인이 먼저다.
 */
export async function openAuth(options: ContextOptions = {}): Promise<{auth: AuthConfig; store: TokenStore}> {
    const handshake = await fetchHandshake(serverUrlOf(options.env ?? process.env), version());
    return {auth: handshake.auth, store: options.store ?? new FileTokenStore()};
}

/** 명령 하나가 쓸 것을 모두 세운다. */
export async function openContext(options: ContextOptions = {}): Promise<Context> {
    const env = options.env ?? process.env;
    const folder = resolve(options.folder ?? process.cwd());
    const serverUrl = serverUrlOf(env);

    const tenant = await tenantOf(folder, options.tenant);
    if (!tenant) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            "이 폴더가 어느 사이트의 것인지 알 수 없습니다.",
            "사이트 폴더 안에서 실행하거나 `--site <사이트코드>` 를 붙여 주세요.",
        );
    }

    // 판정은 서버가 한다 — 구버전일수록 자기 판정 코드도 낡았다.
    const handshake = await fetchHandshake(serverUrl, version());
    const store = options.store ?? new FileTokenStore();
    const auth: AuthConfig = handshake.auth;

    const api = new ZalkeraApi({
        apiBase: serverUrl,
        accessToken: () => getAccessToken(auth, store),
        tenantCode: () => tenant,
    });
    return {api, auth, store, folder, tenant, serverUrl};
}

/**
 * 이 도구의 판. 핸드셰이크가 이 값으로 「올려야 하는가」를 판정한다.
 *
 * ⚠ **값을 두 벌로 두지 않는다.** `package.json` 에서 읽는다 — 손으로 적으면 판을 올린 날
 *   핸드셰이크가 옛 판을 신고하고, 서버의 「올리세요」가 영영 안 뜬다. 못 읽으면 `0.0.0` 이다:
 *   버전을 못 읽었다고 도구가 죽으면 안 되고, 낮은 값이라 서버가 보수적으로 판정한다.
 */
export function version(): string {
    try {
        const path = fileURLToPath(new URL("../package.json", import.meta.url));
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        const declared = (raw as {version?: unknown}).version;
        return typeof declared === "string" ? declared : "0.0.0";
    } catch {
        return "0.0.0";
    }
}
