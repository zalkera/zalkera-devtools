/**
 * 러너가 던지는 오류. **코드와 사람 말을 함께 가진다.**
 *
 * 이 도구의 사용자는 대개 개발자가 아니다. 스택 트레이스나 HTTP 상태코드를 보여 주는 것은 "무엇이
 * 잘못됐는지"를 말해 주지 않는다. 그래서 오류는 ⑴ 프로그램이 분기할 [code] 와 ⑵ 사람에게 그대로
 * 보여 줄 [message], ⑶ 가능하면 **다음에 할 일**([hint])을 함께 싣는다.
 */
export class DevtoolsError extends Error {
    readonly code: DevtoolsErrorCode;
    readonly hint: string | undefined;

    // 파라미터 프로퍼티(`constructor(readonly x)`)를 쓰지 않는다 — Node 의 타입 스트립 실행이 그 문법을
    // 받지 않아서, 쓰는 순간 테스트가 빌드 산출물을 거쳐야 한다(소스를 그대로 돌리는 이점이 사라진다).
    constructor(code: DevtoolsErrorCode, message: string, hint?: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "DevtoolsError";
        this.code = code;
        this.hint = hint;
    }

    /** 사람에게 보여 줄 전체 문장(메시지 + 다음 할 일). */
    get humanMessage(): string {
        return this.hint ? `${this.message}\n${this.hint}` : this.message;
    }
}

export type DevtoolsErrorCode =
    /** 서버가 이 버전을 더 이상 받지 않는다(핸드셰이크 UPGRADE_REQUIRED). */
    | "EXTENSION_OUTDATED"
    /** 서버에 닿지 못했다(네트워크·프록시·주소 오설정). */
    | "SERVER_UNREACHABLE"
    /** 로그인이 필요하거나 만료됐다. */
    | "NOT_AUTHENTICATED"
    /** 로그인은 됐지만 이 작업을 할 권한이 없다(예: 순수 STAFF 계정의 프리뷰 키 발급). */
    | "FORBIDDEN"
    /** 서버가 거절했다(4xx·5xx 일반). */
    | "SERVER_REJECTED"
    /** 이 폴더가 잘커라 사이트 소스로 보이지 않는다. */
    | "NOT_A_SITE"
    /** 의존성을 준비하지 못했다. */
    | "DEPENDENCIES_FAILED"
    /** 개발 서버가 뜨지 못했다. */
    | "DEV_SERVER_FAILED"
    /** 묶기(패킹)에 실패했다. */
    | "PACK_FAILED"
    /**
     * 사람이 취소했다. **오류로 보여 주지 않는다** — 사용자가 스스로 한 일을 실패로 고지하면
     * "내가 뭘 잘못했나"를 만든다. 호출자는 이 코드를 조용히 삼키고 상태만 되돌린다.
     */
    | "CANCELLED";
