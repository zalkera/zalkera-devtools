import {deepEqual, strictEqual} from "node:assert/strict";
import test from "node:test";
import {effectiveSha, planPush, type DraftView} from "./pushPlan.ts";

const f = (sha: string) => ({sha256: sha, bytes: 1});
const l = (sha: string) => ({sha256: sha});
const draft = (over: Partial<DraftView> = {}): DraftView => ({changed: [], deleted: [], ...over});

test("🔴 선행조건은 서버 «편집 → 판» 순으로 정해진다 — 장부가 아니다", () => {
    const base = {"a.tsx": f("판"), "b.tsx": f("판b")};
    const d = draft({changed: [{path: "a.tsx", sha256: "편집"}], deleted: ["b.tsx"]});
    strictEqual(effectiveSha(base, d, "a.tsx"), "편집", "편집이 판을 못 이겼다");
    strictEqual(effectiveSha(base, d, "b.tsx"), null, "편집의 삭제가 판을 못 이겼다");
    strictEqual(effectiveSha(base, d, "c.tsx"), null, "없는 것이 신설이 아니다");
});

test("작업본이 서버와 같으면 보낼 것이 없다 — 「이미 반영됨」은 여기서만 나온다", () => {
    const plan = planPush({
        base: {"a.tsx": f("판")},
        draft: draft({changed: [{path: "a.tsx", sha256: "편집"}]}),
        local: {"a.tsx": l("편집")},
    });
    deepEqual(plan.edits, []);
});

test("고친 것은 선행조건을 «서버가 준 값»으로 싣는다", () => {
    const plan = planPush({
        base: {"a.tsx": f("판")},
        draft: draft({changed: [{path: "a.tsx", sha256: "편집"}]}),
        local: {"a.tsx": l("내가-고침")},
    });
    deepEqual(plan.edits, [{path: "a.tsx", sha256: "내가-고침", baseSha256: "편집"}]);
});

test("신설은 선행조건이 `null` 이다", () => {
    const plan = planPush({base: {}, draft: draft(), local: {"새것.tsx": l("가")}});
    deepEqual(plan.edits, [{path: "새것.tsx", sha256: "가", baseSha256: null}]);
});

test("로컬에서 지운 것은 삭제로 보낸다", () => {
    const plan = planPush({base: {"a.tsx": f("판")}, draft: draft(), local: {}});
    deepEqual(plan.edits, [{path: "a.tsx", sha256: null, baseSha256: "판"}]);
});

test("서버도 지웠고 나도 없으면 보낼 것이 없다 — 멱등", () => {
    const plan = planPush({
        base: {"a.tsx": f("판")},
        draft: draft({deleted: ["a.tsx"]}),
        local: {},
    });
    deepEqual(plan.edits, []);
});

test("🔴 안 본 남의 편집을 되돌리는 경로를 짚는다 — 선행조건은 이것을 못 막는다", () => {
    // 내 작업본이 **판 그대로**다 = 그 편집을 본 적이 없다. 그런데 `baseSha256` 은 서버 조회에서
    // 나오므로 CAS 는 정당하게 통과하고, 남의 편집이 조용히 판 값으로 되돌아간다.
    const plan = planPush({
        base: {"a.tsx": f("판")},
        draft: draft({changed: [{path: "a.tsx", sha256: "남이-고침"}]}),
        local: {"a.tsx": l("판")},
    });
    deepEqual(plan.unseen, ["a.tsx"]);
    deepEqual(plan.edits, [{path: "a.tsx", sha256: "판", baseSha256: "남이-고침"}]);
});

test("🔴 남이 지운 것을 되살리는 경로도 짚는다", () => {
    const plan = planPush({
        base: {"a.tsx": f("판")},
        draft: draft({deleted: ["a.tsx"]}),
        local: {"a.tsx": l("판")},
    });
    deepEqual(plan.unseen, ["a.tsx"]);
});

test("내가 고쳤으면 «안 본 것»이 아니다 — 그것은 내 뜻이다", () => {
    const plan = planPush({
        base: {"a.tsx": f("판")},
        draft: draft({changed: [{path: "a.tsx", sha256: "남이-고침"}]}),
        local: {"a.tsx": l("내가-고침")},
    });
    deepEqual(plan.unseen, [], "내 편집을 남의 것으로 셌다");
    deepEqual(plan.edits, [{path: "a.tsx", sha256: "내가-고침", baseSha256: "남이-고침"}]);
});

test("편집을 이미 받아 둔 경로는 «안 본 것»이 아니다", () => {
    const plan = planPush({
        base: {"a.tsx": f("판")},
        draft: draft({changed: [{path: "a.tsx", sha256: "편집"}]}),
        local: {"a.tsx": l("편집"), "b.tsx": l("새것")},
    });
    deepEqual(plan.unseen, []);
    deepEqual(plan.edits, [{path: "b.tsx", sha256: "새것", baseSha256: null}]);
});

test("보낼 목록은 경로 순이다 — 같은 입력이 같은 요청을 만든다", () => {
    const plan = planPush({
        base: {},
        draft: draft(),
        local: {"c.tsx": l("가"), "a.tsx": l("나"), "b.tsx": l("다")},
    });
    deepEqual(plan.edits.map((e) => e.path), ["a.tsx", "b.tsx", "c.tsx"]);
});
