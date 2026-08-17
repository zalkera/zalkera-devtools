/**
 * **업데이트 안내를 띄울지 정하는 판정.** 순수 함수라 전수로 시험한다.
 *
 * ■ 왜 Marketplace 를 직접 조회하지 않나
 *   VS Code 가 이미 확장을 자동 업데이트하고, 꺼 둔 사용자에게는 확장 뷰에 배지를 띄운다. 그 위에
 *   우리 UI 를 얹으면 중복이고, **조회 실패·오프라인·사내망 프록시라는 새 실패 모드**를 스스로
 *   만든다. 대신 이미 있는 신호를 쓴다 — 핸드셰이크의 `verdict` 는 Marketplace 가 모르는 것을
 *   안다: *"이 버전으로는 계약이 안 맞는다."*
 *
 * ■ 왜 억제가 필요한가
 *   `ensureHandshake` 는 명령마다 불린다. 억제가 없으면 **창을 열 때마다, 명령을 누를 때마다**
 *   같은 알림이 뜬다. 같은 권고 버전은 하루 한 번만 말한다.
 *
 * ⚠ **`UPGRADE_REQUIRED` 는 여기 오지 않는다.** 그쪽은 핸드셰이크가 던져서 막고, 막는 것이 옳다 —
 *   안내를 더 얹을 자리가 아니다.
 */

/** 지난번에 무엇을, 언제 띄웠는가. 없으면 처음이다. */
export interface UpgradeNoticeState {
    version: string;
    shownAt: number;
}

/** 같은 권고 버전을 다시 말하기까지 기다리는 시간. */
export const UPGRADE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 권고 판 표기. **형태가 아니면 아무것도 하지 않는다.**
 *
 * ⚠ 이 값은 서버가 준다. 형태를 안 보면 10^6 자짜리도 그대로 저장되고, 매 응답마다 값을 바꾸면
 *   억제가 통째로 무력해진다(같은 값일 때만 억제하므로). 그리고 우리가 이 값을 **문장에 넣어**
 *   보여 주므로, 넣기 전에 우리가 아는 모양인지 확인해야 한다.
 */
const VERSION_SHAPE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

export function isUsableVersion(value: unknown): value is string {
    return typeof value === "string" && VERSION_SHAPE.test(value);
}

export function shouldShowUpgradeNotice(
    recommended: string | null | undefined,
    last: UpgradeNoticeState | null | undefined,
    now: number,
): boolean {
    if (!isUsableVersion(recommended)) return false;
    if (!last || typeof last.shownAt !== "number" || !Number.isFinite(last.shownAt)) return true;
    if (last.version !== recommended) return true; // 새 권고 버전은 즉시 말한다
    // ⚠ **미래에 띄운 기록은 「모름」으로 본다.** 스냅샷 복원·CMOS 방전으로 시계가 앞섰다가 고쳐지면,
    //   그 사이에 남은 기록이 그 권고 판을 **그 시각까지 영구 억제**한다.
    if (last.shownAt > now) return true;
    return now - last.shownAt >= UPGRADE_NOTICE_INTERVAL_MS;
}
