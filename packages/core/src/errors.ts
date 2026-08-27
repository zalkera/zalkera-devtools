import { plainNotice } from "./notice.ts";

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
    /**
     * 서버가 보낸 `errorCode` 원문. **분기용이지 표시용이 아니다** — 보여 줄 때는 [humanMessage] 를 쓴다.
     *
     * 이것이 없으면 「동의하면 계속할 수 있다」는 거절과 「어떻게 해도 안 된다」는 거절을 호출부가
     * 구분하지 못한다. 서버가 "계속하려면 확인해 주세요"라고 적어 보내는데 확인할 자리가 없으면
     * 그 문장이 곧 막다른 길이 된다.
     */
    readonly serverCode: string | undefined;

    // 파라미터 프로퍼티(`constructor(readonly x)`)를 쓰지 않는다 — Node 의 타입 스트립 실행이 그 문법을
    // 받지 않아서, 쓰는 순간 테스트가 빌드 산출물을 거쳐야 한다(소스를 그대로 돌리는 이점이 사라진다).
    constructor(
        code: DevtoolsErrorCode,
        message: string,
        hint?: string,
        cause?: unknown,
        serverCode?: string,
    ) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "DevtoolsError";
        this.code = code;
        this.hint = hint;
        this.serverCode = serverCode;
    }

    /**
     * 사람에게 보여 줄 전체 문장(메시지 + 다음 할 일). **여기서 소독한다.**
     *
     * ⚠ 이 접근자의 이름이 곧 경계다 — 나가는 자리가 알림창인지 출력 채널인지는 이 클래스가
     *   모른다. 그래서 「알림에 닿기 전에 어딘가에서 소독됐겠지」에 기대지 않는다.
     *
     * 실제로 그 기대가 틀렸다(3회전 심의 실증): `safeWrite.ts`·`untar.ts` 는 **서버가 정한 zip·tar
     * 항목 이름**을 그대로 메시지에 보간하는데(`받은 파일이 폴더 밖을 가리킵니다: ${name}`),
     * 소독은 `api.ts` 의 응답 파싱 경로에만 있었다. 항목 이름이
     * `../[열기](command:workbench.action.terminal.new)` 이면 그 문장이 비-모달 알림에서
     * **누르면 명령이 도는 링크**가 됐다.
     *
     * 보간하는 자리를 열거해 고치면 다음에 생기는 자리가 또 샌다 — 이 레포가 두 번 겪은 형상이다.
     * 그래서 자리가 아니라 **나가는 문 하나**에서 한다. [message]·[hint] 원문은 그대로 남으므로
     * 로그·시험은 영향받지 않는다.
     */
    get humanMessage(): string {
        const body = plainNotice(this.message);
        return this.hint ? `${body}\n${plainNotice(this.hint)}` : body;
    }
}

export type DevtoolsErrorCode =
    /** 서버가 이 버전을 더 이상 받지 않는다(핸드셰이크 UPGRADE_REQUIRED). */
    | "EXTENSION_OUTDATED"
    /** 서버에 닿지 못했다(네트워크·프록시·주소 오설정). */
    | "SERVER_UNREACHABLE"
    /** 로그인이 필요하거나 만료됐다. */
    | "NOT_AUTHENTICATED"
    /** 로그인은 됐지만 이 작업을 할 권한이 없다(예: 순수 STAFF 계정의 미리보기 키 발급). */
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
    | "CANCELLED"
    /** 로컬 폴더가 다룰 수 있는 크기를 넘었다(사이트 폴더가 아닌 곳을 가리켰을 때가 대부분이다). */
    | "LOCAL_TOO_LARGE"
    /**
     * 받기가 **로컬 작업을 덮게 되어** 아무것도 하지 않았다(memo184 §2.2).
     *
     * ⚠ 실패가 아니라 **거절**이다. 이 코드가 뜬 뒤 폴더는 부르기 전과 같다.
     */
    | "PULL_WOULD_OVERWRITE"
    /** 로컬 장부(`.zalkera/sync.json`)가 없거나 읽을 수 없어 선행조건을 세울 수 없다. */
    | "LEDGER_UNKNOWN";
