import { DevtoolsError } from "./errors.ts";
import { plainNotice } from "./notice.ts";
import { apiBaseUrl, httpUrl, mcpServerName } from "./serverUrl.ts";

/**
 * 서버 핸드셰이크(backend memo146 §6.1 B-5). **로그인보다 먼저** 부른다 — 이유 둘.
 *
 * 1. 계약이 이미 깨졌다면 로그인 실패를 원인으로 오인하지 않게 한다.
 * 2. 로그인에 필요한 좌표(issuer·clientId·scopes)를 여기서 받는다. 이 레포는 공개라 하드코딩하지 않는다.
 */
export interface Handshake {
    verdict: "OK" | "UPGRADE_RECOMMENDED" | "UPGRADE_REQUIRED" | "UNKNOWN";
    message: string | null;
    minExtensionVersion: string;
    recommendedExtensionVersion: string;
    minClientVersion: string;
    auth: { issuer: string; clientId: string; scopes: string[] };
    previewKeyTtlSeconds: number;
    /**
     * 매뉴얼 주소. **서버가 정한다** — auth 좌표를 하드코딩하지 않는 이유와 같다.
     *
     * 확장은 고객 기계에 깔려 강제 업데이트가 안 되므로, 주소를 코드에 박으면 **호스트를 옮기는 날
     * 전원이 새 VSIX 를 깔아야 한다.** 여기로 내려보내면 서버 설정 한 줄로 옮겨진다
     * (지금 GitHub Pages → 나중에 www.zalkera.com).
     *
     * 없으면(구버전 서버) 확장에 박힌 기본값을 쓰고, 그것도 안 닿으면 동봉본을 연다.
     */
    helpUrl?: string | null;
    /**
     * MCP 등록 좌표(서버가 마운트를 열었을 때만 온다 · memo146 T4).
     *
     * 없으면 「에이전트 연결」은 **눌렀을 때** 「서버가 아직 안 열었습니다」로 답한다(사이드바에는
     * 조건 없이 보인다). 구버전 서버는 이 필드를 아예 안 보내므로 `undefined` 도 같은 뜻이다.
     */
    mcp?: {
        sourceUrlTemplate: string;
        clientId: string;
        authServerMetadataUrl: string;
        serverName: string;
    } | null;
}

/** 서버 공통 응답 봉투. */
interface Envelope<T> {
    status: number;
    message?: string;
    errorCode?: string;
    data: T;
}

/**
 * 핸드셰이크 상한. 본문이 수 KB JSON 이므로 전송 상한(15분)과 다른 값이다 — 이 호출이 늦으면
 * 고객은 아무 화면도 못 보고 기다린다.
 */
const HANDSHAKE_TIMEOUT_MS = 15 * 1000;

/**
 * 판 문자열을 문장에 실을 때의 상한.
 *
 * ⚠ **판 번호는 짧다.** 이 값이 넉넉해 보이는 것은 서버가 `1.2.3-rc.4+build.5` 같은 것을 보낼 수
 *   있어서이고, 그보다 긴 것은 판 번호가 아니라 **문장을 밀어내려는 값**이다.
 */
const MAX_VERSION_SHOWN = 40;

/**
 * 핸드셰이크를 받아 온다. **판정은 서버가 한다** — 우리는 그 답을 옮길 뿐이다(구버전일수록 자기 판정
 * 코드도 낡았으므로, 판정을 클라이언트에 두면 정작 고쳐야 할 버전이 자기가 낡은 줄 모른다).
 *
 * `UPGRADE_REQUIRED` 면 여기서 던진다 — 호출부가 판정을 다시 해석하지 않게 하려는 것이다.
 *
 * ⚠ **「업데이트하세요」의 방법은 문마다 다르다.** 확장은 편집기가 알아서 갱신하지만, CLI 는
 *   사람이 명령을 쳐야 한다. 그 한 줄이 없으면 게이트에 걸린 사람은 **나갈 길이 없다** —
 *   「업데이트한 뒤 다시 시도해 주세요」만 읽고 무엇을 할지 모른다. 부르는 쪽이 방법을 준다
 *   ([upgradeHow]). 판정은 서버가, 방법은 문이 안다.
 */
export async function fetchHandshake(
    apiBase: string,
    extensionVersion: string,
    fetchImpl: typeof fetch = fetch,
    /** 이 문에서 **어떻게** 업데이트하는가. 안 주면 방법을 말하지 않는다(거짓 안내보다 낫다). */
    upgradeHow?: string,
): Promise<Handshake> {
    const url = new URL("/api/devtools/handshake", withTrailingSlash(apiBase));
    url.searchParams.set("extensionVersion", extensionVersion);

    let response: Response;
    try {
        // ⚠ **상한을 건다.** Node 의 `fetch` 는 기본 타임아웃이 없다 — 연결만 받고 응답을 안 주는
        //    프록시·게이트웨이에 물리면 이 await 가 **영원히 정착하지 않는다**(`api.ts` 가 같은 말을
        //    적어 두고 고쳤는데 먼저 도는 이쪽에는 그 규율이 안 왔다). TCP 를 끊는 고장은 OS 가
        //    상한을 주지만, 붙드는 고장은 아무 상한도 주지 않는다.
        //
        //    이 함수는 로그인·사이트 선택·미리보기·발행의 **첫 await** 이고 그 위를 덮은 진행 알림은
        //    대부분 취소 불가다. 여기서 안 끊으면 고객에게 남는 것은 영원히 도는 스피너뿐이다.
        //    본문이 수 KB JSON 이라 전송 상한(15분)보다 훨씬 짧게 잡는다.
        response = await fetchImpl(url, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
        });
    } catch (cause) {
        throw new DevtoolsError(
            "SERVER_UNREACHABLE",
            "잘커라 서버에 연결하지 못했습니다.",
            `주소가 맞는지(${apiBase}), 인터넷·사내망 프록시가 막고 있지 않은지 확인해 주세요.`,
            cause,
        );
    }
    if (!response.ok) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `서버가 응답하지 않습니다(HTTP ${response.status}).`,
            "잠시 뒤 다시 시도해 주세요. 계속되면 잘커라에 문의해 주세요.",
        );
    }

    // 응답이 우리 형식이라는 보장이 없다 — 게이트웨이가 502 HTML 을 주거나 프록시가 로그인 페이지를 끼워 넣는다.
    // 초판은 곧장 `.data.verdict` 를 읽어 `TypeError`·`SyntaxError` 가 그대로 사용자에게 갔다(심의 실측).
    let body: Envelope<Handshake>;
    try {
        body = (await response.json()) as Envelope<Handshake>;
    } catch (cause) {
        throw new DevtoolsError(
            "SERVER_UNREACHABLE",
            "서버 응답을 이해하지 못했습니다.",
            `${apiBase} 가 잘커라 서버가 맞는지, 사내망 프록시가 응답을 바꾸고 있지 않은지 확인해 주세요.`,
            cause,
        );
    }
    const handshake = body?.data;
    if (!handshake || typeof handshake.verdict !== "string") {
        throw new DevtoolsError(
            "SERVER_UNREACHABLE",
            "서버 응답에 필요한 정보가 없습니다.",
            "주소가 잘커라 서버가 맞는지 확인해 주세요.",
        );
    }
    // **경계에서 한 번 막는다.** 이 값들은 브라우저를 열고(`issuer`), 인가 코드와 PKCE verifier 를
    // POST 하고(같은 `issuer`), 고객 에이전트의 접속처와 고객 파일의 **키**가 된다(`mcp`).
    // 소비처마다 검사하면 새로 늘어나는 소비처가 매번 맨몸으로 들어오므로, **여기를 못 지나면
    // 핸드셰이크가 성립하지 않는다.**
    //
    // ⚠ 자격증명을 나르는 주소에는 `httpUrl` 이 아니라 `apiBaseUrl`(https 또는 루프백)을 건다.
    //   평문을 허용하면 이 모듈이 `apiBase` 에 https 를 요구한 근거("중간에 앉은 쪽이 바꿔 쓴다")가
    //   정작 인가 코드·토큰이 오가는 자리에서 무너진다. 로컬 Keycloak 개발은 루프백 예외로 덮인다.
    //
    // ⚠ `auth` 가 **없는** 경우도 거절한다. 있고 나쁠 때만 막으면 계약이 반만 참이고, 하류에서
    //   `config.issuer` 를 읽다 raw TypeError 가 사용자에게 그대로 간다.
    if (!handshake.auth || !apiBaseUrl(handshake.auth.issuer)) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "서버가 보낸 로그인 주소를 쓸 수 없습니다.",
            "잘커라에 문의해 주세요.",
        );
    }
    if (
        handshake.mcp &&
        (!apiBaseUrl(handshake.mcp.authServerMetadataUrl) ||
            !apiBaseUrl(handshake.mcp.sourceUrlTemplate?.replace("{tenantCode}", "probe")) ||
            !mcpServerName(handshake.mcp.serverName))
    ) {
        // 에이전트 연결만 못 쓰게 한다 — 로그인·발행까지 막을 이유는 없다.
        handshake.mcp = null;
    }

    // **서버가 준 문장도 경계에서 소독한다.** 알림 본문은 평문이 아니라 `[글자](스킴:...)` 를 링크로
    // 렌더하고, 그 링크는 명령을 실행할 수 있다. 소비처마다 소독하면 새 소비처가 맨몸으로 들어온다.
    handshake.message = handshake.message == null ? null : plainNotice(handshake.message);
    // ⚠ **판 문자열도 서버가 정한다.** 종전에는 이 둘만 경계를 안 지났다 — 문장에 실려 같은 알림으로
    //   나가는데 소독이 없었다. `MAX_VERSION_SHOWN` 으로 죄는 이유는 아래 hint 조립에 있다.
    handshake.minExtensionVersion = plainNotice(handshake.minExtensionVersion, MAX_VERSION_SHOWN);
    handshake.recommendedExtensionVersion = plainNotice(handshake.recommendedExtensionVersion, MAX_VERSION_SHOWN);

    if (handshake.verdict === "UPGRADE_REQUIRED") {
        throw new DevtoolsError(
            "EXTENSION_OUTDATED",
            handshake.message ?? "이 버전은 더 이상 서버와 맞지 않습니다.",
            // 🔴 **나가는 길을 맨 앞에 둔다.** `humanMessage` 가 다시 300자로 죄므로, 서버가 정하는
            //    글자가 앞에 오면 **긴 값 하나로 우리 안내를 통째로 밀어낼 수** 있다(심의 실측:
            //    191자면 `npx zalkera@latest` 가 사라진다). 그러면 「업데이트하세요」만 남고
            //    방법이 없는, 이 인자가 막으려던 그 교착이 서버 문자열 하나로 되살아난다.
            (upgradeHow === undefined ? "" : `${upgradeHow} `) +
                `서버가 요구하는 최소 버전은 ${handshake.minExtensionVersion} 입니다.`,
        );
    }
    return handshake;
}

/** `new URL(path, base)` 는 base 의 마지막 경로 조각을 버린다 — 베이스에 경로가 있어도 안 잘리게 맞춘다. */
function withTrailingSlash(base: string): string {
    return base.endsWith("/") ? base : `${base}/`;
}
