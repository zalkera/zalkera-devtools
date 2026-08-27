/**
 * **로컬 MCP 서버를 실제 프로세스로 몬다.**
 *
 * ⚠ **여기서 재는 것이 SDK 를 안 쓴 대가다.** 전송·프레이밍·오류 코드를 우리가 지고 있으므로,
 *   그 계약을 시험이 들고 있어야 한다. 함수를 직접 부르면 프레이밍(줄바꿈·stdout 순수성)이
 *   시험 밖으로 나간다 — 그리고 그것이 틀리면 사람에게는 「도구가 안 뜬다」로만 보인다.
 */
import {deepEqual, match, ok, strictEqual} from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));
/** 서버는 **닿지 않는 주소**다 — 시험이 상용을 두드리면 안 된다. */
const OFFLINE = {...process.env, ZALKERA_SERVER: "http://127.0.0.1:1"};

interface Frame {
    id?: number | string | null;
    result?: Record<string, unknown>;
    error?: {code: number; message: string};
}

/** 줄들을 stdin 으로 밀어 넣고 stdout 을 프레임으로 읽는다. */
async function speak(lines: string[], folder = "/tmp"): Promise<{frames: Frame[]; err: string; raw: string}> {
    const child = execFile(process.execPath, ["--experimental-strip-types", ENTRY, "mcp", "--site", "acme", "--folder", folder], {
        env: OFFLINE,
    });
    child.stdin?.end(lines.map((l) => `${l}\n`).join(""));
    const {stdout, stderr} = await new Promise<{stdout: string; stderr: string}>((resolve) => {
        let out = "";
        let err = "";
        child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
        child.on("close", () => resolve({stdout: out, stderr: err}));
    });
    const frames = stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Frame);
    return {frames, err: stderr, raw: stdout};
}

const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}';

test("초기화 → 도구 목록. **카탈로그는 넷이다**", async () => {
    const {frames} = await speak([INIT, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}']);
    strictEqual(frames[0]?.result?.protocolVersion, "2025-06-18");
    const tools = (frames[1]?.result?.tools ?? []) as Array<{name: string; inputSchema: unknown}>;
    deepEqual(
        tools.map((t) => t.name),
        ["zalkera_status", "zalkera_pull", "zalkera_push", "zalkera_publish"],
    );
});

test("🔴 파괴적 동사는 **카탈로그 밖**이다 — 모델이 부르는 자리에서는 확인이 사람을 안 지난다", async () => {
    // 카탈로그가 곧 매 대화의 고객 토큰이다(§2.6). 넓히기는 쉽고 좁히기는 계약 파기다.
    const {frames} = await speak([INIT, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}']);
    const names = ((frames[1]?.result?.tools ?? []) as Array<{name: string}>).map((t) => t.name).join(" ");
    for (const banned of ["rollback", "discard", "preview", "baseline"]) {
        ok(!names.includes(banned), `${banned} 가 카탈로그에 실렸다: ${names}`);
    }
});

test("🔴 알림에는 **답하지 않는다** — 규격이 금지한다", async () => {
    const {frames} = await speak([INIT, '{"jsonrpc":"2.0","method":"notifications/initialized"}']);
    strictEqual(frames.length, 1, `알림에 답했다: ${JSON.stringify(frames)}`);
});

test("🔴 `initialize` 전 도구 호출은 받지 않는다 — 판 협상 없이 사이트를 고치게 된다", async () => {
    const {frames} = await speak(['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"zalkera_status"}}']);
    strictEqual(frames[0]?.error?.code, -32600);
});

test("모르는 메서드·도구는 규격 코드로 답한다", async () => {
    const {frames} = await speak([
        INIT,
        '{"jsonrpc":"2.0","id":2,"method":"nosuch"}',
        '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope"}}',
    ]);
    strictEqual(frames[1]?.error?.code, -32601, "모르는 메서드");
    strictEqual(frames[2]?.error?.code, -32602, "모르는 도구");
});

test("🔴 JSON 이 아니면 `id` 를 **지어내지 않는다** — 상대가 엉뚱한 요청의 답으로 짝짓는다", async () => {
    const {frames} = await speak([INIT, "이건 JSON 이 아니다"]);
    strictEqual(frames[1]?.id, null);
    strictEqual(frames[1]?.error?.code, -32700);
});

test("🔴 도구가 거절한 것은 **프로토콜 오류가 아니다** — `isError` 로 실어야 모델이 다음 걸음을 고른다", async () => {
    const {frames} = await speak([
        INIT,
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"zalkera_status","arguments":{}}}',
    ]);
    const result = frames[1]?.result;
    ok(result, `RPC 오류로 냈다: ${JSON.stringify(frames[1])}`);
    strictEqual(result.isError, true);
    match(JSON.stringify(result.content), /연결하지 못했습니다/, "사람이 읽을 문장이 아니다");
});

test("🔴 **stdout 에는 프로토콜만 나간다** — 사람에게 할 말이 섞이면 상대가 파싱에 실패한다", async () => {
    // 그리고 그 실패는 사람에게 「도구가 안 뜬다」로만 보인다. 고지가 나오는 폴더로 몬다.
    const dir = await mkdtemp(join(tmpdir(), "zalkera-mcp-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({name: "s", dependencies: {"@zalkera/cli": "^1.0.0"}}));
    const {raw, err} = await speak(
        [INIT, '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"zalkera_status","arguments":{}}}'],
        dir,
    );
    for (const line of raw.split("\n").filter((l) => l.trim() !== "")) JSON.parse(line);
    match(err, /의존으로 들어 있습니다/, "고지가 stderr 로 안 갔다");
});

test("🔴 서버가 안 돼도 `tools/list` 는 답한다 — 목록을 못 그리면 에이전트가 도구를 아예 안 본다", async () => {
    // 컨텍스트를 처음부터 열면 서버가 안 되는 순간 이 서버는 통째로 쓸모가 없어진다.
    const {frames} = await speak([INIT, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}']);
    ok(frames[1]?.result, `목록이 오류로 났다: ${JSON.stringify(frames[1])}`);
});
