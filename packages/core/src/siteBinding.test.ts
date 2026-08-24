import assert from "node:assert/strict";
import test from "node:test";
import {
  decideFetchTargetPlan,
  decidePickedFolder,
  decideSiteChoice,
  decideTenantScope,
  elsewhereOptions,
  folderBinding,
  needsRelinkConsent,
} from "./siteBinding.ts";
import type { SourceMark } from "./localMark.ts";

const FETCHED: SourceMark = {
  format: 1,
  tenant: "alpha",
  revisionNo: 3,
  sha256: "abc",
  fetchedAt: "2026-08-21T00:00:00.000Z",
};

test("소속은 표식이 이긴다 — 링크는 덮인 적이 있는 자리다", () => {
  // 이 서열이 뒤집히면 어긋난 폴더에서 오염된 링크가 이겨 게이트가 눈을 감는다.
  assert.equal(folderBinding(FETCHED, "beta"), "alpha");
  assert.equal(folderBinding(null, "beta"), "beta");
  assert.equal(folderBinding(null, null), null);
  // 빈 문자열은 「안 적었다」다 — 소속으로 세면 없는 소속이 생긴다.
  assert.equal(folderBinding(null, ""), null);
});

test("쓰기 범위 — 폴더 없는 창은 전역", () => {
  assert.equal(
    decideTenantScope({ siteFolderOpen: false, binding: null, chosen: "alpha" }),
    "global",
  );
});

test("쓰기 범위 — 소속 없는 소스 폴더는 입양된다", () => {
  assert.equal(
    decideTenantScope({ siteFolderOpen: true, binding: null, chosen: "alpha" }),
    "workspace",
  );
});

test("쓰기 범위 — 소속과 같으면 워크스페이스(어긋난 링크의 복원 경로)", () => {
  assert.equal(
    decideTenantScope({ siteFolderOpen: true, binding: "alpha", chosen: "alpha" }),
    "workspace",
  );
});

test("쓰기 범위 — 소속이 다르면 **아무것도 적지 않는다**", () => {
  // ⚠ 이 행이 "global" 로 퇴행하면 교차 업로드가 되살아난다. 전역의 그 값은 이 창에서는 죽은
  //   값이지만, 표식도 링크도 없는 폴더를 여는 순간 그 창의 유효 사이트가 된다 — 그런 폴더에는
  //   게이트가 설 근거가 없어(표식 부재로는 안 막는다) 그대로 발행이 나간다.
  assert.equal(
    decideTenantScope({ siteFolderOpen: true, binding: "alpha", chosen: "beta" }),
    "none",
  );
});

test("제안 — 확증 못 한 로컬본은 열기로 내주지 않는다", () => {
  // 확증 없이 열어 주면, 경로가 재활용돼 다른 사이트를 담게 된 폴더를 「그 사이트 폴더」로
  // 내주게 된다 — 이 설계가 막으려는 바로 그 사고다. 판정 자리는 elsewhereOptions 로 옮겼고,
  // 확증은 그 입력(`confirmedDir`)이 진다.
  const { options } = elsewhereOptions({ confirmedDir: null, fetchable: "yes" });
  assert.ok(!options.some((o) => o.kind === "open"), JSON.stringify(options));
});

test("제안 — 소속이 없으면 입양, 같으면 그냥 전환", () => {
  assert.deepEqual(
    decideSiteChoice({
      picked: "alpha",
      binding: null,
      siteFolderOpen: true,
      current: "beta",
    }),
    { kind: "adopted" },
  );
  assert.deepEqual(
    decideSiteChoice({
      picked: "alpha",
      binding: "alpha",
      siteFolderOpen: true,
      current: "beta",
    }),
    { kind: "switched" },
  );
  // 폴더가 없으면 덮을 소속도 없다 — 오늘의 동작 그대로.
  assert.deepEqual(
    decideSiteChoice({
      picked: "alpha",
      binding: null,
      siteFolderOpen: false,
      current: "beta",
    }),
    { kind: "switched" },
  );
});

test("재연결 동의는 소속이 있고 다를 때만 받는다", () => {
  // 소속 없는 폴더에까지 모달을 띄우면, 처음 연결하는 흔한 일이 경고가 된다.
  assert.equal(needsRelinkConsent(null, "alpha"), false);
  assert.equal(needsRelinkConsent("alpha", "alpha"), false);
  assert.equal(needsRelinkConsent("alpha", "beta"), true);
});

test("소스 아닌 폴더에 구판 링크가 남아 있어도 전역을 더럽히지 않는다", () => {
  // 구판은 소스 아닌 폴더에도 링크를 적었다. 폴더 유무를 먼저 보면 이 창은 전역에 적히는데,
  // 병합 조회는 그 링크가 이겨 — 토스트는 「y」, 실동작(이력·버전 전환)은 x 가 된다.
  assert.equal(
    decideTenantScope({ siteFolderOpen: false, binding: "x", chosen: "y" }),
    "none",
  );
  // 같은 사이트면 그대로 확정한다(복원 경로).
  assert.equal(
    decideTenantScope({ siteFolderOpen: false, binding: "x", chosen: "x" }),
    "workspace",
  );
  // 소속이 아예 없는 폴더 없는 창은 오늘처럼 전역이다.
  assert.equal(
    decideTenantScope({ siteFolderOpen: false, binding: null, chosen: "y" }),
    "global",
  );
});

// ── 아무것도 안 바뀐 것을 안 바뀌었다고 말하는가 ──────────────────────────

test("이미 그 사이트면 unchanged — 「바꿨습니다」는 거짓이다", () => {
  for (const siteFolderOpen of [false, true]) {
    const choice = decideSiteChoice({
      picked: "alpha",
      binding: siteFolderOpen ? "alpha" : null,
      siteFolderOpen,
      current: "alpha",
    });
    assert.deepEqual(choice, { kind: "unchanged" }, `siteFolderOpen=${siteFolderOpen}`);
  }
});

test("어긋난 창에서 자기 사이트를 고르면 switched — 복원이 실제로 일어난다", () => {
  // 표식은 alpha 인데 링크 잔재로 유효 사이트가 beta 인 창. alpha 를 고르면 링크가 표식에
  // 맞춰지므로 **실제로 바뀐다** — 여기서 unchanged 로 접으면 복원 사실을 숨긴다.
  assert.deepEqual(
    decideSiteChoice({ picked: "alpha", binding: "alpha", siteFolderOpen: true, current: "beta" }),
    { kind: "switched" },
  );
});

test("소속이 다르면 elsewhere — 로컬본을 알든 모르든 갈래는 하나다", () => {
  // 종전에는 `offer` 로 접혀 선택지가 하나뿐이었다. 무엇을 낼지는 elsewhereOptions 가 정한다.
  assert.deepEqual(
    decideSiteChoice({ picked: "beta", binding: "alpha", siteFolderOpen: true, current: "alpha" }),
    { kind: "elsewhere" },
  );
});

// ── 실패를 약속하지 않는가 ─────────────────────────────────────────────────

test("받을 판이 없으면 **받기를 안 낸다** — 누르면 반드시 실패하는 항목이다", () => {
  const { options, note } = elsewhereOptions({ confirmedDir: null, fetchable: "no-revision" });
  assert.ok(!options.some((o) => o.kind === "fetch"), JSON.stringify(options));
  assert.equal(note, "no-revision");
  // 판 없는 사이트로 옮기는 흔한 형상은 zip 입고다 — 그때만 앞에 선다.
  assert.equal(options[0]?.kind, "import-zip");
});

test("조회에 실패했으면 받기를 **남긴다** — 모르는 것으로 막지 않는다", () => {
  // `none` 과 뭉개면 서버가 잠시 흔들린 것으로 정상 경로가 사라진다.
  const { options, note } = elsewhereOptions({ confirmedDir: null, fetchable: "unknown" });
  assert.ok(options.some((o) => o.kind === "fetch"), JSON.stringify(options));
  assert.equal(note, null);
});

test("확증된 로컬본이 있으면 **열기가 첫 항목** — 순서가 곧 권고다", () => {
  const { options } = elsewhereOptions({ confirmedDir: "/w/alpha", fetchable: "yes" });
  assert.deepEqual(options[0], { kind: "open", dir: "/w/alpha" });
  assert.deepEqual(
    options.map((o) => o.kind),
    ["open", "fetch", "pick-folder", "import-zip"],
  );
});

test("어느 조합에서도 선택지가 비지 않는다 — 막다른 길을 만들지 않는다", () => {
  for (const confirmedDir of [null, "/w/alpha"]) {
    for (const fetchable of ["yes", "no-revision", "no-ready", "unknown"] as const) {
      const { options } = elsewhereOptions({ confirmedDir, fetchable });
      assert.ok(options.length > 0, `${confirmedDir}/${fetchable}`);
      // 직접 고르기와 zip 은 서버 상태와 무관하게 늘 선다.
      assert.ok(options.some((o) => o.kind === "pick-folder"), `${confirmedDir}/${fetchable}`);
      assert.ok(options.some((o) => o.kind === "import-zip"), `${confirmedDir}/${fetchable}`);
    }
  }
});

// ── 직접 고른 폴더 ─────────────────────────────────────────────────────────

test("남의 사이트 소스는 **열지 않는다** — 재활용 경로를 내주지 않는 것과 같은 잣대", () => {
  assert.deepEqual(decidePickedFolder("beta", "alpha"), { kind: "refuse", bound: "beta" });
});

test("소속 없는 폴더는 동의를 받고 소속을 처음 준다 — 재연결이 아니다", () => {
  assert.deepEqual(decidePickedFolder(null, "alpha"), { kind: "link-consent" });
});

test("그 사이트의 소스면 동의 없이 연다 — 복원이다", () => {
  assert.deepEqual(decidePickedFolder("alpha", "alpha"), { kind: "open" });
});

test("**소속을 바꾸는 갈래가 없다** — 재연결은 「사이트에 연결」 하나로 남는다", () => {
  // 이 함수가 소속 있는 폴더를 열어 주기 시작하면 사이트 선택이 재연결 표면이 된다.
  const kinds = new Set(
    [null, "alpha", "beta"].map((b) => decidePickedFolder(b, "alpha").kind),
  );
  assert.deepEqual([...kinds].sort(), ["link-consent", "open", "refuse"]);
});

// ── 받을 자리의 첫 제안 ────────────────────────────────────────────────────

test("열어 둔 빈 폴더가 첫 제안 — 이미 고른 자리를 다시 묻지 않는다", () => {
  assert.deepEqual(
    decideFetchTargetPlan({ openDir: "/w/empty", openDirReceivable: true, siteFolderOpen: false }),
    { kind: "here", dir: "/w/empty" },
  );
});

test("소스 폴더에는 안 푼다 — 열려 있는 소스를 덮어쓰지 않는다", () => {
  // 소스 폴더가 마침 「빈 것으로」 재어져도 옆으로 간다. 이 우선순위가 뒤집히면 덮어쓴다.
  assert.deepEqual(
    decideFetchTargetPlan({ openDir: "/w/site", openDirReceivable: true, siteFolderOpen: true }),
    { kind: "sibling" },
  );
});

test("빈 폴더가 아니면 제안하지 않는다 — 남의 파일 위에 풀지 않는다", () => {
  assert.deepEqual(
    decideFetchTargetPlan({ openDir: "/w/docs", openDirReceivable: false, siteFolderOpen: false }),
    { kind: "pick-only" },
  );
  assert.deepEqual(
    decideFetchTargetPlan({ openDir: null, openDirReceivable: false, siteFolderOpen: false }),
    { kind: "pick-only" },
  );
});

// ── 두 판정이 같은 것을 보는가 ─────────────────────────────────────────────

test("decideSiteChoice 와 decideTenantScope 가 **전 칸에서** 어긋나지 않는다", () => {
  // 「화면은 y 라고 말하는데 아무것도 안 적힌다」가 이 축의 오래된 실패다. 두 함수가 소속을
  // 보는 순서를 달리하면 그 형상이 조용히 되살아난다 — 전수로 잠근다.
  for (const siteFolderOpen of [false, true]) {
    for (const binding of [null, "alpha", "beta"]) {
      for (const current of ["alpha", "beta", ""]) {
        const choice = decideSiteChoice({ picked: "alpha", binding, siteFolderOpen, current });
        const scope = decideTenantScope({ siteFolderOpen, binding, chosen: "alpha" });
        const where = `open=${siteFolderOpen} binding=${binding} current=${current}`;
        if (choice.kind === "elsewhere") {
          // 아무것도 안 적는 갈래끼리 맞아야 한다.
          assert.equal(scope, "none", where);
        } else {
          // 무언가 적히는 갈래에서 「아무것도 안 적힌다」가 나오면 화면이 거짓말을 한다.
          assert.notEqual(scope, "none", where);
        }
      }
    }
  }
});

test("소속은 있는데 소스가 아닌 폴더 — 「바꿨습니다」로 말하지 않는다", () => {
  // package.json 을 지웠거나 아직 안 받은 자리. 종전 순서에서는 switched 인데 아무것도 안 적혔다.
  assert.deepEqual(
    decideSiteChoice({ picked: "beta", binding: "alpha", siteFolderOpen: false, current: "alpha" }),
    { kind: "elsewhere" },
  );
  assert.equal(decideTenantScope({ siteFolderOpen: false, binding: "alpha", chosen: "beta" }), "none");
});

// ── 「받을 것이 없다」의 두 사유 ────────────────────────────────────────────

test("빌드 중인 사이트를 「소스가 없다」로 말하지 않는다", () => {
  // 잠시 기다리면 될 사람을 zip 입고로 보내는 오진이었다.
  const building = elsewhereOptions({ confirmedDir: null, fetchable: "no-ready" });
  assert.equal(building.note, "no-ready");
  assert.ok(!building.options.some((o) => o.kind === "fetch"), JSON.stringify(building.options));
  // 새로 시작하라고 앞세우지 않는다 — 그 사람은 새로 시작할 일이 아니다.
  assert.equal(building.options[0]?.kind, "pick-folder");

  const empty = elsewhereOptions({ confirmedDir: null, fetchable: "no-revision" });
  assert.equal(empty.note, "no-revision");
  assert.equal(empty.options[0]?.kind, "import-zip");
});
