import { DevtoolsError } from "./errors.ts";
import { plainNotice } from "./notice.ts";

/**
 * 잘커라 파트너 API 클라이언트. **새 계약을 만들지 않는다** — 콘솔이 쓰는 그 엔드포인트를 그대로 부른다.
 *
 * 인증은 두 축이 섞이지 않는다: 사람은 Bearer(OAuth), 프로세스(dev 서버)는 스토어프론트 키. 이 클라이언트는
 * 앞의 것만 쓴다 — 뒤의 것은 발급받아 `.env.local` 로 넘길 뿐 여기서 쓰지 않는다.
 */
export interface ApiOptions {
    apiBase: string;
    /** 호출 시점에 유효한 access 토큰을 돌려준다(만료 갱신은 호출부 몫 — `getAccessToken`). */
    accessToken(): Promise<string>;
    /** 테넌트 스코프. 대부분의 파트너 API 가 `X-Tenant` 를 요구한다. */
    tenantCode(): string;
    fetchImpl?: typeof fetch;
}

export interface TenantSummary {
    code: string;
    name: string;
}

export interface IssuedPreviewKey {
    id: number;
    key: string;
    hint: string;
    /** 서버가 알려 주는 `.env.local` 의 칸 이름 — 확장이 이름을 하드코딩하지 않게 한다. */
    envName: string;
    expiresAt: string | null;
    readOnly: boolean;
    revokedPrevious: number;
    warning: string;
}

export interface SitePreset {
    code: string;
    name: string;
    description: string;
    version: string;
    sha256: string;
    previewUrl: string | null;
}

export interface PresetSource {
    url: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    filename: string;
}

export interface RevisionSource {
    url: string;
    revisionNo: number;
    /** canonical tar.gz 의 sha256. **받는 쪽이 대조하지 않으면 서버의 약속은 말뿐이다.** */
    sha256: string;
    expiresAt: string;
}

export interface SiteRevision {
    revisionNo: number;
    /** `READY` | `BUILDING` | `FAILED` (backend RevisionStatus). 활성 전환은 READY 만 받는다. */
    status: string;
    isActive: boolean;
    createdAt: string;
    note?: string | null;
    /** FAILED 일 때만, 그리고 TENANT_ADMIN+ 에게만 온다 — 빌드 로그 tail. */
    failReason?: string | null;
}

/**
 * 업로드 확정 결과. **버리지 않는다** — 종전에는 `unknown` 이라 방금 만든 버전의 번호도 상태도 몰랐고,
 * 그래서 "올렸습니다"에서 이야기가 끊겼다.
 */
export interface ArchiveConfirmed {
    revisionNo: number;
    /** `STATIC`(빌드 0 · 즉시 READY) | `NEXT_SOURCE`(서버가 빌드 — BUILDING 으로 시작) */
    siteType: string;
    status: string;
    /** 유형별 한계·상태를 서버가 사람 말로 적어 보낸다(memo66 §4 — 숨기지 않는다). */
    capabilityNote: string;
}

export interface PresignedUpload {
    uploadUrl: string;
    storageKey: string;
    expiresAt: string;
}

interface Envelope<T> {
    status: number;
    message?: string;
    errorCode?: string;
    data: T;
}

export class ZalkeraApi {
    private readonly fetchImpl: typeof fetch;
    private readonly options: ApiOptions;

    constructor(options: ApiOptions) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    /** 내 소속 테넌트 — 테넌트 선택(A3)에 쓴다. 이 경로만 `X-Tenant` 를 요구하지 않는다(닭과 달걀). */
    /**
     * 내가 고를 수 있는 사이트. **`isSuperAdmin` 을 함께 돌려준다** — 목록이 비었다고 해서
     * "사이트가 없다"가 아니기 때문이다.
     *
     * 서버는 `admin_user_tenant` **소속만** 열거한다. SUPER_ADMIN 은 소속과 무관하게 전 테넌트에
     * 접근하므로(`AdminUserAuth.canAccessTenant`), 소속 행이 없는 순수 super-admin 은 **목록이 빈 채로
     * 모든 사이트를 다룰 수 있다.** 그 둘을 구분하지 않으면 사용자에게 거짓을 말하게 된다.
     */
    async whoAmI(): Promise<{ tenants: TenantSummary[]; isSuperAdmin: boolean }> {
        const me = await this.request<{ tenants?: TenantSummary[]; isSuperAdmin?: boolean }>(
            "GET",
            "/api/me",
            { withTenant: false },
        );
        return { tenants: me.tenants ?? [], isSuperAdmin: me.isSuperAdmin === true };
    }

    async listMyTenants(): Promise<TenantSummary[]> {
        return (await this.whoAmI()).tenants;
    }

    /**
     * 프리뷰 키 발급(memo146 §3.4). **재발급하면 이 테넌트의 이전 프리뷰 키는 즉시 끊긴다** —
     * `revokedPrevious` 가 0 이 아니면 호출부는 그 사실을 사람에게 말해야 한다(말 없이 끊기면 고장으로 읽힌다).
     */
    issuePreviewKey(label?: string): Promise<IssuedPreviewKey> {
        return this.request<IssuedPreviewKey>("POST", "/api/partner/storefront-keys/preview", {
            body: label ? { label } : {},
        });
    }

    /**
     * 스토어프론트 키 폐기 — **로그아웃이 진짜 로그아웃이 되게 하는 조각**(심의 경고).
     *
     * 이것이 없으면 로그아웃해도 이미 발급된 프리뷰 키가 TTL(기본 12시간)까지 살아 있고, 그 키를 들고 있는
     * dev 서버는 계속 상용 데이터를 읽는다. "로그아웃했다"는 화면과 실제가 어긋나는 자리다.
     */
    revokeStorefrontKey(keyId: number): Promise<unknown> {
        return this.request("DELETE", `/api/partner/storefront-keys/${keyId}`);
    }

    /** 시작 소스 팩 목록(B1). 공개된 것만 온다 — 고를 수 없는 것은 안 보이는 편이 정직하다. */
    listPresets(): Promise<SitePreset[]> {
        return this.request<SitePreset[]>("GET", "/api/partner/site-preset/presets");
    }

    /** 팩 소스 zip 의 단기 URL + **sha256**(받는 쪽이 대조한다 — 그래야 "배달했으면 끝"이 검증 가능한 약속이 된다). */
    presetSourceUrl(code: string): Promise<PresetSource> {
        return this.request<PresetSource>("GET", `/api/partner/site-preset/presets/${encodeURIComponent(code)}/source-url`);
    }

    /** 버전 이력(최신순). B2「현재 사이트 내려받기」와 롤백이 여기서 대상을 고른다. */
    listRevisions(): Promise<SiteRevision[]> {
        return this.request<SiteRevision[]>("GET", "/api/partner/site-upload/revisions");
    }

    /** 소스 tar.gz 다운로드 URL **+ sha256**(TENANT_ADMIN+). 소스 소유의 실물이고, 해시가 그 약속의 검산이다. */
    sourceUrl(revisionNo: number): Promise<RevisionSource> {
        return this.request<RevisionSource>("GET", `/api/partner/site-upload/revisions/${revisionNo}/source-url`);
    }

    /** 버전 전환(롤백 포함). READY 인 버전만 받는다. */
    activateRevision(revisionNo: number, discardPendingChanges = false): Promise<unknown> {
        return this.request("POST", `/api/partner/site-upload/revisions/${revisionNo}/activate`, {
            body: { discardPendingChanges },
        });
    }

    /** 업로드 presign — zip 을 S3 로 **직접** 올린다(백엔드 미경유). */
    presignArchive(fileName: string, byteSize: number): Promise<PresignedUpload> {
        return this.request<PresignedUpload>("POST", "/api/partner/site-archive/presign", {
            body: { fileName, contentType: "application/zip", byteSize },
        });
    }

    /** 업로드 확정 — 서버가 언팩·검사하고 새 버전을 만든다. */
    confirmArchive(storageKey: string): Promise<ArchiveConfirmed> {
        return this.request<ArchiveConfirmed>("POST", "/api/partner/site-archive/confirm", { body: { storageKey } });
    }

    /**
     * 요청 상한. **Node 의 `fetch` 는 기본 타임아웃이 없다** — 서버가 연결만 붙들고 응답을 안 주면
     * 호출자가 영원히 매달린다. 로그아웃의 키 폐기는 진행 표시조차 없어 화면이 그냥 멈춘 것처럼 보인다.
     *
     * 이 값은 **제어 평면 호출**(수 KB JSON)의 상한이다. 대용량 업로드는 이 클래스를 통과하지 않는다
     * (presign 으로 받은 URL 에 직접 올린다) — 그래서 짧게 잡아도 큰 전송을 끊지 않는다.
     */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private async request<T>(
        method: string,
        path: string,
        init: { body?: unknown; withTenant?: boolean } = {},
    ): Promise<T> {
        const headers: Record<string, string> = {
            accept: "application/json",
            authorization: `Bearer ${await this.options.accessToken()}`,
        };
        if (init.withTenant !== false) headers["x-tenant"] = this.options.tenantCode();
        if (init.body !== undefined) headers["content-type"] = "application/json";

        let response: Response;
        try {
            response = await this.fetchImpl(new URL(path, withTrailingSlash(this.options.apiBase)), {
                method,
                headers,
                signal: AbortSignal.timeout(ZalkeraApi.REQUEST_TIMEOUT_MS),
                ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            });
        } catch (cause) {
            // 시간 초과와 연결 실패를 **갈라서 말한다** — 사람이 할 일이 다르다(기다리기 vs 네트워크 점검).
            const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
            throw new DevtoolsError(
                "SERVER_UNREACHABLE",
                timedOut ? "잘커라 서버가 제때 응답하지 않았습니다." : "잘커라 서버에 연결하지 못했습니다.",
                timedOut ? "잠시 뒤 다시 시도해 주세요." : "인터넷·사내망 프록시를 확인해 주세요.",
                cause,
            );
        }
        if (!response.ok) throw await toError(response);

        // ⚠ **본문이 우리 형식이라고 가정하지 않는다.** 200 이어도 캡티브 포털·프록시 오류 페이지는
        //    HTML 을 준다. 종전에는 곧장 `.json()` 을 부르고 `.data` 를 읽어, 그 입력에 raw
        //    `SyntaxError`/`TypeError` 가 **고객 대화상자로 그대로** 나갔다(`register()` 는
        //    `DevtoolsError` 가 아니면 `String(error)` 를 띄운다).
        //
        //    형제 `handshake.ts` 는 같은 파싱을 이미 감싸고 있고, 그 주석이 "초판은 곧장 읽어
        //    SyntaxError 가 그대로 사용자에게 갔다"고 적었다 — **그 수정이 한쪽에만 적용돼 있었다.**
        //    이 경로는 발행·리비전 목록·프리뷰 키 발급 등 **인증된 모든 호출**이 지난다.
        let envelope: Envelope<T>;
        try {
            envelope = (await response.json()) as Envelope<T>;
        } catch (cause) {
            throw new DevtoolsError(
                "SERVER_UNREACHABLE",
                "서버 응답을 이해하지 못했습니다.",
                `${this.options.apiBase} 가 잘커라 서버가 맞는지, 사내망 프록시가 응답을 바꾸고 있지 않은지 확인해 주세요.`,
                cause,
            );
        }
        // `data` 누락도 여기서 끊는다. 통과시키면 `undefined` 가 호출부까지 흘러가 엉뚱한 자리에서
        // `revisions.filter(...)` 같은 raw TypeError 가 된다 — 원인에서 먼 곳에서 터진다.
        if (envelope === null || typeof envelope !== "object" || !("data" in envelope)) {
            throw new DevtoolsError(
                "SERVER_UNREACHABLE",
                "서버 응답에 필요한 정보가 없습니다.",
                `${this.options.apiBase} 가 잘커라 서버가 맞는지 확인해 주세요.`,
            );
        }
        return envelope.data;
    }
}

/**
 * 서버 오류를 **사람이 읽을 말**로 옮긴다. 상태코드만 던지면 사용자는 무엇을 해야 할지 모른다 —
 * 특히 403 은 이 도구에서 흔한 진짜 원인이 하나 있다: 순수 STAFF 계정은 프리뷰 키를 발급할 수 없다.
 */
async function toError(response: Response): Promise<DevtoolsError> {
    let serverMessage = "";
    let errorCode = "";
    try {
        const body = (await response.json()) as { message?: string; errorCode?: string };
        // 서버 메시지를 그대로 알림창에 넘기면 35KB 문자열이 그대로 뜬다(실측 · 백엔드 차단의 대칭).
        // 길이만으로는 부족하다 — 알림 본문은 링크를 렌더하고 그 링크는 명령을 실행할 수 있다.
        serverMessage = plainNotice(body.message, MAX_SERVER_MESSAGE);
        // ⚠ **길이만 자르면 안 된다.** 바로 위 두 줄이 "알림 본문은 링크를 렌더하고 그 링크는
        //    명령을 실행할 수 있다"고 적어 두고 `message` 만 막았는데, 이 값도 같은 서버가 정하고
        //    `errors.ts` 의 `humanMessage` 를 타고 **같은 비-모달 알림**으로 나간다(재심의 실증).
        //    인증된 모든 실패 응답이 지나는 경로다.
        errorCode = plainNotice(body.errorCode ?? "", MAX_ERROR_CODE);
    } catch {
        /* 본문이 JSON 이 아닐 수 있다 — 상태코드로만 판단한다. */
    }

    if (response.status === 401) {
        return new DevtoolsError("NOT_AUTHENTICATED", "로그인이 만료되었습니다.", "다시 로그인해 주세요.");
    }
    if (response.status === 403) {
        return new DevtoolsError(
            "FORBIDDEN",
            serverMessage || "이 작업을 할 권한이 없습니다.",
            "사이트 소스를 다루려면 관리자 권한이 필요합니다. 계정 권한을 확인해 주세요.",
        );
    }
    return new DevtoolsError(
        "SERVER_REJECTED",
        serverMessage || `서버가 요청을 거절했습니다(HTTP ${response.status}).`,
        errorCode ? `오류 코드: ${errorCode}` : undefined,
    );
}

const MAX_SERVER_MESSAGE = 300;
const MAX_ERROR_CODE = 64;

function withTrailingSlash(base: string): string {
    return base.endsWith("/") ? base : `${base}/`;
}
