/**
 * [ledgerFacts] · [judgePackingGap] · [baselineOf] — 방향 판정의 재료(memo191).
 *
 * 사이드바 시험이 화면을 재는 자리라면, 여기는 **그 화면이 딛고 선 사실**을 잰다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {baselineOf, parseSourceMark} from "./localMark.ts";
import {judgePackingGap} from "./publish.ts";
import {ledgerFacts, type LedgerSnapshot} from "./versionLedger.ts";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const snap = (...rows: [number, string | null][]): LedgerSnapshot => ({
    tenant: "credium",
    revisions: rows.map(([revisionNo, versionDigest]) => ({revisionNo, versionDigest})),
    complete: true,
    askedAt: "2026-09-07T03:00:00Z",
});

test("처음 등장한 번호를 든다 — 마지막이 아니라", () => {
    const f = ledgerFacts(snap([3, A], [5, A], [7, A]));
    assert.equal(f.firstNo(A), 3);
    assert.deepEqual(f.rowsOf(A), [3, 5, 7]);
    // 양성 짝 — 없는 지문은 null(위 값이 우연히 맞은 것이 아니다).
    assert.equal(f.firstNo(B), null);
});

/** 입력 순서에 기대지 않는다 — 서버 목록 정렬이 뒤집혀도 「처음」은 같다. */
test("행 순서가 뒤집혀도 처음 등장 번호는 같다", () => {
    assert.equal(ledgerFacts(snap([7, A], [3, A], [5, A])).firstNo(A), 3);
});

/**
 * 🔴 **지문이 아닌 값은 지도에 안 들어간다.** 들어가면 `"abc"` 두 행이 서로 같다고 접혀,
 * 지문 도입 전 판 전부가 서로 같다고 말하게 된다.
 */
test("지문 모양이 아닌 값은 모름으로 센다", () => {
    const f = ledgerFacts(snap([1, "abc"], [2, null], [3, A]));
    assert.equal(f.firstNo("abc"), null);
    assert.equal(f.unknownCount, 2);
    assert.equal(f.firstNo(A), 3, "진짜 지문은 그대로 잡혀야 한다");
});

/**
 * 🔴 **「작은 쪽보다 아래」만 막는다.** 위쪽 NULL 까지 막으면 지문 없는 옛 판이 하나만 있어도
 * 방향이 영영 안 뜬다 — 소급 전 상용이 정확히 그 상태다.
 */
test("모르는 행이 아래에 있을 때만 방향을 막는다", () => {
    const f = ledgerFacts(snap([1, null], [2, B], [3, A]));
    assert.equal(f.unknownBelow(2), true, "#1 이 #2 보다 아래인데 안 막았다");
    assert.equal(f.unknownBelow(1), false, "같은 번호는 자기 자신이라 순서를 못 바꾼다");
    // 양성 짝 — 모르는 행이 없으면 어디서도 안 막는다.
    assert.equal(ledgerFacts(snap([1, B], [3, A])).unknownBelow(3), false);
});

test("원장이 없으면 아무것도 모른다고 답한다", () => {
    const f = ledgerFacts(null);
    assert.equal(f.firstNo(A), null);
    assert.equal(f.unknownBelow(1), true, "모르면 막아야 한다 — 열어 두면 없는 방향을 말한다");
});

/**
 * 🔴 **모름을 「같음」으로 접지 않는다.** 구서버는 지문을 안 보내고, 빈 폴더는 예측이 없다 —
 * 둘 다 「대조 못 했다」이지 「맞았다」가 아니다. 접으면 갈린 포장이 조용해진다.
 */
test("포장 갭 판정의 네 값이 갈린다", () => {
    assert.equal(judgePackingGap(A, A), "match");
    assert.equal(judgePackingGap(A, B), "gap");
    assert.equal(judgePackingGap(A, undefined), "server-silent");
    assert.equal(judgePackingGap(A, null), "server-silent");
    assert.equal(judgePackingGap(null, A), "local-unknown");
});

/** 기준점은 **도구 판이 같을 때만** 쓴다 — 포장 규칙은 판올림 때 태그 없이 바뀐다. */
test("도구 판이 다르면 기준점을 안 쓴다", () => {
    const text = JSON.stringify({
        format: 1, tenant: "credium", revisionNo: 4, sha256: "x", fetchedAt: "t",
        folderVersion: A, serverVersion: A, tool: "0.27.0",
    });
    const mark = parseSourceMark(text);
    assert.equal(baselineOf(mark, "0.28.0"), null, "낡은 판이 접은 값을 오늘 값과 견줬다");
    // 양성 짝 — 같은 판이면 값이 나온다.
    assert.deepEqual(baselineOf(mark, "0.27.0"), {revisionNo: 4, folderVersion: A, serverVersion: A});
});

/**
 * 🔴 **깨진 칸은 버리되 표식은 살린다.** 표식은 폴더에 있고 사람이 고칠 수 있다 — 한 칸이 이상하다고
 * 소속까지 잃으면 폴더가 무소속이 되거나 남의 사이트로 보인다.
 */
test("기준점 칸이 깨져도 소속은 살아 있다", () => {
    const mark = parseSourceMark(JSON.stringify({
        format: 1, tenant: "credium", revisionNo: 4, sha256: "x", fetchedAt: "t",
        folderVersion: "손으로 고친 값", tool: "0.27.0",
    }));
    assert.equal(mark?.tenant, "credium", "소속까지 잃었다");
    assert.equal(baselineOf(mark, "0.27.0"), null, "깨진 값을 기준점으로 썼다");
});

/** `linked` 는 판 칸이 없다 — 소속만 아는 폴더는 기준점을 가질 수 없다. */
test("연결 표식은 기준점이 되지 않는다", () => {
    const mark = parseSourceMark(JSON.stringify({format: 2, origin: "linked", tenant: "credium", linkedAt: "t"}));
    assert.equal(baselineOf(mark, "0.27.0"), null);
});
