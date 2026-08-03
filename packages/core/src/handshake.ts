import { DevtoolsError } from "./errors.ts";

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
}

/** 서버 공통 응답 봉투. */
interface Envelope<T> {
    status: number;
    message?: string;
    errorCode?: string;
    data: T;
}

/**
 * 핸드셰이크를 받아 온다. **판정은 서버가 한다** — 우리는 그 답을 옮길 뿐이다(구버전일수록 자기 판정
 * 코드도 낡았으므로, 판정을 클라이언트에 두면 정작 고쳐야 할 버전이 자기가 낡은 줄 모른다).
 *
 * `UPGRADE_REQUIRED` 면 여기서 던진다 — 호출부가 판정을 다시 해석하지 않게 하려는 것이다.
 */
export async function fetchHandshake(
    apiBase: string,
    extensionVersion: string,
    fetchImpl: typeof fetch = fetch,
): Promise<Handshake> {
    const url = new URL("/api/devtools/handshake", withTrailingSlash(apiBase));
    url.searchParams.set("extensionVersion", extensionVersion);

    let response: Response;
    try {
        response = await fetchImpl(url, { headers: { accept: "application/json" } });
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

    const body = (await response.json()) as Envelope<Handshake>;
    const handshake = body.data;
    if (handshake.verdict === "UPGRADE_REQUIRED") {
        throw new DevtoolsError(
            "EXTENSION_OUTDATED",
            handshake.message ?? "이 버전은 더 이상 서버와 맞지 않습니다.",
            `${handshake.minExtensionVersion} 이상으로 업데이트한 뒤 다시 시도해 주세요.`,
        );
    }
    return handshake;
}

/** `new URL(path, base)` 는 base 의 마지막 경로 조각을 버린다 — 베이스에 경로가 있어도 안 잘리게 맞춘다. */
function withTrailingSlash(base: string): string {
    return base.endsWith("/") ? base : `${base}/`;
}
