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
    /**
     * 이 사이트의 대표 주소(호스트만 — 스킴 없음). 백엔드 `MeResponse.TenantSummary.primaryDomain` 이다:
     * 검증된 커스텀 도메인이 있으면 그것이고, 없으면 플랫폼 호스트로 접힌다.
     *
     * ⚠ **빈 문자열이 올 수 있다.** 서버가 `.orEmpty()` 로 채우는 자리이고, 실제로 비는 것은
     *   폐기된 테넌트다. 주소를 못 구한 것과 같은 뜻이므로 부르는 쪽은 비면 링크를 내지 않는다.
     *
     * ⚠ 여기서 `code` 로 호스트를 조립하지 마라. 베이스 도메인 지식의 사본이 하나 더 생기고,
     *   커스텀 도메인을 쓰는 사이트에서는 그 사본이 **틀린 주소**를 연다.
     */
    primaryDomain?: string;
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
    /**
     * 만든 시각(ISO). ⚠ **널이 올 수 있다** — 백엔드가 `Instant?` 로 보낸다. 비널로 적어 두면
     * `new Date(null)` 이 조용히 1970-01-01 을 그린다. 표시 자리는 [revisionWhen] 을 쓴다.
     */
    createdAt: string | null;
    /**
     * 사람이 붙인 버전 이름. 백엔드 `SiteRevisionSummaryResponse.label` 이다.
     *
     * ⚠ **이름을 옮겨 적지 마라.** 서버가 안 보내는 이름을 여기 적으면 값이 늘 `undefined` 라
     *   화면에서 조용히 사라진다 — 붙인 이름이 아무 데도 안 뜨는데 오류도 안 난다.
     */
    label?: string | null;
    /** FAILED 일 때만, 그리고 TENANT_ADMIN+ 에게만 온다 — 빌드 로그 tail. */
    failReason?: string | null;
    /**
     * **지금 실제로 서빙 중인가**(백엔드 명세 A). [isActive] 가 «가라»는 지시라면 이쪽은 «떠 있다»는
     * 사실이다 — 서빙박스가 자기가 띄운 판을 보고한 것이다.
     *
     * ⚠ **세 상태다.** `true`/`false` 외에 `null` 이 있고, 그 `null` 은 [servingObservedAt] 과
     *   **함께 봐야** 뜻이 갈린다(모른다 / 봤는데 아무것도 안 떠 있다). 단독으로 `!` 를 붙이지 마라.
     *
     * 구서버는 안 보낸다 → `undefined`. 그때도 「모른다」다.
     */
    isServing?: boolean | null;
    /**
     * 그 관측 시각(ISO) 또는 `null`. **[isServing] 이 `null` 이어도 이 값은 있을 수 있다.**
     * 값이 하나라도 있으면 「이 사이트는 관측이 도는 사이트다」라는 뜻이라, 반영 확인의 전제가 된다.
     */
    servingObservedAt?: string | null;
}

/** `activate` 응답에서 **우리가 쓰는 것**. 나머지 필드는 안 본다. */
export interface ActivateResult {
    // ⚠ **`revisionNo` 를 두지 않는다.** 화면이 쓰는 번호는 **사람이 고른 그 번호**이지 응답의
    //    것이 아니다 — 선언해 두면 「소비하는 필드만 둔다」는 이 형의 약속이 그 자리에서 거짓이 되고,
    //    다음 사람이 둘 중 어느 것을 믿을지 헷갈린다.
    /** 판을 실제로 옮겼는가. **결여는 `true`** — 서버 기본값이자 구서버의 뜻이다. */
    pointerMoved?: boolean;
    /** 되돌리기가 편집을 버렸는가. */
    discardedDraft?: boolean;
    /** 되돌리기가 버린 게시 대기 AI 변경 건수. */
    discardedPendingChanges?: number;
}

/**
 * `GET /draft/files` 의 응답(memo184 T0-②).
 *
 * ⚠ [strandedOnOldRevision] 이 참이면 그 편집은 **발행도 열람도 막혀 있고 되돌리기만 남는다.**
 *   그래도 [changed] 는 무엇이 들어 있었는지를 말한다 — 좌초 반출이 그 자리다.
 */
export interface DraftFiles {
    /** 불투명 세대. 편집이 없으면 `null`. */
    generation: string | null;
    changed: Array<{path: string; sha256: string}>;
    deleted: string[];
    baseRevisionNo: number | null;
    strandedOnOldRevision: boolean;
}

/** `GET /draft` 에서 **우리가 쓰는 것**. */
export interface DraftState {
    /** 되돌리기가 지목하는 판. **편집이 없으면 `null`** 이다(그때 답은 활성 행이다). */
    revertTargetRevisionNo?: number | null;
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

    /**
     * 내 소속 테넌트 — 테넌트 선택(A3)에 쓴다. 이 경로만 `X-Tenant` 를 요구하지 않는다(닭과 달걀).
     *
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
     * 미리보기 키 발급(memo146 §3.4). **재발급하면 이 테넌트의 이전 미리보기 키는 즉시 끊긴다** —
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
     * 이것이 없으면 로그아웃해도 이미 발급된 미리보기 키가 TTL(기본 12시간)까지 살아 있고, 그 키를 들고 있는
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

    /**
     * 버전 이력(최신순). B2「현재 사이트 내려받기」와 롤백이 여기서 대상을 고른다.
     *
     * @param limit **최근 몇 개만** 받을지. 없으면 전량이다.
     *
     * ⚠ **판은 발행할 때마다 늘고 줄지 않는다.** 몇 개면 되는 소비자가 전량을 받으면 그 비용이 원장
     *   크기에 비례해 영원히 자란다 — 반영 확인 폴링이 그 자리다(판 1,000개 테넌트에서 매 폴마다
     *   전량). 구 서버는 이 파라미터를 **조용히 무시**하고 전량을 준다 — 동작은 종전과 같다.
     */
    listRevisions(limit?: number): Promise<SiteRevision[]> {
        const path = "/api/partner/site-upload/revisions";
        return this.request<SiteRevision[]>("GET", limit == null ? path : `${path}?limit=${limit}`);
    }

    /** 소스 tar.gz 다운로드 URL **+ sha256**(TENANT_ADMIN+). 소스 소유의 실물이고, 해시가 그 약속의 검산이다. */
    sourceUrl(revisionNo: number): Promise<RevisionSource> {
        return this.request<RevisionSource>("GET", `/api/partner/site-upload/revisions/${revisionNo}/source-url`);
    }

    /**
     * 버전 전환(롤백 포함). READY 인 버전만 받는다.
     *
     * ⚠ **소비하는 필드만 형에 둔다.** `pointerMoved` 는 「판을 옮겼다」와 「아무것도 안 옮겼다」를
     *   가른다 — 종전에는 둘 다 성공이라 화면이 무동작을 「바꿨습니다」로 말했다.
     *   **결여는 `true` 방향**이다(서버 기본값이 그렇고, 구서버는 이 필드를 안 보낸다).
     */
    activateRevision(revisionNo: number, discardPendingChanges = false): Promise<ActivateResult> {
        return this.request<ActivateResult>(
            "POST",
            `/api/partner/site-upload/revisions/${revisionNo}/activate`,
            { body: { discardPendingChanges } },
        );
    }

    /**
     * 「지금 편집 중인 것이 있는가」 — 우리는 **`revertTargetRevisionNo` 하나만** 본다.
     *
     * ⚠ **못 읽어도 막지 않는다.** 구서버·권한 부족·망 단절이면 부르는 쪽이 `null` 로 강하하고,
     *   그때 동작은 종전과 같다(`switchCandidates` 의 KDoc). 「모르는 것으로는 막지 않는다」.
     */
    draftState(): Promise<DraftState> {
        return this.request<DraftState>("GET", "/api/partner/site-upload/draft");
    }

    /** 이 클라이언트가 어느 사이트를 가리키는가. 장부(`sync.json`)가 소속을 적을 때 쓴다. */
    tenantCode(): string {
        return this.options.tenantCode();
    }

    /**
     * 지금 편집 중인 것이 **무엇을 바꿔 놓았는가**(memo184 T0-② · `GET /draft/files`).
     *
     * ⚠ **선행조건의 정본이 이 문이다.** 로컬 도구는 다음 편집의 base sha 를 자기 장부가 아니라
     *   여기서 받는다. 장부로 폴백하면 memo184 🔴1(남이 되돌린 뒤에도 「이미 반영됨」이라 말하는
     *   거짓 성공)이 그대로 되살아난다.
     * ⚠ `generation` 은 **불투명**하다. 값을 해석하거나 순서를 매기지 않는다 — 서버 내부 토큰이
     *   클라이언트로 새지 않게 그렇게 정했다.
     *
     * 편집이 없으면 **빈 목록**이다(404 가 아니다 — 「없다」와 「못 물어봤다」를 가른다).
     */
    draftFiles(): Promise<DraftFiles> {
        return this.request<DraftFiles>("GET", "/api/partner/site-upload/draft/files");
    }

    /** 업로드 presign — zip 을 S3 로 **직접** 올린다(백엔드 미경유). */
    presignArchive(fileName: string, byteSize: number): Promise<PresignedUpload> {
        return this.request<PresignedUpload>("POST", "/api/partner/site-archive/presign", {
            body: { fileName, contentType: "application/zip", byteSize },
        });
    }

    /**
     * 업로드 확정 — 서버가 언팩·검사하고 새 버전을 만든다.
     *
     * @param baseRevisionNo 이 올리기가 **딛는다고 선언하는 판**(동시 업로드 최소 방어). 서버가 판을
     *   만들기 전에 원장 꼬리와 대조하고 다르면 `UPLOAD_BASE_MOVED` 409 로 멈춘다.
     *   `null` 은 **무선언 — 현행 그대로 통과**다(모르는 것으로 막지 않는다).
     *
     * ⚠ **동의 재시도에서도 같은 값을 실어야 한다.** 백엔드는 `BaselineShiftGuard`(동의)를 기반
     *   대조보다 **먼저** 지나므로, 동의 409 를 받고 재호출할 때 이 값을 빠뜨리면 **그 경로만 조용히
     *   무선언**이 된다 — 방어가 있는 줄 알았는데 하필 편집이 있는 사이트에서만 없다.
     */
    confirmArchive(
        storageKey: string,
        discardPendingChanges = false,
        baseRevisionNo: number | null = null,
    ): Promise<ArchiveConfirmed> {
        // ⚠ **`discardPendingChanges` 를 실을 수 있어야 한다.** 백엔드는 재업로드(confirm)·버전
        //    전환(activate)·프리셋 재개시 **세 문이 같은 `BaselineShiftGuard` 를 지난다.**
        //    종전에는 activate 만 동의를 보낼 수 있어서, 올리기는 zip 을 다 올린 뒤 409 를 받고
        //    「계속하려면 확인해 주세요」만 반복했다 — 확인할 자리가 없는 막다른 길이었다.
        return this.request<ArchiveConfirmed>("POST", "/api/partner/site-archive/confirm", {
            // 선언이 없으면 **필드 자체를 안 보낸다** — `null` 을 보내도 서버는 같게 다루지만, 안 보내는
            // 쪽이 「주장하지 않는다」는 뜻에 정확하고 구 서버와도 같은 와이어다.
            body: baseRevisionNo == null
                ? { storageKey, discardPendingChanges }
                : { storageKey, discardPendingChanges, baseRevisionNo },
        });
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
        //    이 경로는 발행·리비전 목록·미리보기 키 발급 등 **인증된 모든 호출**이 지난다.
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
 * 특히 403 은 이 도구에서 흔한 진짜 원인이 하나 있다: 순수 STAFF 계정은 미리보기 키를 발급할 수 없다.
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
        undefined,
        errorCode || undefined,
    );
}

/**
 * **동의 인자 하나(`discardPendingChanges=true`)가 서버에서 실제로 통과시키는 코드의 명시 집합.**
 *
 * ⚠ **409 전반으로 넓히지 마라 — 그리고 이름 패턴으로도 넓히지 마라.** 뚫을 수 없는 거절에도
 *   동의 창을 띄우게 된다. 같은 409 이웃에 `DRAFT_PRECONDITION_FAILED`·`DRAFT_BASE_MOVED`·
 *   `DRAFT_CONCURRENT_EDIT` 가 있고 셋 다 동의로 못 뚫는다. `*_CONFIRM_REQUIRED` 접미로 잡는 것도
 *   같은 이유로 금지다 — 이름은 계약이 아니다.
 *
 * **집합에 넣는 조건은 하나다**: 백엔드에서 그 코드를 던지는 자리가 이 인자를 받아 통과시키는가.
 */
const DISCARD_CONSENT_CODES: ReadonlySet<string> = new Set([
    // 판이 옮겨진다 — 전환은 진행되고, 게시 안 한 AI 변경이 함께 사라진다(`BaselineShiftGuard`).
    "PENDING_AI_CHANGES_CONFIRM_REQUIRED",
    // **판은 그대로다** — 이미 켜진 판을 다시 고른 것이라 「지금으로 되돌리기」로 갈리고,
    // 편집과 게시 대기 AI 변경만 버린다(`discardToCurrent`). 잃는 것이 더 크므로 문면이 다르다.
    "DRAFT_DISCARD_CONFIRM_REQUIRED",
]);

/**
 * 이 거절이 **사용자 동의 한 번으로 넘어갈 수 있는가.**
 *
 * 게시 대기 중인 AI 변경이 있어 서버가 **동의를 요구한** 거절. 백엔드 `BaselineShiftGuard` 가
 * `discardPendingChanges=true` 를 받으면 통과시킨다.
 *
 * 다른 409(게시 진행 중·AI 작업 중·레포 연결 테넌트)에는 동의로 뚫는 길이 없다 — 그래서 코드를
 * 정확히 하나만 본다. 「409 면 물어본다」로 넓히면 뚫을 수 없는 거절에도 동의 창을 띄우게 된다.
 */
export function needsDiscardConsent(error: unknown): boolean {
    return error instanceof DevtoolsError && DISCARD_CONSENT_CODES.has(error.serverCode ?? "");
}

/** 기반 대조가 막은 올리기의 서버 코드. **기계 분기는 이 코드 하나로만 한다** — 문장은 안 읽는다. */
export const UPLOAD_BASE_MOVED = "UPLOAD_BASE_MOVED";

/**
 * **내가 딛는다고 말한 판이 원장 꼬리가 아니다** — 그 사이 누가 올렸거나, 내 표식이 이 원장의 것이
 * 아니다. 서버가 판을 만들기 **전에** 막았으므로 원장에는 아무 일도 안 일어났다.
 *
 * ⚠ **[needsDiscardConsent] 와 다른 문이다.** 저쪽은 「내 편집을 버리고 계속」이고 이쪽은 「남의
 *   변경이 안 담긴 채로 계속」이다 — 사라지는 것이 다르므로 같은 동의로 뚫으면 **다른 행위에 대한
 *   동의**를 받는 것이 된다.
 */
export function isUploadBaseMoved(error: unknown): boolean {
    return error instanceof DevtoolsError && error.serverCode === UPLOAD_BASE_MOVED;
}

/**
 * 배포한 판이 **방문자에게 닿았는가**(백엔드 명세 A). 게시 직후 이 판정을 되풀이해 묻는다.
 *
 * ■ 왜 네 값인가
 *
 * `"unknown"` 이 핵심이다. 관측이 **하나도 없는** 사이트(구 백엔드·박스 미보고·git 레인)에서
 * 「아직 반영 전」이라고 말하면 그건 **영원히 안 끝나는 대기**이고, 화면은 오지 않을 소식을 기다린다.
 * 이 기능이 없애려던 병이 정확히 그것이라 — 모르는 것은 모른다고 답하고 **감시를 끝낸다.**
 *
 * `"superseded"` 도 감시 종료다. 기다리는 사이 다른 판이 활성이 되면(다른 관리자·AI 작업) 우리가
 * 기다리던 사건은 **일어나지 않는다.** 계속 물으면 「반영됐습니다」를 영영 못 내거나, 더 나쁘게는
 * 남이 올린 판의 반영을 내 판의 반영으로 말한다.
 *
 * ■ 판정
 *
 *   unknown     관측 자체가 없다(어느 판에도 `servingObservedAt` 이 없다) → 묻기를 그만둔다
 *   superseded  활성이 이미 다른 판이다 → 묻기를 그만둔다
 *   reflected   그 판이 지금 떠 있다 → 알린다
 *   pending     관측은 있는데 아직 그 판이 아니다(전환 중 포함) → 더 기다린다
 *
 * ⚠ `isServing === true` 로만 `reflected` 를 낸다. `!== false` 로 느슨하게 하면 **전환 중(null)** 이
 *   반영으로 읽혀, 아무것도 안 떠 있는 순간에 「반영됐습니다」가 뜬다.
 */
export type ReflectionState = "reflected" | "pending" | "superseded" | "unknown";

export function reflectionOf(
    revisions: readonly {
        revisionNo: number;
        isActive: boolean;
        isServing?: boolean | null;
        servingObservedAt?: string | null;
    }[],
    revisionNo: number,
): ReflectionState {
    // 관측이 도는 사이트인가 — 한 판이라도 시각이 있으면 그렇다. 없으면 기다릴 근거가 없다.
    if (!revisions.some((r) => r.servingObservedAt != null)) return "unknown";
    const active = revisions.find((r) => r.isActive);
    if (active != null && active.revisionNo !== revisionNo) return "superseded";
    return revisions.some((r) => r.revisionNo === revisionNo && r.isServing === true)
        ? "reflected"
        : "pending";
}

/**
 * **되돌리기가 지목하는 판인가** — 이것도 목록에서 뺀다.
 *
 * ⚠ **`isActive` 만으로는 못 뺀다.** 백엔드는 활성 포인터가 없는 테넌트(첫 업로드가 빌드 실패한
 *   경우)에서 **드래프트의 기준 판**을 「지금 켜진 판」으로 본다 — 안 그러면 편집을 만들 수는
 *   있는데 버릴 수도 발행할 수도 없기 때문이다. 그 판이 목록에 후보로 뜨면, 고르는 순간
 *   전환이 아니라 **폐기**가 된다.
 *
 *   백엔드가 그 자리 응답 KDoc 에 **「화면이 `isActive` 로 직접 찾으면 안 된다」**고 적어 뒀고,
 *   콘솔이 먼저 그 함정을 밟았다.
 *
 * ⚠ **서버 답 둘의 합집합이다 — 화면이 규칙을 지어내지 않는다.** 드래프트가 있으면
 *   `revertTargetRevisionNo` 가 곧 그 답이고, 없으면 그 필드는 `null` 이며 답은 목록의
 *   `isActive` 행이다. 둘을 합치면 서버가 답한 것만 남는다.
 *
 * @param revertTarget `GET /draft` 의 `revertTargetRevisionNo`. **못 읽었으면 `null`** — 모르는
 *   것으로는 막지 않는다(그때 동작은 종전과 같다).
 */
export function switchCandidates<T extends {revisionNo: number; isActive: boolean; status: string}>(
    revisions: readonly T[],
    revertTarget: number | null,
): T[] {
    return revisions.filter(
        (r) => r.status === "READY" && !r.isActive && r.revisionNo !== revertTarget,
    );
}

/**
 * 사장님이 **자기 LLM 으로 고친 것이 아직 발행 전**이라 서버가 막은 거절(memo183 T2a 가드 5층).
 *
 * ⚠ **동의로 뚫는 길이 없다 — 그래서 [needsDiscardConsent] 와 다른 함수다.** 저쪽은 「버리고 계속」이
 *   성립하지만(서버가 `discardPendingChanges=true` 를 받는다), 이쪽은 서버에 그런 인자가 없다.
 *   설계가 일부러 거절형으로 둔 자리다: AI 변경 폐기에 동의한 사람이 **손으로 쓴 편집까지** 침묵으로
 *   잃는 창을 만들지 않으려는 것이다.
 *
 * 그래서 확장이 할 일은 동의를 묻는 것이 아니라 **처분하러 보내는 것**이다. 여기서 「409 니까 물어보자」로
 * 넓히면 뚫을 수 없는 거절에 동의 창을 띄우고, 눌러도 같은 거절이 돌아온다 — 그것이 막다른 길이다.
 */
const DRAFT_IN_PROGRESS = "DRAFT_IN_PROGRESS";

/** 발행 전 편집이 남아 막힌 거절인가. 동의가 아니라 **안내**가 답이다. */
export function isDraftInProgress(error: unknown): boolean {
    return error instanceof DevtoolsError && error.serverCode === DRAFT_IN_PROGRESS;
}

/**
 * 버전 행의 시각을 **사람이 읽을 말**로. 없거나 못 읽으면 「시각 모름」이다.
 *
 * ⚠ **`new Date(...)` 를 표시 자리에 두지 않는다.** 널이면 1970-01-01, 이상한 문자열이면
 *   `Invalid Date` 가 그대로 화면에 나간다 — 둘 다 「그때 만들어졌다」는 거짓말이다.
 *   서버 값이므로 형을 믿지 않는다(이 파일은 응답 필드 타입을 검증하지 않는다).
 */
export function revisionWhen(createdAt: unknown): string {
    if (typeof createdAt !== "string" || createdAt.trim() === "") return "시각 모름";
    const at = new Date(createdAt);
    if (Number.isNaN(at.getTime())) return "시각 모름";
    return at.toLocaleString("ko-KR");
}

const MAX_SERVER_MESSAGE = 300;
const MAX_ERROR_CODE = 64;

function withTrailingSlash(base: string): string {
    return base.endsWith("/") ? base : `${base}/`;
}
