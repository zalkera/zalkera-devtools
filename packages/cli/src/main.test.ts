import {match, strictEqual} from "node:assert/strict";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {test} from "node:test";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

/** 실제 프로세스로 부른다 — 배선(인자 → 갈래 → 종료 코드)이 여기 살기 때문이다. */
const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

/**
 * 시험이 쓰는 환경. **서버를 닿지 않는 주소로 못박는다.**
 * 안 그러면 이 시험이 상용을 두드린다 — 실제로 그랬다
 *   (`--revision abc` 갈래가 핸드셰이크를 먼저 치르고 있었다). 시험이 초록인 이유가 「인자 검증이
 *   먼저라서」인지 「서버가 마침 답해서」인지 갈리면 그 시험은 아무것도 안 재는 것이다.
 */
const OFFLINE = {...process.env, ZALKERA_SERVER: "http://127.0.0.1:1"};

async function cli(...args: string[]): Promise<{code: number; out: string; err: string}> {
    try {
        const {stdout, stderr} = await run(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {env: OFFLINE});
        return {code: 0, out: stdout, err: stderr};
    } catch (error) {
        const e = error as {code?: number; stdout?: string; stderr?: string};
        return {code: e.code ?? 1, out: e.stdout ?? "", err: e.stderr ?? ""};
    }
}

test("🔴 `--version` 은 판을 낸다 — 도움말이 아니다", async () => {
    const {code, out} = await cli("--version");
    strictEqual(code, 0);
    match(out.trim(), /^\d+\.\d+\.\d+$/, `판이 아니라 이것이 나왔다: ${out.slice(0, 40)}`);
});

test("명령이 없으면 도움말이다", async () => {
    const {code, out} = await cli();
    strictEqual(code, 0);
    match(out, /zalkera pull/);
});

test("🔴 도움말이 **평문 보관**을 말한다 — 배송 문서가 적어야 하는 사실이다", async () => {
    const {out} = await cli("--help");
    match(out, /평문/);
    match(out, /고치고 배포할 수 있습니다/);
});

test("모르는 명령은 종료 코드 2 다 — 스크립트가 「오타」와 「실패」를 가른다", async () => {
    const {code, err} = await cli("없는명령");
    strictEqual(code, 2);
    match(err, /모르는 명령/);
});

test("🔴 소속을 모르면 **묻지 않고 멈춘다** — 아무 사이트나 고르면 남의 사이트에 올린다", async () => {
    const {code, err} = await cli("status", "--folder", fileURLToPath(new URL(".", import.meta.url)));
    strictEqual(code, 1);
    match(err, /어느 사이트의 것인지 알 수 없습니다/);
});

test("🔴 판 번호가 숫자가 아니면 **네트워크 전에** 거절한다", async () => {
    // 서버는 닿지 않는 주소다. 그래도 이 문면이 나와야 검증이 앞이라는 뜻이다 —
    // 「서버에 연결하지 못했습니다」가 나오면 순서가 뒤집힌 것이다.
    for (const bad of ["abc", "0", "-3", "1.5"]) {
        const {code, err} = await cli("pull", "--revision", bad, "--site", "acme", "--folder", "/tmp");
        strictEqual(code, 1, `${bad} 이 통과했다`);
        match(err, /판 번호가 올바르지 않습니다/, `${bad} 에서 다른 이유로 멈췄다: ${err.slice(0, 60)}`);
    }
});

test("🔴 `baseline` 도 같은 순서다 — 갈래마다 순서가 다르면 한쪽만 고쳐진다", async () => {
    const {code, err} = await cli("baseline", "--revision", "abc", "--site", "acme", "--folder", "/tmp");
    strictEqual(code, 1);
    match(err, /판 번호가 올바르지 않습니다/, `순서가 뒤집혔다: ${err.slice(0, 60)}`);
});

test("🔴 `rollback` 의 판 번호도 **네트워크 전에** 걸러진다 — 검증기가 둘이면 한쪽만 조여진다", async () => {
    // `--revision` 과 달리 이것은 **위치 인자**라 검증기가 따로다(`revisionArg`). 형제 셋이
    // 물고 있는 그 규율을 이쪽만 안 따라가면, 되돌리기가 `0`·`-3`·`1.5` 를 그대로 서버로 보낸다.
    for (const bad of ["abc", "0", "-3", "1.5"]) {
        const {code, err} = await cli("rollback", bad, "--site", "acme", "--folder", "/tmp");
        strictEqual(code, 1, `${bad} 이 통과했다`);
        match(err, /버전 번호/, `${bad} 에서 다른 이유로 멈췄다: ${err.slice(0, 80)}`);
    }
});

test("서버에 못 닿으면 그렇게 말한다 — 다른 이유로 위장하지 않는다", async () => {
    const {code, err} = await cli("status", "--site", "acme", "--folder", "/tmp");
    strictEqual(code, 1);
    match(err, /연결하지 못했습니다/);
});

test("🔴 `push` 도 인자 검증이 네트워크보다 앞이다", async () => {
    const {code, err} = await cli("push", "--site", "acme", "--folder", "/tmp", "--revision", "abc");
    strictEqual(code, 1);
    match(err, /판 번호가 올바르지 않습니다/, `순서가 뒤집혔다: ${err.slice(0, 60)}`);
});

test("도움말이 `push` 와 그 동의 손잡이를 말한다", async () => {
    const {out} = await cli("--help");
    match(out, /zalkera push/);
    match(out, /--overwrite-unseen/);
    // ⚠ 그 손잡이가 **무엇을 잃는지** 말해야 한다. 안 말하면 사람은 막힐 때 그냥 붙인다.
    match(out, /그 편집은 사라진다/);
});

test("🔴 이 도구가 사이트 의존에 들어와 있으면 **네트워크 전에** 짚는다 — 확장의 `doctor` 는 CLI 에 안 닿는다", async () => {
    // 그 오인을 하는 쪽이 바로 CLI 를 설치하는 사람이고, 그 사람은 대개 서버 설정도 아직이다.
    // 서버는 닿지 않는 주소다 — 그래도 이 고지는 나와야 한다(로컬 사실이므로).
    const dir = await mkdtemp(join(tmpdir(), "zalkera-misuse-"));
    await writeFile(
        join(dir, "package.json"),
        JSON.stringify({name: "site", dependencies: {next: "15.0.0", "@zalkera/cli": "^0.20.2"}}),
    );
    const {err} = await cli("status", "--site", "acme", "--folder", dir);
    match(err, /@zalkera\/cli 가 이 사이트의 의존으로 들어 있습니다/, `안 짚었다: ${err.slice(0, 200)}`);
    match(err, /package\.json/, "무엇을 하라는지 안 말한다");
});

test("🔴 `preview` 의 포트도 **네트워크·프로세스 기동보다 먼저** 걸러진다", async () => {
    // 뒤에 두면 오타 하나가 의존성 설치(수 분)를 치른 뒤에야 드러난다.
    for (const bad of ["abc", "0", "80", "70000", "1.5", "-1"]) {
        const {code, err} = await cli("preview", "--port", bad, "--site", "acme", "--folder", "/tmp");
        strictEqual(code, 1, `${bad} 이 통과했다`);
        match(err, /미리보기 포트가 올바르지 않습니다/, `${bad} 에서 다른 이유로 멈췄다: ${err.slice(0, 80)}`);
    }
});

test("`preview` 가 도움말과 명령 목록에 있다 — 없는 명령을 문서가 약속하면 안 된다", async () => {
    const {out} = await cli("--help");
    match(out, /zalkera preview/);
});
