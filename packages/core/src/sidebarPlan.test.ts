/**
 * **사이드바가 무엇을 보여 주는가.**
 *
 * 이 시험이 없을 때, 「사이트가 붙으면 받기 진입점이 사라진다」가 아무 곳에도 안 걸렸다 — 명령은
 * 팔레트에 그대로 있어 명령 검사기도 통과했다. 사람 눈에만, 그것도 「불러오는 기능이 없다」는
 * 오해로 한참 뒤에 걸렸다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sidebarPlan, type SidebarState } from "./sidebarPlan.ts";
import { commandsWithNeeds, decideBlocked } from "./whyBlocked.ts";

const base: SidebarState = {
  signedIn: true,
  tenant: "credium",
  site: null,
  previewUrl: null,
  keyExpiresAt: null,
  folderTenant: null,
  folderPath: null,
};
const plan = (patch: Partial<SidebarState> = {}) => sidebarPlan({ ...base, ...patch });
const ids = (patch?: Partial<SidebarState>) => plan(patch).map((g) => g.id);
/**
 * **실행 진입점만 센다.** 종전에는 `info` 를 `undefined` 로 매핑해 배열에 남겼는데, 그러면 사실
 * 진술 한 줄이 늘고 주는 것까지 「항목이 흔들렸다」로 읽힌다 — 원 사건은 **누를 자리가 사라진**
 * 것이었고 이 불변식이 무는 것은 그것이다.
 *
 * ⚠ **이 좁힘은 면제가 아니다** — 좁힌 만큼 `info` 쪽을 무는 시험(아래 예고형 매트릭스)을 **같이**
 *   둔다. 하나만 두면 그 자리가 검사 밖이 된다.
 */
const commands = (patch?: Partial<SidebarState>) =>
  plan(patch).flatMap((g) => g.items.filter((i) => i.kind === "action").map((i) => i.command));

/** 사실 진술(`info`) 라벨 — 예고형이 정확히 그 칸에서만 서는지를 무는 자리. */
const notes = (patch?: Partial<SidebarState>) =>
  plan(patch).flatMap((g) => g.items.filter((i) => i.kind === "info").map((i) => i.label));

test("사이트가 붙어도 받기 진입점이 보인다", () => {
  // 이 한 줄이 이번 건의 요점이다. 사라지면 사람은 「불러오는 기능이 없다」로 읽는다.
  assert.ok(commands({ site: "/tmp/x" }).includes("zalkera.site.open"), "받기가 사이드바에서 사라졌다");
  assert.ok(commands().includes("zalkera.site.open"), "처음 쓰는 사람에게도 보여야 한다");
});

test("순서는 사이트 · 미리보기 · 배포 · 내려받기 · 작업 폴더 · 버전 · 도움", () => {
  assert.deepEqual(ids({ site: "/tmp/x" }), ["site", "preview", "export", "download", "workdir", "version", "help"]);
});

test("소스가 없어도 묶음이 다 보인다 — 없으면 「갱신이 안 됐다」로 읽힌다", () => {
  // 오너 확정. 종전에는 못 하는 것을 숨겼는데, 실사용에서 그 대가가 더 컸다 — 확장을 새로
  // 깔았는데 메뉴가 셋뿐이니 갱신 실패로 읽혔다. 사람은 없는 것을 「조건이 안 됐다」로 읽지 않는다.
  // 못 하는 이유는 **누를 때** 말한다(`whyBlocked`).
  assert.deepEqual(ids(), ["site", "preview", "export", "download", "workdir", "version", "help"]);
});

test("소스가 있으나 없으나 묶음과 순서가 같다 — 화면이 흔들리지 않는다", () => {
  assert.deepEqual(ids(), ids({ site: "/tmp/x" }));
});

test("소스가 있으나 없으나 **항목까지** 같다 — 화면이 흔들리지 않는다", () => {
  // 종전에는 사이트가 붙으면 받기 자리가 넷에서 둘로 줄었다. 사람은 줄어든 것을 「조건이 안 됐다」로
  // 읽지 않고 「고장」으로 읽는다. 「예제 zip 다운로드」가 **파일로 받는 것**이 되면서 어느 상태에서나
  // 안전해졌으므로 이제 숨길 이유가 없다 — 못 하는 이유는 누를 때 말한다(`whyBlocked`).
  assert.deepEqual(commands(), commands({ site: "/tmp/x" }));
});

test("묶음 id 는 라벨과 무관하다 — 문면을 다듬어도 접힘이 안 풀린다", () => {
  for (const g of plan({ site: "/tmp/x" })) {
    assert.ok(/^[a-z]+$/.test(g.id), `id 가 라벨에서 나온 것 같다: ${g.id}`);
    assert.ok(!g.id.includes(g.label), `id 에 라벨이 섞였다: ${g.id}`);
  }
});

test("id 는 겹치지 않는다 — 겹치면 접힘 상태가 서로를 덮는다", () => {
  const seen = plan({ site: "/tmp/x" }).map((g) => g.id);
  assert.equal(new Set(seen).size, seen.length);
});

test("미리보기가 돌면 중지가 함께 보인다", () => {
  const running = commands({ site: "/tmp/x", previewUrl: "http://localhost:3000" });
  assert.ok(running.includes("zalkera.preview.stop"), "돌고 있는데 멈출 길이 없다");
  assert.ok(!commands({ site: "/tmp/x" }).includes("zalkera.preview.stop"), "안 도는데 중지가 보인다");
});

test("로그인 전에는 로그인과 진단만", () => {
  assert.deepEqual(commands({ signedIn: false }), ["zalkera.signIn", "zalkera.doctor"]);
});

test("사이트를 안 골랐으면 고를 길을 준다 — 알리기만 하고 막다른 길로 두지 않는다", () => {
  assert.ok(commands({ tenant: "" }).includes("zalkera.site.choose"));
});

test("모든 실행 항목은 실제로 누를 수 있어야 한다", () => {
  // 「목록에 있다」와 「누를 수 있다」는 다르다. 렌더러는 `kind` 를 보고 `info` 면 명령을 통째로
  // 버리므로, 명령만 세는 판정은 사이드바 전체를 안 눌리게 만들어도 통과한다.
  // ⚠ **상태를 하나라도 빼면 그 상태의 사이드바는 아무도 안 본다.** 「사이트를 안 골랐다」가
  //   빠져 있었는데, 그 화면은 처음 쓰는 사람이 반드시 지나는 자리다.
  for (const state of [
    {},
    { tenant: "" },
    { site: "/tmp/x" },
    { site: "/tmp/x", previewUrl: "http://x" },
    { signedIn: false },
  ]) {
    for (const g of plan(state)) {
      for (const i of g.items) {
        if (i.kind === "info") continue;
        assert.ok(i.command.length > 0, `${g.id}/${i.label}: 명령이 비었다`);
        assert.ok(i.label.length > 0, `${g.id}: 라벨이 비었다`);
      }
    }
  }
});

test("누를 수 있어야 하는 항목이 info 로 바뀌면 잡는다", () => {
  // 이 단언이 없으면 「소스 다운로드」를 info 로 바꿔도 전건 초록이다.
  const actions = plan({ site: "/tmp/x" })
    .flatMap((g) => g.items)
    .flatMap((i) => (i.kind === "action" ? [i.command] : []));
  for (const must of [
    "zalkera.site.open",
    "zalkera.preview.start",
    "zalkera.publish",
    "zalkera.version.switch",
    "zalkera.help",
  ]) {
    assert.ok(actions.includes(must), `${must} 가 누를 수 있는 항목이 아니다`);
  }
});

test("「내려받기」의 어느 항목도 지금 폴더를 안 건드린다 — 툴팁이 그렇게 단정한다", () => {
  // 툴팁이 「셋 다 지금 폴더를 안 건드립니다」라고 **약속**한다. 그 약속을 지키는 것이 여기밖에 없다.
  //
  // ⚠ **여기에 항목을 더할 때는 그것도 참이어야 한다.** 지금 폴더를 건드리는 항목이 이 묶음에
  //   들어오면 툴팁이 거짓이 되고, 사람은 누르기 전에 그걸 알 방법이 없다. 폴더를 건드리는
  //   것들의 자리는 「작업 폴더」다.
  const HARMLESS = ["zalkera.site.open", "zalkera.site.downloadZip", "zalkera.preset.download"];
  for (const state of [{}, { site: "/tmp/x" }]) {
    const group = plan(state).find((g) => g.id === "download");
    assert.ok(group, "「내려받기」 묶음이 사라졌다");
    assert.deepEqual(
      group.items.map((i) => (i.kind === "action" ? i.command : `info:${i.label}`)),
      HARMLESS,
    );
  }
});

test("지금 폴더를 지우는 명령은 「작업 폴더」 안에만 있다", () => {
  // 「zip 으로 교체」는 되돌릴 수 없다. 그것이 「내려받기」 옆에 서면 「zip 으로 시작」과 두 글자
  // 차이로 나란히 놓여, 안전한 것과 안 안전한 것이 같은 무게로 보인다.
  for (const state of [{}, { site: "/tmp/x" }]) {
    for (const g of plan(state)) {
      const has = g.items.some((i) => i.kind === "action" && i.command === "zalkera.site.updateZip");
      assert.equal(has, g.id === "workdir", `${g.id} 에 「zip 으로 교체」가 ${has ? "있다" : "없다"}`);
    }
  }
});

test("툴팁이 세는 수와 실제 항목 수가 같다", () => {
  // 「셋 중 하나로 시작합니다」는 **약속**이다. 항목이 넷이 되면 툴팁만 조용히 거짓이 되는데,
  // 그것을 보는 눈이 아무 데도 없었다.
  const WORDS: Record<string, number> = { 둘: 2, 셋: 3, 넷: 4, 다섯: 5 };
  let checked = 0;
  for (const state of [{}, { tenant: "" }, { site: "/tmp/x" }, { site: "/tmp/x", previewUrl: "http://x" }]) {
    for (const g of plan(state)) {
      const said = g.tooltip?.match(/([둘셋넷다섯])\s*(?:중|다)/);
      if (!said) continue;
      checked += 1;
      assert.equal(g.items.length, WORDS[said[1]!], `${g.id} 툴팁은 「${said[0]}」인데 항목은 ${g.items.length}개다`);
    }
  }
  assert.ok(checked > 0, "세는 툴팁을 하나도 못 찾았다 — 이 시험이 아무것도 안 재고 있다");
});

test("사이드바가 보여 주는 명령은 요건 판정이 **알고 있다**", () => {
  // 일곱 묶음이 항상 보이므로, 요건 목록에 없는 명령은 조건이 안 맞아도 **그냥 돈다.**
  // 그것이 의도인지 빠뜨린 것인지 목록만 보면 모른다 — 여기서 그 차이를 못 박는다.
  //
  // 요건이 **없어야 하는** 것: 막힌 사람의 탈출구(로그인·사이트 선택·도움말·진단·초기화·로그아웃)
  // 와, 미리보기가 도는 동안에만 보이는 중지.
  const EXITS = new Set([
    "zalkera.signIn",
    "zalkera.signOut",
    "zalkera.site.choose",
    "zalkera.help",
    "zalkera.doctor",
    "zalkera.reset",
    // 도는 것을 멈추는 명령도 탈출구다 — 요건을 걸면 폴더가 닫혔을 때 dev 서버를 못 끈다.
    "zalkera.preview.stop",
  ]);
  const known = new Set(commandsWithNeeds());
  const shown = new Set(
    [{}, { tenant: "" }, { site: "/tmp/x" }, { site: "/tmp/x", previewUrl: "http://x" }, { signedIn: false }]
      .flatMap((s) => plan(s))
      .flatMap((g) => g.items)
      .flatMap((i) => (i.kind === "action" ? [i.command] : [])),
  );
  const unknown = [...shown].filter((c) => !known.has(c) && !EXITS.has(c)).sort();
  assert.deepEqual(
    unknown,
    [],
    `요건 판정이 모르는 명령이 사이드바에 있다 — whyBlocked.ts 에 적거나 탈출구로 선언하십시오: ${unknown.join(" ")}`,
  );
});

test("요건 목록에 사이드바 밖 명령이 섞이지 않았다", () => {
  // 목록이 낡으면 「막는다」고 적힌 것이 아무것도 안 막는다. 사이드바·팔레트 어디에도 없는
  // 명령이 목록에 있으면 그것은 이름이 바뀐 흔적이다.
  const all = new Set(
    [{}, { tenant: "" }, { site: "/tmp/x" }, { site: "/tmp/x", previewUrl: "http://x" }, { signedIn: false }]
      .flatMap((s) => plan(s))
      .flatMap((g) => g.items)
      .flatMap((i) => (i.kind === "action" ? [i.command] : [])),
  );
  // 팔레트에만 있는 것도 정당하다. 다만 **예외는 좁게 든다** — 넓게 들면 이름이 바뀌어 사이드바에서
  // 사라진 진짜 흔적까지 같이 덮인다.
  //
  // ⚠ 「다시 시작」은 사이드바에 안 둔다: 「미리보기 시작」이 이미 도는 것을 다시 쓰므로 두 줄이
  //   같은 일을 하는 것으로 보인다. 팔레트에서 이름으로 찾는 사람에게만 필요하다.
  const PALETTE_ONLY = new Set(["zalkera.preview.restart"]);
  // 차단 알림의 버튼으로만 닿는 명령도 정당하다 — 그 자리가 곧 탈출구다.
  //
  // ⚠ **손으로 열거하지 않는다.** 예외를 손에 들면 이름이 바뀐 진짜 흔적도 같이 덮인다.
  //    `decideBlocked` 를 실제로 돌려 **버튼으로 나오는 것만** 인정한다 — 게이트에서 버튼이
  //    사라지면 그 명령은 여기서도 인정을 잃고 이 시험이 선다.
  const reachableByButton = new Set(
    [
      { signedIn: false, tenant: "", site: null, folderTenant: null },
      { signedIn: true, tenant: "", site: null, folderTenant: null },
      { signedIn: true, tenant: "a", site: null, folderTenant: null },
      { signedIn: true, tenant: "a", site: "/tmp/x", folderTenant: "b" },
    ].flatMap((ready) =>
      commandsWithNeeds().flatMap((c) => {
        const blocked = decideBlocked(c, ready);
        return blocked === null
          ? []
          : [blocked.action?.command, blocked.alternative?.command].flatMap((x) => (x ? [x] : []));
      }),
    ),
  );
  const stale = commandsWithNeeds().filter(
    (c) => !all.has(c) && !PALETTE_ONLY.has(c) && !reachableByButton.has(c),
  );
  assert.deepEqual(stale, [], `요건 목록에 죽은 명령이 있다: ${stale.join(" ")}`);
});

test("어긋난 폴더는 사이드바에서도 어긋나 보인다", () => {
  // 게이트가 누를 때 막는 것만으로는, 누르기 전까지 이 창이 건강해 보인다.
  // 경고로 그치면 안 된다 — **누를 수 있어야** 다음 할 일이 화면에 있다.
  const warned = sidebarPlan({ ...base, site: "/tmp/x", tenant: "bix", folderTenant: "credium" })
    .flatMap((g) => g.items)
    .filter((i) => i.kind === "action" && i.command === "zalkera.site.useFolder");
  assert.equal(warned.length, 1, "어긋남 복귀 항목이 사이드바에 없다");

  // 어긋나지 않은 상태에서는 조용하다 — 늘 경고하면 경고가 배경이 된다.
  for (const state of [
    { ...base, site: "/tmp/x", tenant: "bix", folderTenant: "bix" },
    { ...base, site: "/tmp/x", tenant: "bix", folderTenant: null },
    { ...base, site: null, tenant: "bix", folderTenant: "credium" },
    { ...base, site: "/tmp/x", tenant: "", folderTenant: "credium" },
  ]) {
    const noise = sidebarPlan(state)
      .flatMap((g) => g.items)
      .filter((i) => i.kind === "action" && i.command === "zalkera.site.useFolder");
    assert.equal(noise.length, 0, `조용해야 할 상태에서 경고가 떴다: ${JSON.stringify(state)}`);
  }
});


// ── 작업 폴더 묶음 — 지시대상과 예고형 ─────────────────────────────────────

const workdir = (patch?: Partial<SidebarState>) =>
  plan(patch).find((g) => g.id === "workdir");

test("작업 폴더 묶음이 **접어도 보이는 자리**에 경로를 말한다", () => {
  const group = workdir({ site: "/x", folderPath: "/home/jo/site" });
  assert.ok(group, "작업 폴더 묶음이 사라졌다");
  assert.ok(
    (group.description ?? "").includes("site"),
    `경로가 묶음 머리에 없다: ${JSON.stringify(group.description)}`,
  );
  assert.ok((group.tooltip ?? "").startsWith("/home/jo/site"), "전체 경로가 툴팁에 없다");
});

test("열린 폴더가 없으면 그렇게 말한다 — 빈 자리로 두지 않는다", () => {
  assert.strictEqual(workdir({ folderPath: null })?.description, "열린 폴더 없음");
});

test("「작업 폴더 변경」은 늘 있고 **맨 위**다", () => {
  for (const patch of [{}, { site: "/x" }, { folderPath: "/a" }]) {
    const items = workdir(patch)?.items ?? [];
    const first = items[0];
    assert.ok(first && first.kind === "action" && first.command === "zalkera.folder.change",
      `첫 항목이 「작업 폴더 변경」이 아니다: ${JSON.stringify(first)}`);
  }
});

test("「시작」과 「교체」는 나란히 붙어 있다 — 두 글자 차이가 보여야 한다", () => {
  const items = (workdir({ site: "/x" })?.items ?? []).filter((i) => i.kind === "action");
  const start = items.findIndex((i) => i.command === "zalkera.site.importZip");
  const replace = items.findIndex((i) => i.command === "zalkera.site.updateZip");
  assert.strictEqual(replace, start + 1, "둘 사이에 다른 항목이 끼었다");
});

/**
 * ⚠ **예고형은 정확히 한 칸에서만 선다.** 소스 폴더인데 그 폴더가 어느 사이트 것인지 모르는 칸
 *   하나다. 다른 칸에서 뜨면 거짓이고(소스 아닌 폴더는 「올릴」 것이 없다), 그 칸에서 안 뜨면
 *   화면이 낡은 값을 건강하게 단언하던 그 상태로 돌아간다.
 */
test("예고형은 「소스 폴더 · 소속 모름」 한 칸에서만 선다", () => {
  const NOTE = "처음 올리실 때 사이트가 정해집니다";
  const 칸 = [
    { name: "소스·소속모름", patch: { site: "/x", folderTenant: null }, 뜬다: true },
    { name: "소스·소속있음", patch: { site: "/x", folderTenant: "credium" }, 뜬다: false },
    { name: "소스아님·소속모름", patch: { site: null, folderTenant: null }, 뜬다: false },
    { name: "소스아님·소속있음", patch: { site: null, folderTenant: "credium" }, 뜬다: false },
  ];
  for (const { name, patch, 뜬다 } of 칸) {
    // ⚠ **`includes` 로 재지 않는다.** 그러면 `NOTE` 말고 **다른 `info`** 가 늘어도 안 걸린다 —
    //    좁힌 `commands()` 가 더는 그것을 안 세므로 둘 사이로 빠져나가는 형태가 생긴다.
    //    심의가 변이로 실증했다: 다른 묶음에 `site !== null && tenant !== ""` 로 걸린 줄 하나를
    //    넣으니 24건이 전부 초록이었다. 전수 비교라야 좁힘이 면제가 아니라 정밀화가 된다.
    assert.deepEqual(notes(patch), 뜬다 ? [NOTE] : [], `칸이 틀렸다: ${name}`);
  }
});

test("사이트를 안 골랐으면 예고형이 안 뜬다 — 정해질 사이트가 없다", () => {
  assert.ok(!notes({ site: "/x", folderTenant: null, tenant: "" }).length);
});


/**
 * ⚠ **폴더 이름은 남이 정할 수 있다** — 대행사가 보낸 zip 을 푼 폴더, git clone 한 레포.
 *   그런데 이 자리의 소독은 **대입**이라 보간 검사기가 못 본다(성능 축이 보안으로 넘긴 지적).
 *   실측으로, 소독을 지워도 시험 전건과 검사기가 초록이었다 — 가드가 없던 자리다(Fable 기능 축).
 */
test("적대적 폴더 이름이 작업 폴더 묶음을 위조하지 못한다", () => {
  const 정상 = workdir({ site: "/x", folderPath: "/home/u/site" });
  const 공격 = workdir({
    site: "/x",
    folderPath:
      "/home/u/site\n\n어느 폴더로 일할지 정합니다 — 「교체」만 지금 폴더를 지웁니다\n※ 위는 잔여 표시입니다",
  });
  assert.ok(
    !(공격?.description ?? "").includes("\n"),
    `묶음 머리에 줄이 밀려 들어갔다: ${JSON.stringify(공격?.description)}`,
  );
  assert.strictEqual(
    (공격?.tooltip ?? "").split("\n").length,
    (정상?.tooltip ?? "").split("\n").length,
    "툴팁에 줄이 밀려 들어갔다 — 약속 문장이 잔여 표시로 몰린다",
  );
});

test("폴더 이름의 링크 문법이 무력화된다 — 툴팁이 언젠가 마크다운이 되어도", () => {
  const g = workdir({ site: "/x", folderPath: "/home/u/[열기](command:zalkera.reset)" });
  for (const 문면 of [g?.description ?? "", g?.tooltip ?? ""]) {
    assert.ok(!/\]\(command:/.test(문면), `링크 모양이 살아남았다: ${문면}`);
  }
});
