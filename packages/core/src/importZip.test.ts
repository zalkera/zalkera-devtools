import assert from "node:assert/strict";
import test from "node:test";
import { decideImportPlan } from "./importZip.ts";

const SITE = ["package.json", "src/app/page.tsx", "content/nav.json"];

test("평평한 zip 은 그대로 들어온다", () => {
  const plan = decideImportPlan(SITE);
  assert.equal(plan.strip, "");
  assert.deepEqual(plan.keep.sort(), [...SITE].sort());
});

test("중첩 단일 루트를 벗긴다 — OS 기본 압축이 만드는 모양", () => {
  // 이걸 안 벗기면 확장이 「소스 없음」으로 본다. 실무에서 제일 자주 터지는 자리다.
  const plan = decideImportPlan(SITE.map((n) => `site/${n}`));
  assert.equal(plan.strip, "site/");
  assert.deepEqual(plan.keep.sort(), [...SITE].sort());
});

test("두 겹으로 감싼 것도 벗긴다 — 압축을 두 번 거치면 그렇게 된다", () => {
  const plan = decideImportPlan(SITE.map((n) => `site/site/${n}`));
  assert.equal(plan.strip, "site/site/");
  assert.deepEqual(plan.keep.sort(), [...SITE].sort());
});

test("__MACOSX 가 섞여도 중첩이 벗겨진다", () => {
  // ⚠ 접두 계산에 __MACOSX 를 세면 「공통 접두 없음」이 되어 중첩이 안 벗겨진다 —
  //   macOS 에서 압축한 zip 이 정확히 이 모양이라, 이 시험이 없으면 그 zip 만 조용히 깨진다.
  const plan = decideImportPlan([...SITE.map((n) => `site/${n}`), "__MACOSX/site/._package.json"]);
  assert.equal(plan.strip, "site/");
  assert.ok(plan.keep.includes("package.json"), `벗겨지지 않았다: ${plan.keep.join(",")}`);
});

test("정본에 못 싣는 것은 들여오지도 않는다 — 발행과 같은 목록", () => {
  // 보낸 쪽 .vscode 가 들어오면 그 폴더가 **보낸 사람의 사이트라고 주장**한다.
  const plan = decideImportPlan([
    ...SITE,
    ".vscode/settings.json",
    ".mcp.json",
    ".env.local",
    "node_modules/x/index.js",
    "src/nested/node_modules/y.js",
    "__MACOSX/._x",
    ".zalkera/source.json",
  ]);
  for (const gone of [
    ".vscode/settings.json",
    ".mcp.json",
    ".env.local",
    "node_modules/x/index.js",
    "src/nested/node_modules/y.js",
    ".zalkera/source.json",
  ]) {
    assert.ok(!plan.keep.includes(gone), `들어오면 안 되는 것이 들어왔다: ${gone}`);
    assert.ok(plan.dropped.includes(gone), `무엇이 빠졌는지 말하지 않는다: ${gone}`);
  }
});

test("스토어프론트가 아니면 거절한다 — 아무 zip 이나 풀지 않는다", () => {
  assert.throws(() => decideImportPlan(["docs/readme.md", "photo.jpg"]), /사이트 소스가 아닙니다/);
  assert.throws(() => decideImportPlan([]), /비어 있습니다/);
});

test("표식이 제외 대상 아래 있으면 스토어프론트로 세지 않는다", () => {
  // node_modules 안의 package.json 을 근거로 통과시키면, 남의 의존 트리 zip 이 사이트로 둔갑한다.
  assert.throws(
    () => decideImportPlan(["node_modules/pkg/package.json", "node_modules/pkg/index.js"]),
    /사이트 소스가 아닙니다/,
  );
});

test("접두 밖 항목은 계획에서 버린다 — 잘라서 쓰레기 이름을 만들지 않는다", () => {
  // ⚠ `__MACOSX/site/._x` 를 `site/` 길이만큼 자르면 `OSX/site/._x` 가 되고, 그 이름은 제외 목록
  //   어디에도 안 걸려 **통과한다**. 해제 쪽에도 같은 가드가 있지만, 둘이 서로를 가려 주면
  //   한쪽을 지워도 전건 초록이 된다 — 그래서 이 자리를 따로 문다.
  const plan = decideImportPlan([
    "site/package.json",
    "site/src/a.ts",
    "__MACOSX/site/._package.json",
  ]);
  assert.equal(plan.strip, "site/");
  for (const name of plan.keep) {
    assert.ok(!name.includes("._"), `쓰레기 이름이 계획에 들어왔다: ${name}`);
    assert.ok(!name.startsWith("OSX/"), `접두 밖 항목을 잘라서 실었다: ${name}`);
  }
  assert.ok(
    plan.dropped.includes("__MACOSX/site/._package.json"),
    `접두 밖 항목이 버려졌다고 보고되지 않는다: ${plan.dropped.join(",")}`,
  );
});

test("두 겹으로 감싼 **실물** zip 도 벗긴다 — 디렉터리 항목이 접두를 끊지 않는다", () => {
  // ⚠ 이 시험이 없으면 「파일만 담은 zip」으로만 확인하게 되고, 실물(탐색기·Finder·`zip -r`)은
  //   전부 디렉터리 항목을 담으므로 **시험은 초록인데 실물이 통째로 거절된다.**
  //   디렉터리 항목 `wrapper/` 는 자기 자신이 접두라, 최장공통접두를 재는 데 끼우면 거기서 끊긴다.
  const plan = decideImportPlan([
    "wrapper/",
    "wrapper/site/",
    "wrapper/site/package.json",
    "wrapper/site/src/",
    "wrapper/site/src/a.ts",
  ]);
  assert.equal(plan.strip, "wrapper/site/");
  assert.ok(plan.keep.includes("package.json"), `표식이 뿌리에 안 올라왔다: ${plan.keep.join(",")}`);
});

test("경로가 지나치게 깊으면 **재기 전에** 거절한다", () => {
  // ⚠ 항목마다 세그먼트를 훑어 제외를 판정하므로 깊이가 곧 항목당 비용이다. 형식이 허용하는
  //   최악(이름 65,534B = 32,767단)을 그대로 받으면 그 곱이 확장 호스트를 멈춘다.
  const deep = `${"a/".repeat(200)}package.json`;
  assert.throws(() => decideImportPlan([deep]), /깊은/);
  // 정상 소스는 막지 않는다 — 실제 트리는 10단 안쪽이다.
  const normal = "src/app/api/orders/[orderNo]/cancel/route.ts";
  assert.doesNotThrow(() => decideImportPlan(["package.json", normal]));
});

test("이름 목록이 지나치게 크면 **재기 전에** 거절한다", () => {
  // ⚠ 항목 수 상한도 깊이 상한도 이 축을 못 막는다 — 65,535개를 긴 이름으로 채우면 두 상한을
  //   다 지키면서 137MB 가 되고, 그 훑기는 **양보점 없는 동기 구간**이라 확장 호스트가 언다
  //   (실측: 137MB → 2,517ms, 취소 불가). 이 경로의 입력은 남이 준 zip 이다.
  const seg = `${"d".repeat(60)}/`;
  const names: string[] = ["package.json"];
  // 8MB 를 넘기되 항목 수·깊이 상한에는 안 걸리는 목록을 만든다.
  for (let i = 0; i < 20_000; i += 1) names.push(`${seg}f${String(i).padStart(400, "0")}`);
  assert.ok(
    names.reduce((sum, n) => sum + n.length, 0) > 8 * 1024 * 1024,
    "시험 입력이 상한을 안 넘는다 — 이 시험은 아무것도 안 재고 있다",
  );
  assert.throws(() => decideImportPlan(names), /목록이 지나치게 큽니다/);

  // 정상 소스는 막지 않는다 — 실물 팩의 이름 총량은 5KB 다(팩 4벌 실측).
  assert.doesNotThrow(() =>
    decideImportPlan(["package.json", "src/app/page.tsx", "content/pages/home.json"]),
  );
});
