/**
 * **오류 하나를 화면에 어떻게 낼 것인가.**
 *
 * ■ 왜 core 인가
 *   이 판정은 확장의 `register()` 안에 살았다 — 시험도 검사기도 못 닿는 자리다. 실측으로 「취소는
 *   오류가 아니다」 갈래를 통째로 지워도 시험 전건이 초록이었다. 그런데 그 갈래가 없으면 **사용자가
 *   스스로 그만둔 일**이 빨간 창으로 뜬다: 로그인 창을 닫았을 뿐인데 「인터넷·사내망 프록시를
 *   확인해 주세요」를 본다(실사용 신고로 한 번 난 형상이다).
 *
 * ■ 두 갈래가 하는 일이 다르다
 *   · 취소 — 출력 채널에만 남긴다. **무슨 일이 있었는지는 보여야 하지만** 사람을 불러 세우지 않는다.
 *   · 오류 — 출력에 원문을 남기고, 알림에는 **소독한 것**을 낸다. 원문은 근거이고 알림은 표시다.
 *
 * ■ 알림에 나갈 것은 여기서 소독한다
 *   비-모달 알림은 `[글](command:…)` 를 누를 수 있는 링크로 렌더한다. `humanMessage` 가 소독을
 *   지났다고 **가정하지 않는다** — 실제로 그 가정이 틀려서 서버가 정한 아카이브 항목 이름이
 *   알림에 그대로 실린 적이 있다. `String(error)` 갈래도 안전하지 않다(`JSON.parse` 실패 메시지는
 *   입력 조각을 담는다).
 */
import { DevtoolsError } from "./errors.ts";
import { plainNotice } from "./notice.ts";

/**
 * **사람이 스스로 그만둔 것인가.**
 *
 * 뜻이 둘인 판정이라 자리마다 사본이 생기기 쉽다:
 *   · **표시** — 오류 창을 띄울 것인가([decideErrorNotice] 가 쓴다).
 *   · **흐름** — 이 실패를 삼키고 조용히 되돌릴 것인가(호출부가 쓴다).
 * 둘은 다른 질문이지만 **같은 사실**을 본다. 사실을 여기 하나로 두고, 그 사실로 각자 답한다.
 *
 * ⚠ **문면으로 판정하지 않는다.** 서버가 「취소」라는 낱말 하나로 오류를 감출 수 있게 된다.
 */
export function isCancelled(error: unknown): boolean {
    return error instanceof DevtoolsError && error.code === "CANCELLED";
}

export interface ErrorNotice {
    /** `cancelled` 면 알림을 띄우지 않는다. */
    kind: "cancelled" | "error";
    /** 출력 채널 줄머리. 「취소」와 「오류」는 사람에게 뜻이 다르다. */
    logPrefix: string;
    /**
     * 출력 채널에 남길 **원문**. 소독하지 않는다 — 출력은 링크를 렌더하지 않고, 여기가 근거다.
     *
     * ⚠ **이 값을 알림에 넣지 마라.** 넣을 것은 [message] 다. 두 값을 한 문장으로 합치면
     *   그 문장이 어디로 나가는지 이 파일이 알 수 없게 되고, 그러면 소독 검사도 못 본다.
     */
    raw: string;
    /** 알림에 낼 본문. **소독을 지났다.** 취소 갈래에서는 빈 문자열이다. */
    message: string;
}

/** 이 오류를 어떻게 낼지 정한다. */
export function decideErrorNotice(error: unknown): ErrorNotice {
    const body = error instanceof DevtoolsError ? error.humanMessage : String(error);
    if (isCancelled(error)) {
        return { kind: "cancelled", logPrefix: "취소", raw: body, message: "" };
    }
    return { kind: "error", logPrefix: "오류", raw: body, message: plainNotice(body) };
}
