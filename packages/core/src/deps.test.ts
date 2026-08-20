/**
 * 자식 프로세스가 뜨지 못했을 때 **사용자에게 무엇을 말하는가**. 세 갈래가 각각 다른 행동을
 * 요구하고, 갈래를 잘못 고르면 사용자를 엉뚱한 곳으로 보낸다.
 *
 * 특히 **취소**는 오류가 아니다 — `register()` 가 `CANCELLED` 를 보고 조용히 삼킨다. 코드가
 * 바뀌면 취소를 누른 사람에게 빨간 오류창이 뜬다(실제로 그랬다).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { ensureDependencies, spawnFailure } from "./deps.ts";
import { tempDir } from "./testing/tempDir.ts";

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

// ── 고객이 손수 설치한 트리 ────────────────────────────────────────────────
// 완결 표식은 **우리가 처음 돌 때만** 생긴다. 그것이 없다고 고객 트리를 지우면, 배송 문서가
// 안내하는 「폴더 연결」 흐름을 탄 고객은 **첫 실행에서 무조건** 자기 `node_modules` 를 잃는다.

test("고객이 손수 설치한 node_modules 를 준비가 지우지 않는다", async () => {
    const project = await tempDir("zalkera-deps-keep-");
    const cacheRoot = await tempDir("zalkera-deps-cache-");
    await writeFile(join(project, "package.json"), '{"name":"고객소스","dependencies":{"next":"14.0.0"}}');
    await writeFile(join(project, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    await mkdir(join(project, "node_modules", "next", "dist"), {recursive: true});
    const patched = join(project, "node_modules", "next", "dist", "patched.js");
    await writeFile(patched, "// patch-package 산출물");

    const said: string[] = [];
    // `/bin/true` 로 설치를 대신한다 — 이 시험이 보는 것은 **지우는가**이지 설치 결과가 아니다.
    await ensureDependencies({
        projectDir: project,
        cacheRoot,
        npmCommand: ["/bin/true"],
        onProgress: (m) => said.push(m),
    }).catch(() => {});

    ok(existsSync(patched), `고객이 고친 파일이 사라졌다. 안내: ${said.join(" / ")}`);
    ok(
        !said.some((m) => /지우고 다시/.test(m)),
        `지운다고 말했다: ${said.join(" / ")}`,
    );
});
