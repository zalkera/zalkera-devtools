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
    inspectProject,
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
    const handshake = await fetchHandshake(serverUrlOf(options.env ?? process.env), version(), fetch, UPGRADE_HOW);
    return {auth: {...handshake.auth, loginHow: LOGIN_HOW}, store: options.store ?? new FileTokenStore()};
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

    // 🔴 **로컬 사실은 네트워크보다 먼저 말한다.** 이 도구가 사이트 의존에 들어와 있는지는
    //    폴더만 보면 아는 일인데, 핸드셰이크 뒤에 두면 서버가 안 될 때 **영영 안 뜬다** —
    //    그리고 이 오인을 하는 사람은 대개 처음 설치한 사람이라 서버 설정도 아직이다.
    //
    // ⚠ **모든 명령이 이 문을 지난다** — 여기 한 자리에 두면 `status` 든 `push` 든 같은 고지를
    //   받는다. 명령마다 두면 어느 하나는 빠진다.
    // ⚠ **읽기 실패는 삼킨다.** `package.json` 이 없거나 깨진 폴더에서 이 곁다리 고지 때문에
    //   명령이 죽으면 안 된다.
    for (const line of await misplacedToolLines(folder)) process.stderr.write(`${line}\n`);

    // 판정은 서버가 한다 — 구버전일수록 자기 판정 코드도 낡았다.
    const handshake = await fetchHandshake(serverUrl, version(), fetch, UPGRADE_HOW);
    const store = options.store ?? new FileTokenStore();
    // ⚠ **이 문에서 어떻게 로그인하는가.** 안 주면 「다시 로그인해 주세요」가 나갈 길 없는
    //   막다른 길이 된다 — 그리고 그 문장은 MCP 를 타고 **모델에게** 간다.
    const auth: AuthConfig = {...handshake.auth, loginHow: LOGIN_HOW};

    const api = new ZalkeraApi({
        apiBase: serverUrl,
        accessToken: () => getAccessToken(auth, store),
        tenantCode: () => tenant,
    });
    return {api, auth, store, folder, tenant, serverUrl};
}

/**
 * **이 도구가 사이트 의존에 들어와 있는가** — 있으면 사람에게 할 말.
 *
 * 형제 `@zalkera/client` 와 스코프가 같아 형제 패키지로 오인되는데, 넣으면 그 `package.json` 이
 * 사이트와 함께 올라가 **서버가 사이트를 지을 때 이것까지 설치한다.**
 *
 * ⚠ **확장의 `doctor` 에만 두면 CLI 사용자에게 안 닿는다** — 그런데 그 오인을 하는 쪽이 바로
 *   이 도구를 설치하는 사람이다.
 */
async function misplacedToolLines(folder: string): Promise<string[]> {
    const found = await inspectProject(folder)
        .then((p) => p.toolInDeps)
        .catch(() => [] as readonly string[]);
    if (found.length === 0) return [];
    return [
        `⚠ ${found.join(" · ")} 가 이 사이트의 의존으로 들어 있습니다.`,
        "  이것은 소스가 `import` 하는 패키지가 아니라 터미널에서 치는 명령입니다.",
        "  `package.json` 에서 빼 주세요 — 그대로 두면 사이트를 지을 때 함께 설치됩니다.",
    ];
}

/**
 * 이 문에서 **어떻게** 로그인하는가.
 *
 * ⚠ 확장 안에서는 누를 단추가 있지만 여기는 사람이 명령을 쳐야 한다. 그리고 이 문장은 MCP 를
 *   타고 **모델에게** 가서 사장님께 그대로 옮겨진다 — 나갈 길이 문장 안에 있어야 한다.
 */
export const LOGIN_HOW = "터미널에서 `zalkera login` 을 한 번 실행해 주세요.";

/**
 * 이 문에서 **어떻게** 업데이트하는가.
 *
 * ⚠ 여기는 사람이 명령을 쳐야 한다. 이 한 줄이 없으면 최소판 게이트에 걸린 사람은
 *   「업데이트한 뒤 다시 시도해 주세요」만 읽고 **나갈 길이 없다.**
 * ⚠ 두 길을 다 적는다 — `npx` 로 쓰는 사람과 전역 설치로 쓰는 사람이 나가는 문이 다르다.
 */
export const UPGRADE_HOW =
    "`npx @zalkera/cli@latest <명령>` 으로 부르거나, 전역 설치를 쓰신다면 `npm i -g @zalkera/cli@latest` 를 실행해 주세요.";

/**
 * 이 도구의 판. **서버의 최소판 게이트가 이 값으로 판정한다**(`fetchHandshake`).
 *
 * 🔴 **못 읽었을 때 `"0.0.0"` 으로 접지 않는다.** 그 값은 어떤 최소판에도 못 미치므로 서버가
 *    `UPGRADE_REQUIRED` 를 내고, 그러면 「업데이트한 뒤 다시 시도해 주세요」가 뜨는데 **업데이트해도
 *    안 고쳐진다** — 낡은 것은 판이 아니라 설치가 깨진 것이기 때문이다. 두 문이 서로를 가리키는
 *    그 교착이고, 이 레포가 다른 자리에서 이미 여러 번 막은 얼굴이다.
 *
 * ⚠ 자기 `package.json` 을 못 읽는 것은 **설치가 깨졌다**는 뜻이다. 그것을 그렇게 말한다.
 *
 * ⚠ **확장 동봉본은 확장 매니페스트를 읽는다.** vsix 안에서는 이 번들이 `extension/dist/` 에
 *   있어 `../package.json` 이 확장의 것이다 — 그리고 그 값이 **맞다**. 두 판은 서버의 최소판
 *   게이트가 하나라 `check-version-lockstep` 이 같게 묶는다(우연이 아니라 계약이다).
 */
export function version(): string {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    } catch (error) {
        throw new DevtoolsError(
            "INSTALL_BROKEN",
            "이 도구의 설치가 온전하지 않습니다 — 자기 버전을 읽지 못했습니다.",
            REINSTALL_HOW,
            error,
        );
    }
    return versionFrom(raw);
}

/**
 * 읽은 매니페스트에서 **판을 판정한다** — 읽기와 가른 이유가 이것이다.
 *
 * 🔴 **여기가 `"0.0.0"` 교착을 막는 자리다.** 읽기와 붙어 있으면 이 판정을 물 자리가 없어,
 *    다음 손이 접기를 폴백으로 되돌려도 게이트가 초록이다(설계자 심의 실측 — 변이 넷 전부 생존).
 *    이음매를 만든 것이 아니라 **읽는 일과 판정하는 일을 갈랐다.**
 */
export function versionFrom(raw: unknown): string {
    const declared = (raw as {version?: unknown} | null)?.version;
    if (typeof declared !== "string" || declared.trim() === "") {
        throw new DevtoolsError(
            "INSTALL_BROKEN",
            "이 도구의 설치가 온전하지 않습니다 — 버전 표기가 비어 있습니다.",
            REINSTALL_HOW,
        );
    }
    return declared;
}

/** 설치가 깨졌을 때 나가는 길. **두 갈래가 같은 문장을 쓴다** — 원인이 달라도 처방은 하나다. */
const REINSTALL_HOW =
    "`npm i -g @zalkera/cli@latest` 로 다시 설치하거나, `npx @zalkera/cli@latest <명령>` 으로 실행해 주세요.";
