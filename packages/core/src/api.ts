import { DevtoolsError } from "./errors.ts";

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

export interface SiteRevision {
    revisionNo: number;
    status: string;
    isActive: boolean;
    createdAt: string;
    note?: string | null;
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
    async listMyTenants(): Promise<TenantSummary[]> {
        const me = await this.request<{ tenants?: TenantSummary[] }>("GET", "/api/me", { withTenant: false });
        return me.tenants ?? [];
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

    /** 소스 tar.gz 다운로드 URL(TENANT_ADMIN+). 소스 소유의 실물이다. */
    async sourceUrl(revisionNo: number): Promise<string> {
        const presigned = await this.request<{ url: string }>(
            "GET",
            `/api/partner/site-upload/revisions/${revisionNo}/source-url`,
        );
        return presigned.url;
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
    confirmArchive(storageKey: string): Promise<unknown> {
        return this.request("POST", "/api/partner/site-archive/confirm", { body: { storageKey } });
    }

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
                ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            });
        } catch (cause) {
            throw new DevtoolsError(
                "SERVER_UNREACHABLE",
                "잘커라 서버에 연결하지 못했습니다.",
                "인터넷·사내망 프록시를 확인해 주세요.",
                cause,
            );
        }
        if (!response.ok) throw await toError(response);
        const envelope = (await response.json()) as Envelope<T>;
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
        // 서버 메시지를 그대로 알림창에 넘기면 35KB 문자열이 그대로 뜬다(심의 실측 · 백엔드 차단의 대칭).
        serverMessage = (body.message ?? "").slice(0, MAX_SERVER_MESSAGE);
        errorCode = (body.errorCode ?? "").slice(0, MAX_ERROR_CODE);
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
