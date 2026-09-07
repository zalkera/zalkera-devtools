/**
 * **판 지문이 백엔드와 같은 답을 내는가**(memo191).
 *
 * 기대값은 우리가 만들지 않았다 — `version-digest-vectors.json` 은 백엔드 레포의
 * `libs/core/src/test/resources/version-digest-vectors.json` 사본이고, 그 값은 **명세 문장만 보고 쓴
 * 독립 구현**이 냈다. 그래서 이 파일이 두 언어의 계약이다.
 *
 * ⚠ **이 벡터가 드리프트의 전부를 막지는 못한다.** 백엔드가 규칙을 바꾸고 벡터를 다시 만들어도 이쪽
 *   사본은 낡은 채로 조용히 초록이다. 진짜 그물은 **발행 직후 예측과 서버 답을 대조하는 것**이다
 *   (`sourceVersion.ts` 머리말).
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {
    compareVersions,
    shortVersion,
    sourceVersionDigest,
    unwrapSingleRoot,
    VERSION_DIGEST_SHORT,
    VERSION_RULE_TAG,
} from "./sourceVersion.ts";

interface Vector {
    name: string;
    why: string;
    entries: {path: string; contentSha256: string}[];
    digest: string | null;
}

const vectors: {cases: Vector[]; ruleTag: string} = JSON.parse(
    readFileSync(join(import.meta.dirname, "version-digest-vectors.json"), "utf8"),
);

const entriesOf = (c: Vector) => c.entries.map((e) => ({path: e.path, sha256: e.contentSha256}));
const vector = (name: string): Vector => {
    const found = vectors.cases.find((c) => c.name === name);
    assert.ok(found, `벡터 '${name}' 이 없다`);
    return found;
};

test("골든 벡터 전량이 맞는다", () => {
    // 파일이 잘리거나 비면 아래 루프가 조용히 0건을 돈다 — 그 자리를 막는 하한.
    assert.ok(vectors.cases.length >= 8, `벡터가 ${vectors.cases.length}건뿐이다`);
    let checked = 0;
    for (const c of vectors.cases) {
        assert.equal(sourceVersionDigest(entriesOf(c)), c.digest, `벡터 '${c.name}' 이 어긋난다`);
        checked += 1;
    }
    assert.equal(checked, vectors.cases.length);
});

test("규칙 태그가 백엔드와 같다", () => {
    assert.equal(VERSION_RULE_TAG, vectors.ruleTag);
});

/**
 * 🔴 **정렬 축이 load-bearing 임을 깨뜨려 확인한다.** JS 기본 정렬(UTF-16 코드유닛)로 같은 입력을
 * 접으면 골든 벡터와 **다른 값**이 나와야 한다. 같으면 이 벡터가 그 축을 못 짚는다는 뜻이라
 * 시험 전체가 거짓 안심이 된다.
 */
test("JS 기본 정렬로는 같은 답이 안 나온다 — 벡터가 정렬 축을 짚는다", () => {
    const c = vector("supplementary-order");
    const entries = entriesOf(c);
    assert.equal(sourceVersionDigest(entries), c.digest);

    const hash = createHash("sha256");
    hash.update(`${VERSION_RULE_TAG}\n`, "utf8");
    for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        hash.update(`${e.path}\n${e.sha256.toLowerCase()}\n`, "utf8");
    }
    assert.notEqual(hash.digest("hex"), c.digest, "UTF-16 정렬이 같은 답을 냈다 — 벡터를 갈아야 한다");
});

test("빈 목록은 지문이 없다 — 모름이지 같음이 아니다", () => {
    assert.equal(sourceVersionDigest([]), null);
});

test("입력 순서를 뒤집어도 같다", () => {
    assert.equal(
        sourceVersionDigest(entriesOf(vector("two-sorted"))),
        sourceVersionDigest(entriesOf(vector("two-reversed"))),
    );
});

test("내용 해시 대소문자는 접는다", () => {
    assert.equal(
        sourceVersionDigest(entriesOf(vector("single"))),
        sourceVersionDigest(entriesOf(vector("uppercase-content-hash"))),
    );
});

// ── 언랩 ─────────────────────────────────────────────────────────────────────

test("최상위 폴더 하나면 벗긴다", () => {
    assert.deepEqual(unwrapSingleRoot(["mysite/index.html", "mysite/a/b.css"]), ["index.html", "a/b.css"]);
});

test("두 겹도 벗긴다", () => {
    assert.deepEqual(unwrapSingleRoot(["o/m/index.html", "o/m/a.css"]), ["index.html", "a.css"]);
});

test("뿌리에 파일이 있으면 안 벗긴다 — 그 자리가 루트다", () => {
    const paths = ["index.html", "assets/a.css"];
    assert.deepEqual(unwrapSingleRoot(paths), paths);
});

test("최상위 폴더가 둘이면 안 벗긴다", () => {
    const paths = ["a/x.txt", "b/y.txt"];
    assert.deepEqual(unwrapSingleRoot(paths), paths);
});

test("무한히 벗기지 않는다 — 상한이 있다", () => {
    const deep = "a/".repeat(20) + "x.txt";
    const left = unwrapSingleRoot([deep]);
    assert.equal(left[0], "a/".repeat(12) + "x.txt", "8겹까지만 벗겨야 한다");
});

test("감싼 폴더와 안 감싼 폴더는 같은 판이다", () => {
    const fold = (paths: string[]) => {
        const unwrapped = unwrapSingleRoot(paths);
        return sourceVersionDigest(paths.map((_, i) => ({path: unwrapped[i]!, sha256: "aa".repeat(32)})));
    };
    assert.equal(fold(["index.html", "a/b.css"]), fold(["mysite/index.html", "mysite/a/b.css"]));
});

test("래퍼 경로를 안 벗기면 다른 판이 된다 — 언랩이 규칙의 일부인 근거", () => {
    assert.notEqual(vector("single").digest, vector("wrapped-path").digest);
});

// ── 표기·판정 ────────────────────────────────────────────────────────────────

/**
 * ⚠ **폭을 상수로 재지 않는다.** 상수를 양변에 쓰면 8→12 로 바꿔도 초록이다(백엔드에서 변이로 실측).
 * 이 폭은 콘솔과 이 확장이 **같아야 하는 계약**이라 리터럴로 못박는다.
 */
test("축약은 앞 8자다", () => {
    assert.equal(shortVersion(vector("single").digest), "18704c64");
    assert.equal(VERSION_DIGEST_SHORT, 8, "표시 폭 계약이 바뀌었다");
});

test("모름은 축약해도 모름이다", () => {
    assert.equal(shortVersion(null), null);
    assert.equal(shortVersion(undefined), null);
    // 잘린 값을 넘기면 「짧은 지문」을 지어내지 않는다.
    assert.equal(shortVersion("abc"), null);
});

test("한쪽이라도 모르면 판정은 모름이다 — 다름이 아니다", () => {
    const a = "aa".repeat(32);
    assert.equal(compareVersions(a, null), "unknown");
    assert.equal(compareVersions(null, a), "unknown");
    assert.equal(compareVersions(null, null), "unknown");
    assert.equal(compareVersions(a, a), "same");
    assert.equal(compareVersions(a, "bb".repeat(32)), "differs");
});

/**
 * 🔴 **서버가 정하는 값이라 형이 보장되지 않는다.** 종전 판은 `slice` 를 바로 불러 숫자·불린·객체에
 * `TypeError` 를 던졌고, 그 예외가 트리 `getChildren` 까지 올라가 **사이드바 전체가 안 그려졌다**.
 */
test("지문이 문자열이 아니면 모름이다 — 던지지 않는다", () => {
    for (const bad of [12345678, true, {}, ["a"], 0, Number.NaN]) {
        assert.equal(shortVersion(bad), null, `${JSON.stringify(bad)} 에서 값을 지어냈다`);
        assert.equal(compareVersions(bad, "aa".repeat(32)), "unknown");
        assert.equal(compareVersions("aa".repeat(32), bad), "unknown");
    }
});

test("빈 문자열도 모름이다 — 둘 다 빈 값이면 「같음」이 되던 자리", () => {
    assert.equal(compareVersions("", ""), "unknown");
});
