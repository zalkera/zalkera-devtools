/**
 * **가드가 실제로 막는가.** 이 시험이 없으면 가드는 아무것도 못박지 못한다 — 실측으로, 확장 안에
 * 있던 같은 조건을 통째로 무력화해도 시험 297건과 검사기 12종이 전부 초록이었다.
 *
 * 재현: `npm run test -w @zalkera/devtools-core`
 */
import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BUSY, createReentrancyGuard } from "./reentrancy.ts";

/** 손으로 풀 수 있는 약속 — 「도는 중」 상태를 시험이 붙잡아 둔다. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("도는 중에 다시 부르면 실행하지 않는다", async () => {
  const guard = createReentrancyGuard();
  const gate = deferred();
  let ran = 0;

  const first = guard(async () => {
    ran += 1;
    await gate.promise;
    return "첫 번째";
  });
  const second = await guard(async () => {
    ran += 1;
    return "두 번째";
  });

  strictEqual(
    second,
    BUSY,
    "두 번째가 실행됐다 — 같은 폴더에 두 꾸러미가 풀린다",
  );
  strictEqual(ran, 1, "두 번째 본문이 돌았다");
  gate.resolve();
  strictEqual(await first, "첫 번째");
});

test("끝나면 다시 받는다", async () => {
  const guard = createReentrancyGuard();
  strictEqual(await guard(async () => "a"), "a");
  strictEqual(await guard(async () => "b"), "b", "한 번 쓰고 잠겼다");
});

test("던져도 가드를 푼다 — 취소 한 번에 영영 잠기지 않는다", async () => {
  const guard = createReentrancyGuard();
  await guard(async () => {
    throw new Error("폴더 선택 취소");
  }).catch(() => {});
  strictEqual(await guard(async () => "다음"), "다음", "실패 뒤 가드가 잠겼다");
});

test("던진 오류는 그대로 올라간다 — 가드가 삼키지 않는다", async () => {
  const guard = createReentrancyGuard();
  let caught: unknown = null;
  await guard(async () => {
    throw new Error("네트워크 오류");
  }).catch((e) => {
    caught = e;
  });
  ok(
    caught instanceof Error && caught.message === "네트워크 오류",
    String(caught),
  );
});

test("가드는 서로 독립이다 — 다른 일이 막히지 않는다", async () => {
  const a = createReentrancyGuard();
  const b = createReentrancyGuard();
  const gate = deferred();
  const running = a(async () => {
    await gate.promise;
  });
  strictEqual(
    await b(async () => "다른 가드"),
    "다른 가드",
    "가드 하나가 전부를 막았다",
  );
  gate.resolve();
  await running;
});
