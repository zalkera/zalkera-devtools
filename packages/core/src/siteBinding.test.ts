import assert from "node:assert/strict";
import test from "node:test";
import {
  changeFolderPlan,
  decideFetchTargetPlan,
  decideImportBinding,
  decidePickedFolder,
  decideSiteChoice,
  decideTenantScope,
  elsewhereOptions,
  folderBinding,
  folderStillShown,
  linkedTenantOf,
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
  // 판을 안 넘겼으므로 `drift` 는 null 이다 — 모르면 침묵이 이 자리의 계약이다.
  assert.deepEqual(options[0], { kind: "open", dir: "/w/alpha", drift: null });
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

// ── zip 을 푼 폴더에 소속을 적을 것인가 ──────────────────────────────────────

/**
 * ⚠ **「못 읽었다」가 「없다」로 접히면 이 가드는 장식이다**(보안 심의 🟠). 링크 판독기는 생
 *   `JSON.parse` 라 JSONC(주석·후행 쉼표 — VS Code 가 정상으로 다루는 형식)에서 던지는데,
 *   그것을 「소속 없음」으로 세면 **남의 사이트에 붙어 있던 폴더**를 무동의로 갈아탄다.
 */
test("소속을 못 읽으면 안 적는다 — 「없다」와 갈라야 한다", () => {
    const notRead = decideImportBinding(null, {kind: "unreadable"}, "fin-02");
    assert.strictEqual(notRead.kind, "unknown", "못 읽은 것을 통과로 세면 안 된다");

    const absent = decideImportBinding(null, {kind: "absent"}, "fin-02");
    assert.strictEqual(absent.kind, "bind", "정말 비어 있으면 적는다 — 안 그러면 정상 흐름이 막힌다");
});

test("남의 사이트에 붙어 있으면 안 적는다 — 표식이든 링크든", () => {
    const byMark = decideImportBinding(
        {format: 2, origin: "linked", tenant: "fin-01", linkedAt: "2026-01-01T00:00:00.000Z"},
        {kind: "absent"},
        "fin-02",
    );
    assert.deepStrictEqual(byMark, {kind: "keep", bound: "fin-01"});

    const byLink = decideImportBinding(null, {kind: "tenant", tenant: "fin-01"}, "fin-02");
    assert.deepStrictEqual(byLink, {kind: "keep", bound: "fin-01"});
});

test("이미 그 사이트면 적는다 — 같은 값 다시 쓰는 것은 소속 변경이 아니다", () => {
    assert.strictEqual(decideImportBinding(null, {kind: "tenant", tenant: "fin-02"}, "fin-02").kind, "bind");
});

test("표식이 링크를 이긴다 — 붙이기 판정에서도 서열이 같다", () => {
    const plan = decideImportBinding(
        {format: 2, origin: "linked", tenant: "fin-02", linkedAt: "2026-01-01T00:00:00.000Z"},
        {kind: "tenant", tenant: "fin-01"},
        "fin-02",
    );
    assert.strictEqual(plan.kind, "bind", "표식이 그 사이트라고 말하면 링크의 옛 값이 막지 않는다");
});

test("linkedTenantOf 는 판독 결과를 종전 계약으로 좁힌다 — 판독기는 한 벌이다", () => {
    assert.strictEqual(linkedTenantOf({kind: "tenant", tenant: "fin-01"}), "fin-01");
    assert.strictEqual(linkedTenantOf({kind: "absent"}), null);
    assert.strictEqual(linkedTenantOf({kind: "unreadable"}), null);
});

// ── 작업 폴더 변경 ──────────────────────────────────────────────────────────

test("확증된 로컬본이 있으면 그것부터 낸다", () => {
    assert.deepStrictEqual(changeFolderPlan({openDir: "/a", confirmedDir: "/b"}), {kind: "offer", dir: "/b"});
});

test("확증이 없으면 고르는 화면을 건너뛴다 — 한 단계 덜", () => {
    assert.strictEqual(changeFolderPlan({openDir: "/a", confirmedDir: null}).kind, "pick");
});

test("이미 그 폴더를 열어 뒀으면 제안하지 않는다 — 눌러도 아무 일이 없는 항목이다", () => {
    assert.strictEqual(changeFolderPlan({openDir: "/b", confirmedDir: "/b"}).kind, "pick");
});

test("보인 폴더가 아직 그 폴더인가 — 사라진 것과 달라진 것을 둘 다 본다", () => {
    // ⚠ **`null` 만 보면 안 된다.** 목록을 띄운 사이 다른 창이 링크를 바꾸면, `detail` 에 적힌
    //   경로와 **다른 폴더**가 말없이 열린다. 세 판이 그 상태로 배송됐다(소급 심의 🟠).
    assert.equal(folderStillShown("/a/site", "/a/site"), true, "같은 폴더인데 막았다");
    assert.equal(folderStillShown(null, "/a/site"), false, "사라진 폴더를 열려 했다");
    assert.equal(folderStillShown("/b/other", "/a/site"), false, "보인 것과 다른 폴더를 열려 했다");
    assert.equal(folderStillShown("", "/a/site"), false, "빈 값을 폴더로 봤다");
    // ⚠ 타입이 막아 주는 자리지만 **런타임에는 뚫린다** — 보인 것도 없고 지금도 없을 때
    //   `current === shown` 만 쓰면 `null === null` 로 참이 되어 「그 폴더 맞다」가 된다.
    assert.equal(
        folderStillShown(null, null as unknown as string), false,
        "보인 것도 없는데 같다고 답했다",
    );
});

// ── 로컬본이 서버와 «다를 때만» 말한다 ──────────────────────────────────────
//
// ⚠ **이 절의 절반은 침묵이다.** 하나라도 모르면 말하지 않고, 같아도 말하지 않는다 —
//   「서버와 같습니다」는 **사본 주장**으로 읽히는데 우리가 아는 것은 기반뿐이다.
//
// ⚠ **방향을 단정하지 않는다.** 되돌린 사이트에서는 로컬이 서버보다 **앞**이라 「낡았다」가
//   거짓이 된다. 그래서 판정은 「다르다」까지만 하고 번호 둘을 그대로 싣는다.

const openOf = (input: Parameters<typeof elsewhereOptions>[0]) =>
    elsewhereOptions(input).options.find((o) => o.kind === "open") as
        | {kind: "open"; dir: string; drift: {held: number; server: number} | null}
        | undefined;

test("둘 다 알고 다르면 번호 둘을 싣는다", () => {
    const open = openOf({confirmedDir: "/w/bix", fetchable: "yes", heldRevisionNo: 3, serverRevisionNo: 9});
    assert.deepEqual(open?.drift, {held: 3, server: 9});
});

test("되돌린 사이트 — 로컬이 «앞»이어도 그대로 싣는다(방향을 단정하지 않는다)", () => {
    const open = openOf({confirmedDir: "/w/bix", fetchable: "yes", heldRevisionNo: 9, serverRevisionNo: 3});
    assert.deepEqual(open?.drift, {held: 9, server: 3}, "「낡음」으로 접으면 이 칸에서 거짓이 된다");
});

test("같으면 침묵한다 — 「서버와 같습니다」는 사본 주장이라 우리가 못 하는 말이다", () => {
    assert.equal(openOf({confirmedDir: "/w/bix", fetchable: "yes", heldRevisionNo: 7, serverRevisionNo: 7})?.drift, null);
});

test("하나라도 모르면 침묵한다 — 표식 없음·조회 실패·구 서버", () => {
    const cases: Array<[string, number | null | undefined, number | null | undefined]> = [
        ["로컬 모름(표식 없음·링크만)", null, 9],
        ["서버 모름(조회 실패·시한)", 3, null],
        ["둘 다 모름", null, null],
        ["안 넘김(구 호출부)", undefined, undefined],
    ];
    for (const [why, held, server] of cases) {
        assert.equal(
            openOf({confirmedDir: "/w/bix", fetchable: "yes", heldRevisionNo: held, serverRevisionNo: server})?.drift,
            null,
            `${why} 인데 말했다`,
        );
    }
});

test("판 번호로 안 통하는 값은 «모름»으로 접는다 — 서버 값은 캐스트라 런타임 검사가 없다", () => {
    // ⚠ **서버 쪽이 하중을 받는다.** `request<T>` 는 형만 주장하고 검사하지 않으므로, 이 자리는
    //    「형이 number 라고 적혀 있으니 정수일 것이다」에 기대면 안 된다. 실제로 그 값이 문면에
    //    실려 QuickPick 으로 나간다.
    const bad: Array<[string, unknown]> = [
        ["0", 0],
        ["음수", -1],
        ["Int32 초과", 2_147_483_648],
        ["소수", 3.5],
        ["NaN", Number.NaN],
        ["무한대", Number.POSITIVE_INFINITY],
        ["문자열(캐스트가 통과시킨다)", "9"],
        ["객체", {revisionNo: 9}],
    ];
    for (const [why, value] of bad) {
        assert.equal(
            openOf({
                confirmedDir: "/w/bix",
                fetchable: "yes",
                heldRevisionNo: 3,
                serverRevisionNo: value as number,
            })?.drift,
            null,
            `서버 값이 ${why} 인데 말했다`,
        );
        assert.equal(
            openOf({
                confirmedDir: "/w/bix",
                fetchable: "yes",
                heldRevisionNo: value as number,
                serverRevisionNo: 9,
            })?.drift,
            null,
            `로컬 값이 ${why} 인데 말했다`,
        );
    }
});

test("로컬본이 없으면 그 항목 자체가 없다 — 없는 폴더의 판을 말하지 않는다", () => {
    assert.equal(openOf({confirmedDir: null, fetchable: "yes", heldRevisionNo: 3, serverRevisionNo: 9}), undefined);
});

test("고지가 «열기»를 막지 않는다 — 모른다로도, 달라도 막지 않는다", () => {
    for (const [held, server] of [[3, 9], [null, null]] as Array<[number | null, number | null]>) {
        const opts = elsewhereOptions({confirmedDir: "/w/bix", fetchable: "yes", heldRevisionNo: held, serverRevisionNo: server}).options;
        assert.equal(opts[0]?.kind, "open", "열기가 첫 항목이 아니다 — 순서를 바꿨다");
    }
});
