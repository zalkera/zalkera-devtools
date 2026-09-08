/**
 * **원장이 말하는 사실**(memo191) — 판 지문 하나가 원장에서 **몇 번째로 처음 나타나는가**.
 *
 * ■ 왜 이 값이 방향을 정하나
 *   빌드 번호는 「언제 올렸나」만 말한다. 되돌리기를 하면 **새 번호에 옛 지문**이 붙으므로,
 *   번호로 새것/헌것을 가리면 되돌린 판에서 답이 뒤집힌다. 「내용이 원장에 처음 등장한 번호」로
 *   비교하면 그 함정을 지난다 — 콘솔이 같은 규칙을 먼저 세웠다(`sameSourceIndex`).
 *
 *   ```
 *   원장:  #3 A · #4 B · #5 A(켜짐)        로컬 = B
 *   번호로:  5 > 4  → 「서버가 더 최신」    ← 거짓
 *   내용으로: A 는 #3 · B 는 #4 → 4 > 3 → 「로컬이 더 최신」  ← 참
 *   ```
 *
 * ■ 🔴 **지문 없는 행이 순서를 뒤집는다**
 *   지문이 NULL 인 행은 이 지도에 안 들어간다. 그 행이 **더 작은 번호**에 있으면 「처음 등장」이
 *   실제보다 크게 잡혀 방향이 뒤집힌다:
 *   ```
 *   원장:  #1 NULL(실제 A) · #2 B · #3 A(켜짐)      로컬 = B
 *   보이는 대로: A 는 #3 · B 는 #2 → 「서버가 더 최신」
 *   진실:        A 는 #1        → 「로컬이 더 최신」   ← 뒤집혔다
 *   ```
 *   그래서 [unknownBelow] 로 **두 「처음 등장」 중 작은 쪽보다 아래에 모르는 행이 있는가**를 묻고,
 *   있으면 방향을 말하지 않는다. 작은 쪽 **위**의 NULL 은 어느 내용이어도 순서를 못 바꾸므로 막지 않는다
 *   (그것까지 막으면 지문 도입 전 판이 하나만 있어도 방향이 영영 안 뜬다).
 *
 * ■ **목록이 원장 전부여야 한다**
 *   상한을 건 페이지로 「처음 등장」을 세면 잘린 앞부분이 안 보여 같은 방식으로 거짓이 된다.
 *
 *   ⚠ **타입이 그것을 막지는 못한다.** `complete: true` 리터럴은 [LedgerSnapshot] 을 **만드는 자리**만
 *     제약하고, 부르는 쪽이 상한 페이지로 그 객체를 지어도 컴파일은 통과한다(심의 실측). 지금 서 있는
 *     것은 둘뿐이다 — 조회가 이름으로 갈라져 있어(`listRevisions()` vs `listRecentRevisions(limit)`)
 *     호출부에서 눈에 보이고, `check-wiring` 이 그 자리를 문다. **타입으로 막는 형태는 안 지었다.**
 */
import {plausibleRevisionNo} from "./localMark.ts";
import {isVersionDigest} from "./sourceVersion.ts";

/** 원장 한 행 중 이 판정에 필요한 것만. */
export interface LedgerRow {
    revisionNo: number;
    versionDigest?: string | null;
}

/**
 * **무상한 조회로 받은** 원장 전량. `complete: true` 는 「이 목록은 잘리지 않았다」는 **선언**이다 —
 * 타입이 검증하지는 않는다(위 KDoc).
 */
export interface LedgerSnapshot {
    tenant: string;
    revisions: readonly LedgerRow[];
    complete: true;
    /**
     * **이 목록을 받은 시각 — 화면에 그대로 실을 문자열이다.** 켜진 판은 다른 창·콘솔·AI 가 바꿀 수 있고
     * 이 캐시는 그 변화를 못 본다. 결론 낱말이 머리에 붙은 뒤로는 낡은 「일치」가 더 단정적으로 읽히므로
     * **언제 본 값인지**를 툴팁이 함께 말한다.
     *
     * ⚠ **판정이 시각을 스스로 만들지 않는다.** ISO 원문을 그대로 실으면 한국 사용자에게 UTC 를 보이고,
     *   여기서 지역화하면 시험이 **기계의 표준시에 따라 갈린다**. 형제 `home: homedir()` 과 같은 이유로
     *   부르는 쪽(확장)이 만들어 넘긴다.
     */
    askedAtLabel: string;
}

export interface LedgerFacts {
    /** 이 지문이 원장에 **처음 나타난** 판 번호. 모르면 `null`. */
    firstNo(digest: unknown): number | null;
    /** 이 지문이 나타난 모든 판 번호(오름차순). */
    rowsOf(digest: unknown): readonly number[];
    /** [no] 보다 **작은** 번호에 지문 없는 행이 있는가 — 있으면 방향을 말하면 안 된다. */
    unknownBelow(no: number): boolean;
    /** 지문 없는 행의 수(툴팁 설명용). */
    unknownCount: number;
}

/** 빈 원장 — 아무것도 모른다고 답한다(방향은 서지 않고 접미도 안 붙는다). */
export const EMPTY_FACTS: LedgerFacts = {
    firstNo: () => null,
    rowsOf: () => [],
    unknownBelow: () => true,
    unknownCount: 0,
};

/**
 * [snapshot] 에서 판정에 쓸 사실을 한 번에 접는다. 행마다 목록을 훑지 않는다 — 판은 발행할 때마다
 * 늘고 줄지 않으므로 이차 비용을 올리면 언젠가 반드시 도달한다(같은 형상을 콘솔 트랜치가 먼저 겪었다 ·
 * 그쪽 인용이라 이 레포에서 재현할 방법은 없다).
 *
 * 실측: n=100/1k/10k/50k/200k → 0.021/0.298/3.55/20.3/96.3 ms — **선형**(≈0.48 µs/행).
 * 재현: `ledgerFacts` 에 n행 스냅샷을 넣고 `performance.now()` 로 감싼다(`node --experimental-strip-types`).
 */
export function ledgerFacts(snapshot: LedgerSnapshot | null): LedgerFacts {
    if (snapshot === null) return EMPTY_FACTS;
    const rows = new Map<string, number[]>();
    let unknownCount = 0;
    // ⚠ **`Math.min(...배열)` 을 쓰지 않는다.** 원장은 **무상한·단조증가** 입력이고, 스프레드는 13만 행
    //   근처에서 `RangeError` 를 던져 **사이드바가 통째로 안 그려진다**(심의 실측: 125,000 통과 / 130,000 실패).
    //   접는 동안 최솟값을 들면 배열도 스프레드도 없어진다.
    let lowestUnknown: number | null = null;
    for (const r of snapshot.revisions) {
        // ⚠ 형제 `plausibleRevisionNo` 와 같은 잣대다 — 정수만으로는 `1e21` 이 통과해 「버전 1e+21」이 그려진다.
        if (!plausibleRevisionNo(r.revisionNo)) continue;
        if (!isVersionDigest(r.versionDigest)) {
            unknownCount++;
            if (lowestUnknown === null || r.revisionNo < lowestUnknown) lowestUnknown = r.revisionNo;
            continue;
        }
        const seen = rows.get(r.versionDigest);
        if (seen === undefined) rows.set(r.versionDigest, [r.revisionNo]);
        else seen.push(r.revisionNo);
    }
    for (const list of rows.values()) list.sort((a, b) => a - b);
    return {
        firstNo: (digest) => (isVersionDigest(digest) ? (rows.get(digest)?.[0] ?? null) : null),
        rowsOf: (digest) => (isVersionDigest(digest) ? (rows.get(digest) ?? []) : []),
        // 「작은 쪽보다 아래」다 — 같은 번호는 자기 자신이라 순서를 못 바꾼다.
        unknownBelow: (no) => lowestUnknown !== null && lowestUnknown < no,
        unknownCount,
    };
}
