/**
 * 자식 프로세스가 뜨지 못했을 때 **사용자에게 무엇을 말하는가**. 세 갈래가 각각 다른 행동을
 * 요구하고, 갈래를 잘못 고르면 사용자를 엉뚱한 곳으로 보낸다.
 *
 * 특히 **취소**는 오류가 아니다 — `register()` 가 `CANCELLED` 를 보고 조용히 삼킨다. 코드가
 * 바뀌면 취소를 누른 사람에게 빨간 오류창이 뜬다(실제로 그랬다).
 */
import { test } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { spawnFailure } from "./deps.ts";

/** `AbortController.abort()` 로 끊었을 때 Node 가 주는 것과 같은 모양. */
function abortError(): Error {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}

test("취소는 CANCELLED — 빨간 오류창으로 가지 않는다", () => {
    const error = spawnFailure(abortError());
    strictEqual(error.code, "CANCELLED");
    ok(!/인터넷|프록시/.test(error.humanMessage), "취소한 사람에게 네트워크를 확인하라고 말한다");
});

test("npm 이 없으면 — 재설치를 안내한다", () => {
    const cause = Object.assign(new Error("spawn npm ENOENT"), {code: "ENOENT"});
    const error = spawnFailure(cause);
    strictEqual(error.code, "DEPENDENCIES_FAILED");
    ok(/다시 설치/.test(error.humanMessage), "없는 도구를 인터넷 문제로 안내한다");
    ok(!/인터넷/.test(error.humanMessage));
});

test("그 밖의 실패는 — 네트워크를 안내한다", () => {
    const error = spawnFailure(new Error("socket hang up"));
    strictEqual(error.code, "DEPENDENCIES_FAILED");
    ok(/인터넷|프록시/.test(error.humanMessage));
});

test("원인을 버리지 않는다 — 출력 채널에 남아야 한다", () => {
    const cause = new Error("socket hang up");
    strictEqual(spawnFailure(cause).cause, cause);
});

test("AbortError 는 이름으로 판정한다 — 메시지 문면이 아니라", () => {
    // 메시지에 'abort' 가 들어간 **진짜 실패**를 취소로 삼키면 사용자는 아무 안내도 못 받는다.
    const error = spawnFailure(new Error("npm ERR! aborted by registry"));
    strictEqual(error.code, "DEPENDENCIES_FAILED");
});
