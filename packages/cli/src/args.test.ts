import {deepEqual, strictEqual} from "node:assert/strict";
import {test} from "node:test";
import {flagOn, flagValue, parseArgs} from "./args.ts";

test("명령과 플래그를 가른다 — 두 표기를 **둘 다** 받는다", () => {
    deepEqual(parseArgs(["pull", "--site", "acme"]), {command: "pull", positional: [], flags: {site: "acme"}});
    deepEqual(parseArgs(["pull", "--site=acme"]), {command: "pull", positional: [], flags: {site: "acme"}});
});

test("🔴 값 없는 스위치가 다음 플래그를 삼키지 않는다", () => {
    // 삼키면 `--site` 가 통째로 사라지고, 사람은 「사이트를 지정했는데 못 찾는다」를 본다.
    const {flags} = parseArgs(["pull", "--discard-local", "--site", "acme"]);
    strictEqual(flags["discard-local"], true);
    strictEqual(flags.site, "acme");
});

test("`--` 뒤는 전부 값이다 — `-` 로 시작하는 폴더 이름을 넘길 길", () => {
    deepEqual(parseArgs(["pull", "--", "--이상한폴더"]).positional, ["--이상한폴더"]);
});

test("명령이 없으면 `null` 이다", () => {
    strictEqual(parseArgs([]).command, null);
    strictEqual(parseArgs(["--help"]).command, null);
});

test("스위치의 꺼짐 표기를 읽는다", () => {
    strictEqual(flagOn({v: true}, "v"), true);
    strictEqual(flagOn({v: "false"}, "v"), false);
    strictEqual(flagOn({v: "0"}, "v"), false);
    strictEqual(flagOn({v: "no"}, "v"), false);
    strictEqual(flagOn({}, "v"), false);
    strictEqual(flagOn({v: "yes"}, "v"), true);
});

test("🔴 스위치로만 켠 플래그는 **값이 없다** — `true` 를 사이트 코드로 쓰면 남의 사이트를 부른다", () => {
    strictEqual(flagValue({site: true}, "site"), null);
    strictEqual(flagValue({site: ""}, "site"), null);
    strictEqual(flagValue({site: "acme"}, "site"), "acme");
});
