import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { plainNotice } from "./notice.ts";

/** 알림이 링크로 만드는 형태. 이 시험이 재는 것은 «이것이 안 남는가» 하나다. */
const RENDERS_AS_LINK = /\[[^\]]*\]\s*\(\s*[A-Za-z][A-Za-z0-9+.-]*:/;

test("명령 링크를 남기지 않는다", () => {
    const attack = "새 판이 있습니다. [지금 업데이트](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22id%22%7D)";
    const out = plainNotice(attack);
    ok(!RENDERS_AS_LINK.test(out), out);
    ok(out.includes("지금 업데이트"), "글자는 남아야 사람이 무슨 일이 있었는지 안다");
});

test("파일 링크도 남기지 않는다", () => {
    ok(!RENDERS_AS_LINK.test(plainNotice("[열기](file:///home/u/.ssh/id_rsa)")));
});

test("스킴 목록에 기대지 않는다 — 콜론이 있는 것 전부", () => {
    for (const scheme of ["command", "file", "https", "vscode", "vscode-insiders", "x-new-thing"]) {
        const out = plainNotice(`[a](${scheme}://x)`);
        ok(!RENDERS_AS_LINK.test(out), `${scheme}: ${out}`);
    }
});

test("공백을 끼워 넣어도 안 통한다", () => {
    for (const attack of ["[a] (command:x)", "[a]  (  command:x )", "[a]\t(command:x)"]) {
        ok(!RENDERS_AS_LINK.test(plainNotice(attack)), attack);
    }
});

test("평범한 괄호는 그대로 둔다 — 우리 문장이 괄호를 쓴다", () => {
    const ours = "새 버전(0.1.41)이 있습니다. 지금 버전(0.1.39)으로도 쓸 수 있습니다.";
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
    for (const bad of [null, undefined, 0, {}, []]) strictEqual(plainNotice(bad), "");
});
