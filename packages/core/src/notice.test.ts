import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_CAP, plainNotice } from "./notice.ts";

/** 알림이 링크로 만드는 형태. 이 시험이 재는 것은 «이것이 안 남는가» 하나다. */
const RENDERS_AS_LINK = /\[[^\]]*\]\s*\(\s*[A-Za-z][A-Za-z0-9+.-]*:/;

test("명령 링크를 남기지 않는다", () => {
  const attack =
    "새 판이 있습니다. [지금 업데이트](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22id%22%7D)";
  const out = plainNotice(attack);
  ok(!RENDERS_AS_LINK.test(out), out);
  ok(
    out.includes("지금 업데이트"),
    "글자는 남아야 사람이 무슨 일이 있었는지 안다",
  );
});

test("파일 링크도 남기지 않는다", () => {
  ok(!RENDERS_AS_LINK.test(plainNotice("[열기](file:///home/u/.ssh/id_rsa)")));
});

test("스킴 목록에 기대지 않는다 — 콜론이 있는 것 전부", () => {
  for (const scheme of [
    "command",
    "file",
    "https",
    "vscode",
    "vscode-insiders",
    "x-new-thing",
  ]) {
    const out = plainNotice(`[a](${scheme}://x)`);
    ok(!RENDERS_AS_LINK.test(out), `${scheme}: ${out}`);
  }
});

test("공백을 끼워 넣어도 안 통한다", () => {
  for (const attack of [
    "[a] (command:x)",
    "[a]  (  command:x )",
    "[a]\t(command:x)",
  ]) {
    ok(!RENDERS_AS_LINK.test(plainNotice(attack)), attack);
  }
});

test("평범한 괄호는 그대로 둔다 — 우리 문장이 괄호를 쓴다", () => {
  const ours =
    "새 버전(0.1.41)이 있습니다. 지금 버전(0.1.39)으로도 쓸 수 있습니다.";
  strictEqual(plainNotice(ours), ours);
});

test("제어문자·줄바꿈을 없앤다 — 뒤를 숨길 수 있다", () => {
  const out = plainNotice("앞\n\r\u0000\u200b뒤");
  strictEqual(out, "앞 뒤");
});

test("길이를 자른다", () => {
  strictEqual(plainNotice("x".repeat(5_000)).length, 301);
  strictEqual(plainNotice("x".repeat(5_000), 50).length, 51);
});

test("문자열이 아니면 빈 글자", () => {
  for (const bad of [null, undefined, 0, {}, []])
    strictEqual(plainNotice(bad), "");
});

/**
 * **소독기가 무기가 되지 않는다.**
 *
 * 링크 형태의 안쪽 반복이 닫는 괄호를 못 찾으면 시작 위치마다 끝까지 훑는다 — 비용이 길이의
 * 제곱이다. 그리고 이 함수가 받는 글자는 서버 응답과 **아카이브 항목 이름**이다(tar GNU 긴이름
 * 헤더는 상한이 200MB). 즉 이 소독기가 막으려던 「적대적 서버가 한 줄로 우리 알림을 조종한다」가,
 * 같은 한 줄로 **편집기를 세우는** 길이 됐다. 알림은 확장 호스트 스레드에서 동기로 만들어진다.
 *
 * 재현: `npm run test -w @zalkera/devtools-core`
 */
test("닫히지 않는 링크가 길어도 선형이다 — 안쪽 반복의 상한이 지킨다", () => {
  // ⚠ `MAX_CAP` 이 `limit` 을 죄므로 자르기는 **밖에서 끌 수 없다.** 그래서 이 시험은 안쪽 상한을
  //   홀로 재지 못한다 — 그 몫은 위의 「상수에서 유도된다」가 진다.
  const started = Date.now();
  for (const kb of [16, 64, 256])
    plainNotice("](a:".repeat(kb * 256), 10_000_000);
  const elapsed = Date.now() - started;
  ok(elapsed < 1_500, `${elapsed}ms — 링크 형태의 안쪽 반복에 상한이 없다`);
});

test("아주 긴 글자는 자르기가 먼저 막는다 — 상한만으로는 못 막는 크기", () => {
  // ⚠ **자르기를 홀로 재려면 상한이 못 미치는 크기여야 한다.** 상한이 있어도 시작 위치마다
  //   상한만큼은 훑으므로, 길이가 충분히 크면 그것만으로는 안 된다. 이 함수가 받는 글자에는
  //   tar GNU 긴이름 헤더(상한 200MB)가 있다.
  const started = Date.now();
  plainNotice("](a:".repeat(2 * 1024 * 1024)); // 8MB · 기본 상한
  const elapsed = Date.now() - started;
  ok(elapsed < 1_500, `${elapsed}ms — 자르는 것이 정규식 뒤로 돌아갔다`);
});

test("앞에서 잘라도 링크 무력화가 살아 있다 — 과소독도 미소독도 아니다", () => {
  // 자르기가 먼저라 「앞부분」의 판정이 바뀌면 안 된다.
  const attack = `[열기](command:workbench.action.terminal.new)${"긴 꼬리 ".repeat(500)}`;
  const out = plainNotice(attack);
  ok(!RENDERS_AS_LINK.test(out), out.slice(0, 120));
  ok(out.includes("열기"), "글자는 남아야 한다");
});

test("양성 통제군 — 상한보다 짧은 문장은 한 글자도 안 바뀐다", () => {
  for (const message of [
    "묶은 파일이 너무 큽니다(120MB · 상한 100MB).",
    "'credium' 사이트를 찾지 못했습니다.",
    "`.mcp.json` 에 이미 항목이 있습니다 — 덮어쓰지 않았습니다.",
  ]) {
    strictEqual(plainNotice(message), message);
  }
});

test("긴 글자는 상한에서 잘리고 말줄임이 붙는다", () => {
  const out = plainNotice("가".repeat(5_000), 300);
  strictEqual(out.length, 301, "상한 + 말줄임 한 글자");
  ok(out.endsWith("…"));
});

/**
 * **안쪽 상한이 도달 불가하다는 것을 못박는다.**
 *
 * `LINK_SHAPE`·`AUTOLINK_SHAPE` 의 `{0,2048}` 을 넘는 링크는 **정규식에 안 잡힌다** — 즉 소독이
 * 새는 자리다. 지금은 `MAX_CAP * 4 = 2048` 이라 자른 뒤 길이가 그 상한을 넘을 수 없어 닫혀 있다.
 * 그 산술이 이 소독의 전제이므로 여기서 잰다 — 상한을 올리거나 `MAX_CAP` 을 키우면 빨개진다.
 *
 * (변이 실측: `AUTOLINK_SHAPE` 의 상한만 지웠을 때 종전에는 **아무 시험도 안 죽었다.**)
 */
test("두 정규식이 상수에서 유도된다 — 상한을 지우면 여기가 빨개진다", () => {
  // ⚠ 산술만 재면 상한을 통째로 지워도 초록이다(실측: 둘 다 `*` 로 바꿔도 전건 통과했다).
  //   상수가 **정규식 본문에 실제로 쓰이는지**를 함께 본다.
  const src = readFileSync(new URL("./notice.ts", import.meta.url), "utf8");
  const bodies = [...src.matchAll(/new RegExp\(\s*`([^`]*)`/g)].map(
    (m) => m[1] ?? "",
  );
  ok(
    bodies.length === 2,
    `링크 정규식 둘을 못 찾았다(${bodies.length}개) — 이 시험의 좌표가 낡았다`,
  );
  for (const body of bodies) {
    ok(
      body.includes("{0,${INNER_BOUND}}"),
      `안쪽 반복이 상수에서 유도되지 않는다: ${body.slice(0, 80)}`,
    );
  }
});

test("자른 길이가 안쪽 상한을 넘을 수 없다", () => {
  // 두 정규식이 `INNER_BOUND` 에서 유도되므로 상한을 지우려면 그 상수를 건드려야 한다 —
  // 그러면 이 산술이 깨져 여기가 빨개진다. 주석의 숫자가 아니라 **실물 상수**를 읽는다.
  const src = readFileSync(new URL("./notice.ts", import.meta.url), "utf8");
  const bound = Number(/const INNER_BOUND = (\d+);/.exec(src)?.[1]);
  ok(
    Number.isInteger(bound) && bound > 0,
    "INNER_BOUND 를 못 읽었다 — 이 시험의 좌표가 낡았다",
  );
  ok(
    MAX_CAP * 4 <= bound,
    `MAX_CAP*4=${MAX_CAP * 4} 가 안쪽 상한 ${bound} 을 넘는다 — 소독이 샌다`,
  );
});
/**
 * **완결된 링크**만 마크다운이 링크로 그린다 — 닫는 괄호가 있어야 한다.
 *
 * `RENDERS_AS_LINK` 는 여는 쪽만 보므로 **잘린 잔해**(`](command:xxx…`)도 「남았다」로 판정한다.
 * 그것은 링크가 아니고 위험도 아니지만, 그 오라클로 이 자리를 재면 늘 빨갛다 — 여기서 잴 것은
 * 「누를 수 있는 링크가 살아남는가」이므로 닫는 괄호까지 본다.
 */
const COMPLETE_LINK = /\[[^\]]*\]\s*\(\s*[A-Za-z][A-Za-z0-9+.-]*:[^)]*\)/;

test("상한을 넘는 링크는 어떤 limit 으로도 살아남지 않는다", () => {
  // 종전에는 limit≥2065 에서 **닫는 괄호까지 온전한** 링크가 그대로 나갔다(실측) —
  // 알림에서 누르면 명령이 도는 상태였다. `MAX_CAP` 이 그 전제를 코드로 지킨다.
  for (const inner of [2049, 2500, 5000]) {
    for (const limit of [300, 4000, 10_000_000]) {
      const out = plainNotice(`[a](command:${"x".repeat(inner)})`, limit);
      ok(
        !COMPLETE_LINK.test(out),
        `inner=${inner} limit=${limit} 에서 누를 수 있는 링크가 남았다`,
      );
    }
  }
});

test("상한 안쪽 링크는 잘림과 무관하게 무력화된다", () => {
  // 잘림이 링크 **뒤**에 떨어지는 통상 경로. 여기서는 여는 쪽 오라클로도 깨끗해야 한다.
  const out = plainNotice(
    `[열기](command:workbench.action.terminal.new)${"긴 꼬리 ".repeat(500)}`,
  );
  ok(!RENDERS_AS_LINK.test(out), out.slice(0, 120));
});
