/**
 * **좌초한 편집을 어떻게 안내할지 정하는 순수 판정**(memo184 §2.5 · 🔴3 의 나머지 절반).
 *
 * ■ 왜 갈래가 둘인가
 *
 * 좌초(사이트 쪽 편집이 옛 판 위)는 되돌리기 말고 나갈 길이 없다. 그런데 **그 편집이 무엇인가**에
 * 따라 잃는 것이 완전히 다르다:
 *
 * - **내가 이 폴더에서 올린 것**이면 원본이 여기 그대로 있다 — 버려도 잃는 것이 없다.
 * - **여기 없는 편집**이면 그것이 **유일본**이다. 드래프트는 발행 전까지 판본이 없어 되찾을 길이 없다.
 *
 * 초안은 「로컬 원본이 있어 손실이 아니다」를 **무조건** 달았다. 그 문장이 사장님의 유일본을 지우게
 * 만드는 문장이다 — 그것이 🔴3 이다.
 *
 * ■ 「남의 드래프트」라고 쓰지 않는다
 *
 * 같은 사람이 콘솔과 이 도구를 둘 다 쓰면 그 말이 거짓이 된다. 문면은 **「여기 없는 편집」** —
 * 폴더 기준이라 언제나 참이다. 누가 고쳤는지는 서버가 답한다.
 *
 * ■ 모르면 안전한 쪽으로 접는다
 *
 * 문 조회 실패·장부 「모름」·세대 불일치는 전부 **B** 다. 「모른다」를 「내 것이다」로 바꾸지 않는다.
 */
import type {DraftFiles} from "./api.ts";
import type {SyncLedger} from "./syncLedger.ts";

export type StrandedVerdict =
    /** 이 폴더에서 올린 것과 같다 — 버려도 원본이 여기 있다. */
    | "mine"
    /** 여기 없는 편집이 섞여 있다 — 버리면 되찾을 방법이 없다. */
    | "elsewhere";

export interface StrandedInput {
    /** 로컬 장부. 없거나 깨졌으면 `null`. */
    ledger: SyncLedger | null;
    /** `GET /draft/files` 응답. **못 읽었으면 `null`.** */
    draft: DraftFiles | null;
}

export interface StrandedPlan {
    verdict: StrandedVerdict;
    /** 사이트 쪽 편집이 담고 있는 경로들(바뀐 것 + 지운 것). 사람에게 보여 줄 목록이다. */
    paths: string[];
    /** 왜 그렇게 판정했는지 — 문면이 아니라 **기계가 읽는 사유**다. */
    reason:
        | "ledger-matches"
        | "no-ledger"
        | "server-unreadable"
        | "generation-differs"
        | "path-not-mine"
        | "sha-differs";
}

/**
 * 좌초 안내를 정한다.
 *
 * 판정 A(「내 것」)의 조건은 **셋 다** 참이어야 한다(§2.5 표):
 * ⑴ 드래프트의 모든 경로가 `mine` 에 있고 ⑵ 각 sha 가 `mine` 값과 같고 ⑶ 세대가 장부의 것과 같다.
 *
 * ⚠ ⑶이 빠지면 「내가 올린 뒤 남이 더 얹은」 경우가 A 로 접힌다 — 그때 남의 편집이 함께 사라진다.
 */
export function planStranded(input: StrandedInput): StrandedPlan {
    const {ledger, draft} = input;
    if (!draft) return {verdict: "elsewhere", paths: [], reason: "server-unreadable"};

    const paths = [...draft.changed.map((row) => row.path), ...draft.deleted].sort();
    if (!ledger) return {verdict: "elsewhere", paths, reason: "no-ledger"};

    const seen = ledger.server?.generation ?? null;
    if (seen === null || seen !== (draft.generation ?? null)) {
        return {verdict: "elsewhere", paths, reason: "generation-differs"};
    }

    for (const path of draft.deleted) {
        if (!Object.hasOwn(ledger.mine, path)) return {verdict: "elsewhere", paths, reason: "path-not-mine"};
        // 내가 올린 삭제는 `null` 로 적힌다. 값이 있으면 내가 올린 것은 **삭제가 아니었다.**
        if (ledger.mine[path] !== null) return {verdict: "elsewhere", paths, reason: "sha-differs"};
    }
    for (const row of draft.changed) {
        if (!Object.hasOwn(ledger.mine, row.path)) {
            return {verdict: "elsewhere", paths, reason: "path-not-mine"};
        }
        if (ledger.mine[row.path] !== row.sha256) {
            return {verdict: "elsewhere", paths, reason: "sha-differs"};
        }
    }
    return {verdict: "mine", paths, reason: "ledger-matches"};
}
