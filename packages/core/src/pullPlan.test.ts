import assert from "node:assert/strict";
import test from "node:test";
import {planPull} from "./pullPlan.ts";

const f = (sha: string) => ({sha256: sha, bytes: 1});
const l = (sha: string) => ({sha256: sha});

test("🔴 서버가 지운 파일은 로컬에서도 지운다 — 안 지우면 다음 push 가 되살린다", () => {
    // ⚠ 이 조각의 존재 이유. 남으면 다음 push 에서 그 경로는 판에도 드래프트에도 없으니
    //   `effective = null` → 신설로 판정 → 서버도 `shaOf = null` → **정당하게 통과** → 부활한다.
    //   선행조건은 「지금 값이 내가 읽은 값인가」만 묻지 「지워진 적이 있는가」를 안 묻는다.
    const plan = planPull({
        incoming: {},
        ledger: {"app/gone.tsx": f("a")},
        local: {"app/gone.tsx": l("a")},
    });
    assert.deepEqual(plan.deletes, ["app/gone.tsx"]);
    assert.deepEqual(plan.conflicts, []);
});

test("서버가 지웠는데 내가 고쳐 뒀으면 충돌이다 — 조용히 지우지 않는다", () => {
    const plan = planPull({
        incoming: {},
        ledger: {"app/gone.tsx": f("a")},
        local: {"app/gone.tsx": l("내가-고침")},
    });
    assert.deepEqual(plan.deletes, []);
    assert.deepEqual(plan.conflicts, [{path: "app/gone.tsx", reason: "modified"}]);
});

test("🔴 무간섭은 «어느 매니페스트에도 없던» 파일뿐이다", () => {
    // 초안의 「겹치지 않는 경로는 무간섭」이 🔴2 를 만든 문장이다.
    const plan = planPull({
        incoming: {"app/page.tsx": f("b")},
        ledger: {"app/page.tsx": f("a")},
        local: {"app/page.tsx": l("a"), "내메모.txt": l("x")},
    });
    assert.deepEqual(plan.untracked, ["내메모.txt"], "순수 로컬이 아닌 것이 무간섭에 들어갔다");
    assert.deepEqual(plan.writes, ["app/page.tsx"]);
});

test("관용 1 — 이미 옮겨 놓은 파일이 자기 잔해로 스스로를 막지 않는다", () => {
    // 중단된 pull 이 남긴 상태. 로컬이 **받을 내용과 같으면** 덮어도 잃을 것이 없다.
    const plan = planPull({
        incoming: {"app/page.tsx": f("새것")},
        ledger: {"app/page.tsx": f("옛것")},
        local: {"app/page.tsx": l("새것")},
    });
    assert.deepEqual(plan.conflicts, [], "중단된 pull 이 재실행을 막았다");
    assert.deepEqual(plan.writes, ["app/page.tsx"]);
});

test("관용 1 은 신설 충돌에도 선다 — 재실행이 이어받는다", () => {
    const plan = planPull({
        incoming: {"app/new.tsx": f("새것")},
        ledger: {},
        local: {"app/new.tsx": l("새것")},
    });
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.unchanged, ["app/new.tsx"]);
});

test("로컬에 같은 이름을 내가 따로 만들어 뒀으면 충돌이다", () => {
    const plan = planPull({
        incoming: {"app/new.tsx": f("서버것")},
        ledger: {},
        local: {"app/new.tsx": l("내것")},
    });
    assert.deepEqual(plan.conflicts, [{path: "app/new.tsx", reason: "added-locally"}]);
    assert.deepEqual(plan.writes, []);
});

test("내가 지운 파일을 서버 판이 되살리려 하면 충돌이다 — 삭제도 작업이다", () => {
    const plan = planPull({
        incoming: {"app/page.tsx": f("a")},
        ledger: {"app/page.tsx": f("a")},
        local: {},
    });
    assert.deepEqual(plan.conflicts, [{path: "app/page.tsx", reason: "deleted-locally"}]);
    assert.deepEqual(plan.unchanged, []);
});

test("이미 지워졌고 서버도 지웠으면 아무 일도 아니다 — 멱등", () => {
    const plan = planPull({incoming: {}, ledger: {"app/gone.tsx": f("a")}, local: {}});
    assert.deepEqual(plan.deletes, []);
    assert.deepEqual(plan.conflicts, []);
});

test("서버가 안 바꾸고 나도 안 바꿨으면 안 건드린다", () => {
    const plan = planPull({
        incoming: {"app/page.tsx": f("a")},
        ledger: {"app/page.tsx": f("a")},
        local: {"app/page.tsx": l("a")},
    });
    assert.deepEqual(plan.unchanged, ["app/page.tsx"]);
    assert.deepEqual(plan.writes, []);
});

test("서버가 안 바꿨는데 내가 고쳤으면 충돌이다 — 내 작업을 조용히 덮지 않는다", () => {
    const plan = planPull({
        incoming: {"app/page.tsx": f("a")},
        ledger: {"app/page.tsx": f("a")},
        local: {"app/page.tsx": l("내가-고침")},
    });
    assert.deepEqual(plan.conflicts, [{path: "app/page.tsx", reason: "modified"}]);
    assert.deepEqual(plan.unchanged, []);
});
