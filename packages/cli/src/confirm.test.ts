import {match, ok, strictEqual} from "node:assert/strict";
import {Readable, Writable} from "node:stream";
import {test} from "node:test";
import {confirm} from "./confirm.ts";

function tty(answer: string) {
    const input = Readable.from([`${answer}\n`]) as Readable & {isTTY?: boolean};
    input.isTTY = true;
    let written = "";
    const output = new Writable({write(c, _e, cb) { written += String(c); cb(); }});
    return {input, output, said: () => written};
}
function pipe() {
    const input = Readable.from([]) as Readable & {isTTY?: boolean};
    let written = "";
    const output = new Writable({write(c, _e, cb) { written += String(c); cb(); }});
    return {input, output, said: () => written};
}

test("y 는 통과, n 은 거절", async () => {
    const a = tty("y");
    strictEqual(await confirm({question: "버릴까요?", flag: "--yes", ...a}), true);
    const b = tty("n");
    strictEqual(await confirm({question: "버릴까요?", flag: "--yes", ...b}), false);
});

test("🔴 문구를 요구하면 **한 글자로는 안 된다**", async () => {
    const a = tty("y");
    strictEqual(await confirm({question: "?", phrase: "버립니다", flag: "--confirm", ...a}), false);
    const b = tty("버립니다");
    strictEqual(await confirm({question: "?", phrase: "버립니다", flag: "--confirm", ...b}), true);
});

test("🔴 터미널이 아니면 **묻지 않고 멈춘다** — 물으면 영원히 매달린다", async () => {
    const p = pipe();
    strictEqual(await confirm({question: "버릴까요?", flag: "--yes", ...p}), false);
    match(p.said(), /--yes/, "손잡이를 안 알려 준다");
});

test("명시 동의가 있으면 안 묻는다", async () => {
    const p = pipe();
    strictEqual(await confirm({question: "버릴까요?", flag: "--yes", given: true, ...p}), true);
    strictEqual(p.said(), "", "동의가 있는데 뭔가 물었다");
});

test("앞뒤 공백은 관용한다 — 붙여넣기가 흔하다", async () => {
    const a = tty("  버립니다  ");
    strictEqual(await confirm({question: "?", phrase: "버립니다", flag: "--confirm", ...a}), true);
});

test("🔴 비슷한 문구는 안 통한다", async () => {
    for (const bad of ["버림", "버립니다!", "버 립니다", "예"]) {
        const a = tty(bad);
        strictEqual(await confirm({question: "?", phrase: "버립니다", flag: "--confirm", ...a}), false, bad);
    }
});
