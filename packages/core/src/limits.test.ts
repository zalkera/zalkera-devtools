/**
 * **상한이 「유도」인지 「복사」인지를 시험이 지킨다.**
 *
 * 네 파일에 리터럴로 흩어져 있던 시절, `unzip.ts` 주석은 「150 × 3 ≒ 450 이므로」라고 적고
 * 값은 **400MB 를 타이핑**해 뒀다. 그리고 `untar.ts` 의 천장(200MB)이 소스 상한(400MB)보다
 * 낮아, 넓히려는 호출이 조용히 되죄어졌다 — 「상한을 한 규칙으로」라고 적은 커밋이 실제로는
 * 서지 않았던 것이다.
 *
 * 그래서 여기서 지키는 것은 **값**이 아니라 **관계**다. 숫자를 바꾸는 것은 자유이고, 관계를
 * 깨는 것만 빨개진다.
 */
import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { MAX_DOWNLOAD_BYTES, MAX_ENTRY_BYTES, MAX_EXTRACT_BYTES, MEASURED_EXPANSION } from "./limits.ts";

test("해제 상한은 전선 상한에서 **계산된다** — 적어 두는 것이 아니다", () => {
    strictEqual(MAX_EXTRACT_BYTES, MAX_DOWNLOAD_BYTES * MEASURED_EXPANSION);
});

test("팽창비는 실측 범위(2.5~3배) 안이다", () => {
    ok(MEASURED_EXPANSION >= 2.5 && MEASURED_EXPANSION <= 3, `${MEASURED_EXPANSION}`);
});

test("항목 하나가 트리 전체보다 클 수 없다", () => {
    ok(MAX_ENTRY_BYTES <= MAX_EXTRACT_BYTES);
});

test("2GB 네이티브 abort 선 아래에 있다 — 어느 상한이든", () => {
    // 2GB 를 넘는 신고는 Node 를 abort 로 죽인다(재심의 차단). 오류가 아니라 **프로세스 사망**이라
    // 잡을 수 없다 — 그래서 그 선은 근처에도 못 간다.
    for (const [name, value] of [
        ["MAX_ENTRY_BYTES", MAX_ENTRY_BYTES],
        ["MAX_DOWNLOAD_BYTES", MAX_DOWNLOAD_BYTES],
    ] as const) {
        ok(value < 2 * 1024 * 1024 * 1024, name);
    }
});

test("전선 상한은 업로드 상한(100MB)보다 넉넉하다 — 올린 것을 되받을 수 있어야 한다", () => {
    // 올릴 수는 있는데 되받을 수 없으면 그것이 곧 데이터 유폐다. 되받기가 이 도구의 본체다.
    ok(MAX_DOWNLOAD_BYTES > 100 * 1024 * 1024);
});
