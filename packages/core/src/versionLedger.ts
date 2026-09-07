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
 *   그래서 [LedgerSnapshot] 은 **무상한 조회의 결과만** 담고, 그 사실을 `complete` 리터럴 타입으로
 *   들고 다닌다 — 상한 페이지를 원장이라 부르는 코드는 컴파일이 안 된다.
 */
import {isVersionDigest} from "./sourceVersion.ts";

/** 원장 한 행 중 이 판정에 필요한 것만. */
export interface LedgerRow {
    revisionNo: number;
    versionDigest?: string | null;
}

/**
 * **무상한 조회로 받은** 원장 전량. `complete: true` 는 리터럴 타입이라 상한 페이지로는 만들 수 없다.
 * [askedAt] 은 이 목록을 받은 시각 — 켜진 판은 다른 창·콘솔·AI 가 바꿀 수 있어 화면이 낡을 수 있다.
 */
export interface LedgerSnapshot {
    tenant: string;
    revisions: readonly LedgerRow[];
    complete: true;
    askedAt: string;
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
 * 늘고 줄지 않으므로 이차 비용을 올리면 언젠가 반드시 도달한다(콘솔이 n=2,000 에서 112배를 실측했다).
 */
export function ledgerFacts(snapshot: LedgerSnapshot | null): LedgerFacts {
    if (snapshot === null) return EMPTY_FACTS;
    const rows = new Map<string, number[]>();
    const unknownNos: number[] = [];
    for (const r of snapshot.revisions) {
        if (!Number.isInteger(r.revisionNo)) continue;
        if (!isVersionDigest(r.versionDigest)) {
            unknownNos.push(r.revisionNo);
            continue;
        }
        const seen = rows.get(r.versionDigest);
        if (seen === undefined) rows.set(r.versionDigest, [r.revisionNo]);
        else seen.push(r.revisionNo);
    }
    for (const list of rows.values()) list.sort((a, b) => a - b);
    const lowestUnknown = unknownNos.length === 0 ? null : Math.min(...unknownNos);
    return {
        firstNo: (digest) => (isVersionDigest(digest) ? (rows.get(digest)?.[0] ?? null) : null),
        rowsOf: (digest) => (isVersionDigest(digest) ? (rows.get(digest) ?? []) : []),
        // 「작은 쪽보다 아래」다 — 같은 번호는 자기 자신이라 순서를 못 바꾼다.
        unknownBelow: (no) => lowestUnknown !== null && lowestUnknown < no,
        unknownCount: unknownNos.length,
    };
}
