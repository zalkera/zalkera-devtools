/**
 * **서버가 준 이름으로 파일 경로를 짓기 전에 무엇이 걸러지는가.**
 *
 * 이 함수가 없던 자리에서 실제로 새었다: 「소스 zip 다운로드」가 판 번호를 걸러 주지 않고
 * 파일 이름에 그대로 이어 붙였다(심의 실증). 타입이 `number` 라도 그것은 **컴파일타임 약속**일
 * 뿐이고, 응답 본문에는 런타임 스키마 검증이 없다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute, join, relative, resolve } from "node:path";
import { safeFileName } from "./safeWrite.ts";

/** 저장 대화상자의 기본 경로를 짓는 그 계산 그대로. */
const under = (base: string, raw: string) => resolve(join(base, safeFileName(raw, "fallback")));

test("무엇을 넣어도 고른 폴더 밖을 가리키지 않는다", () => {
    const base = resolve("/tmp/zalkera-base");
    const attacks = [
        "../../etc/passwd",
        "..\\..\\Windows\\System32",
        "/etc/shadow",
        "C:\\Users\\me\\.ssh\\id_rsa",
        "....//....//escape",
        "1 [열기](command:workbench.action.terminal.new)",
        "a\u0000b",
        "\u2215etc\u2215passwd",     // 유니코드 나눗셈 기호 — 슬래시로 보인다
        "\uFF0Fetc\uFF0Fpasswd",     // 전각 슬래시
        "..",
        ".",
        "",
        "-".repeat(300),
        "x".repeat(500),
    ];
    for (const raw of attacks) {
        const out = under(base, raw);
        const rel = relative(base, out);
        assert.ok(
            rel !== "" && !rel.startsWith("..") && !isAbsolute(rel),
            `폴더 밖을 가리킨다: ${JSON.stringify(raw)} → ${out}`,
        );
    }
});

test("비면 부른 쪽이 준 이름을 쓴다 — 빈 이름은 폴더를 가리킨다", () => {
    // 빈 문자열이 그대로 나가면 `join(base, "")` 이 폴더 자신이 되고, 저장 대화상자에서
    // 그 실수는 눈에 안 띈다.
    for (const raw of ["", "...", "///", "---", "\u0000"]) {
        assert.equal(safeFileName(raw, "fallback"), "fallback", `빈 이름이 나갔다: ${JSON.stringify(raw)}`);
    }
});

test("멀쩡한 이름은 그대로 둔다 — 과하게 뭉개면 파일을 못 알아본다", () => {
    assert.equal(safeFileName("skeleton", "x"), "skeleton");
    assert.equal(safeFileName("3.2.4", "x"), "3.2.4");
    assert.equal(safeFileName("beauty-nail", "x"), "beauty-nail");
    assert.equal(safeFileName("my_site", "x"), "my_site");
    assert.equal(safeFileName("42", "0"), "42");
});

test("이름은 상한을 넘지 않는다 — 파일시스템이 거절하는 자리다", () => {
    assert.ok(safeFileName("z".repeat(400), "x").length <= 80);
});
