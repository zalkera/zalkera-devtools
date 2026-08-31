import { deepEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ensureAgentDocs } from "./agents.ts";
import { DevtoolsError } from "./errors.ts";
import { registerMcpServer, type McpRegistration } from "./mcp.ts";
import { mcpServerName } from "./serverUrl.ts";
import { tempDir } from "./testing/tempDir.ts";

/**
 * 서버 이름을 **정문으로** 만든다.
 *
 * ⚠ 캐스팅(`as McpServerName`)으로 때우면 시험이 제품의 판정을 건너뛴다 — 제품이 거절할 이름으로
 *   초록이 나고, 그 이름이 실제로 어떻게 되는지는 아무도 안 잰다.
 */
function serverName(value: string) {
    const name = mcpServerName(value);
    if (!name) throw new Error(`제품이 거절하는 서버 이름을 시험이 쓰려 한다: ${value}`);
    return name;
}

const registration: McpRegistration = {
    serverName: serverName("zalkera-site"),
    url: "https://api.zalkera.com/mcp/source/acme",
    clientId: "zalkera-mcp",
    authServerMetadataUrl: "https://sso.zalkera.com/realms/zalkera/.well-known/openid-configuration",
};

test("파일이 없으면 만든다", async () => {
    const dir = await tempDir("zalkera-mcp-");
    strictEqual((await registerMcpServer(dir, registration)).action, "created");
    const parsed = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    strictEqual(parsed.mcpServers["zalkera-site"].url, registration.url);
    strictEqual(parsed.mcpServers["zalkera-site"].oauth.clientId, "zalkera-mcp");
});

test("남의 서버 설정과 최상위 키를 보존한다", async () => {
    const dir = await tempDir("zalkera-mcp-");
    await writeFile(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } }, somethingElse: 1 }),
    );

    strictEqual((await registerMcpServer(dir, registration)).action, "updated");
    const parsed = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    strictEqual(parsed.mcpServers.other.command, "x", "남의 서버는 그대로");
    strictEqual(parsed.somethingElse, 1, "우리가 모르는 최상위 키도 그대로");
    ok(parsed.mcpServers["zalkera-site"]);
});

test("같은 값이면 다시 쓰지 않는다", async () => {
    const dir = await tempDir("zalkera-mcp-");
    await registerMcpServer(dir, registration);
    strictEqual((await registerMcpServer(dir, registration)).action, "unchanged");
});

test("깨진 JSON 은 덮지 않고 알린다", async () => {
    const dir = await tempDir("zalkera-mcp-");
    const path = join(dir, ".mcp.json");
    await writeFile(path, "{ 이건 JSON 이 아니다");

    await rejects(
        () => registerMcpServer(dir, registration),
        (error: unknown) => error instanceof DevtoolsError && /형식 오류/.test(error.message),
    );
    // **덮어쓰지 않았다는 것이 이 테스트의 본체다** — 남의 설정을 우리가 판단해 버리지 않는다.
    strictEqual(await readFile(path, "utf8"), "{ 이건 JSON 이 아니다");
});

test("규약 문서: 있으면 손대지 않고, 없으면 포인터만 만든다", async () => {
    const dir = await tempDir("zalkera-agents-");
    await writeFile(join(dir, "AGENTS.md"), "# 팩이 준 정본\n내용 있음\n");

    const first = await ensureAgentDocs(dir);
    strictEqual(first.agents, "kept", "팩이 준 정본은 불가침");
    strictEqual(first.claude, "created");
    strictEqual(await readFile(join(dir, "AGENTS.md"), "utf8"), "# 팩이 준 정본\n내용 있음\n");
    ok((await readFile(join(dir, "CLAUDE.md"), "utf8")).includes("@AGENTS.md"), "참조 한 줄");

    // 두 번째 호출은 아무것도 안 바꾼다.
    const second = await ensureAgentDocs(dir);
    strictEqual(second.agents, "kept");
    strictEqual(second.claude, "kept");
});

test("AGENTS.md 스텁에 규약을 복사하지 않는다(정본 포인터만)", async () => {
    const dir = await tempDir("zalkera-agents-");
    await ensureAgentDocs(dir);
    const stub = await readFile(join(dir, "AGENTS.md"), "utf8");
    ok(stub.includes("llms.txt"), "정본을 가리킨다");
    ok(stub.length < 600, `사본이 아니라 포인터여야 한다(길이 ${stub.length})`);
});

/**
 * ─── 남의 항목 보호 ───────────────────────────────────────────────────────────
 *
 * 이름 형태 검사는 `github` 같은 **흔한 이름**을 막지 못한다(형태가 옳다). 그 자리에 고객이 쓰던
 * stdio 서버가 있으면 토큰이 든 `env` 째로 사라지고 우리는 "갱신"이라 보고한다 — 유출이 아니라
 * **파괴**다. 그래서 이름이 아니라 **형상**으로 소유를 판정한다.
 */
test("이름이 겹쳐도 남의 항목은 덮지 않는다", async () => {
    const dir = await tempDir("mcp-foreign-");
    try {
        const before = JSON.stringify(
            { mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN: "ghp_REAL" } } } },
            null,
            2,
        );
        await writeFile(join(dir, ".mcp.json"), `${before}\n`);
        await rejects(
            () => registerMcpServer(dir, { serverName: serverName("github"), url: "https://mcp.zalkera.com/x", clientId: "a", authServerMetadataUrl: "https://auth.example/x" }),
            (error: unknown) => error instanceof DevtoolsError,
            "남의 항목을 덮었다",
        );
        strictEqual(await readFile(join(dir, ".mcp.json"), "utf8"), `${before}\n`, "파일이 바뀌었다");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("통제군 — 우리가 적은 항목은 갱신한다", async () => {
    const dir = await tempDir("mcp-ours-");
    try {
        const reg = { serverName: serverName("zalkera"), url: "https://mcp.zalkera.com/a", clientId: "a", authServerMetadataUrl: "https://auth.example/x" };
        strictEqual((await registerMcpServer(dir, reg)).action, "created");
        strictEqual((await registerMcpServer(dir, reg)).action, "unchanged");
        strictEqual((await registerMcpServer(dir, { ...reg, url: "https://mcp.zalkera.com/b" })).action, "updated");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("`.mcp.json` 이 심링크면 쓰지 않는다 — 링크 대상이 남의 파일이다", async () => {
    const victim = await tempDir("victim-");
    const dir = await tempDir("mcp-link-");
    try {
        // ⚠ 링크 대상은 **유효 JSON** 이어야 한다. 깨진 내용으로 두면 `JSON.parse` 가 먼저 던져
        //   `rejects` 가 그것을 받고 통과한다 — 가드를 지워도 초록인 시험이 된다(실측으로 겪음).
        const original = '{"mcpServers":{"other":{"type":"http","url":"https://other.example/x"}}}\n';
        await writeFile(join(victim, "target.json"), original);
        await symlink(join(victim, "target.json"), join(dir, ".mcp.json"));
        await rejects(
            () => registerMcpServer(dir, { serverName: serverName("zalkera"), url: "https://mcp.zalkera.com/x", clientId: "a", authServerMetadataUrl: "https://auth.example/x" }),
            (error: unknown) => error instanceof DevtoolsError && /링크라 쓰지 않았습니다/.test(error.message),
            "심링크를 따라 링크 대상에 썼다",
        );
        strictEqual(await readFile(join(victim, "target.json"), "utf8"), original, "링크 대상이 바뀌었다");
    } finally {
        await rm(victim, { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
    }
});


/**
 * `.mcp.json` 에 **stdio 항목이 우리 이름으로 적혀 있을 때** 그 위에 다시 적는 자리.
 *
 * ⚠ **옛 로컬 등록과 키가 겹치지는 않는다** — 그쪽은 `zalkera-source` 로 못박았고 원격은
 *   핸드셰이크가 준 이름(기본·상용 `zalkera-site`)을 쓴다. 이 갈래가 지키는 것은 **손으로
 *   적힌 항목**이다: `.mcp.json` 은 사람이 여는 파일이고 서버 이름은 설정으로 바뀐다.
 *
 * 판정은 양쪽으로 틀릴 수 있다. 못 알아보면 우리가 적은 항목을 우리가 거절해 「잘커라에
 * 문의해 주세요」로 **영구 잠김**이 되고, 너무 넓게 알아보면 남의 항목을 **토큰째로** 지운다.
 */
const oldLocalEntry = (extra: Record<string, unknown>) => ({ type: "stdio", ...extra });

test("🔴 옛 판이 적은 stdio 항목은 우리 것으로 알아본다 — 못 알아보면 영구 잠김이다", async () => {
    const ours = [
        oldLocalEntry({ command: "npx", args: ["-y", "@zalkera/cli@0.20.2", "mcp", "--folder", "/x"] }),
        oldLocalEntry({ command: "npx", args: ["-y", "zalkera-cli", "mcp"] }),
        { command: "zalkera", args: ["mcp"] },
        // 🔴 **확장 동봉본**(vsix 안). 이름으로만 재므로 설치 자리가 달라도 알아봐야 한다.
        oldLocalEntry({ command: "/usr/bin/node", args: ["/ext/dist/zalkera-cli.js", "mcp", "--folder", "/x"] }),
        // 🔴 **개발 배치.** 이 모양을 못 알아보면 개발 기계에서 우리가 적은 항목을 우리가 거절한다.
        oldLocalEntry({ command: "/usr/bin/node", args: ["/w/packages/cli/dist/main.js", "mcp"] }),
    ];
    for (const entry of ours) {
        const dir = await tempDir("mcp-old-ours-");
        try {
            await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "zalkera-source": entry } }));
            const result = await registerMcpServer(dir, { ...registration, serverName: serverName("zalkera-source") });
            strictEqual(result.action, "updated", `못 알아봤다: ${JSON.stringify(entry)}`);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

test("🔴 남의 stdio 항목은 안 덮는다 — 그 env 에 남의 토큰이 있다", async () => {
    // ⚠ 맨 낱말 `zalkera` 로는 우리 것이 안 된다. 하위 명령까지 겹쳐도 마찬가지다 —
    //   그 둘을 **함께** 봐야 우리 것인데, 하나만 보면 아래가 전부 덮인다(유출이 아니라 파괴다).
    const theirs = [
        { type: "stdio", command: "node", args: ["srv.js", "zalkera"], env: { GITHUB_TOKEN: "비밀" } },
        { command: "uvx", args: ["mcp-server", "zalkera"], env: { API_KEY: "비밀" } },
        { command: "docker", args: ["run", "-i", "zalkera"], env: { TOK: "비밀" } },
        { command: "docker", args: ["run", "-i", "zalkera", "mcp"], env: { TOK: "비밀" } },
        { type: "stdio", command: "node", args: ["srv.js", "zalkera", "mcp"], env: { T: "비밀" } },
        // 우리 하위 명령만 있고 우리 이름이 없는 모양 — 이것만으로는 우리 것이 아니다.
        { type: "stdio", command: "npx", args: ["-y", "somebody-else", "mcp"], env: { TOKEN: "비밀" } },
        // 🔴 **반대 짝** — 우리 이름은 있는데 우리 하위 명령이 없다. `runsOurVerb` 를 지우는
        //    변이가 이 줄 없이는 **전건 초록**이었다(실측). 우리 CLI 를 `mcp` 가 아닌 다른
        //    하위 명령으로 쓰는 남의 항목이 그 순간 토큰째로 덮인다.
        { type: "stdio", command: "npx", args: ["-y", "@zalkera/cli", "doctor"], env: { TOKEN: "비밀" } },
        { command: "zalkera", args: ["preview"], env: { TOKEN: "비밀" } },
        { type: "stdio", command: "node", args: ["/ext/dist/zalkera-cli.js", "login"], env: { TOKEN: "비밀" } },
        // 🔴 **경로 닻** — `OUR_BUNDLE` 이 파일 **이름**으로 재는데 그 닻을 재는 자리가 없었다.
        //    닻을 느슨하게 하면 아래가 전부 우리 것이 된다(실측: 앞·뒤·경로 닻 셋 다 무그물이었다).
        { type: "stdio", command: "node", args: ["/opt/other/dist/main.js", "mcp"], env: { TOKEN: "비밀" } },
        { type: "stdio", command: "node", args: ["/opt/other/notzalkera-cli.js", "mcp"], env: { TOKEN: "비밀" } },
        { type: "stdio", command: "node", args: ["/w/packages/cli/dist/main.js.bak", "mcp"], env: { TOKEN: "비밀" } },
    ];
    for (const entry of theirs) {
        const dir = await tempDir("mcp-old-theirs-");
        try {
            await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "zalkera-source": entry } }));
            await rejects(
                () => registerMcpServer(dir, { ...registration, serverName: serverName("zalkera-source") }),
                (error: unknown) => error instanceof DevtoolsError,
                `덮었다: ${JSON.stringify(entry)}`,
            );
            const after = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")) as {
                mcpServers: Record<string, { env?: Record<string, string> }>;
            };
            ok(after.mcpServers["zalkera-source"]?.env, `남의 env 가 사라졌다: ${JSON.stringify(entry)}`);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

/**
 * **원격(http) 항목의 표식은 `oauth` 짝이다** — `type: "http"` 가 아니다.
 *
 * ⚠ 그 짝 검사를 지우는 변이가 **전건 초록이었다**(실측 888/888). `type === "http"` 로만 재면
 * Linear·Sentry 처럼 http 로 붙는 남의 항목이 우리 것이 되어, `headers.Authorization` 에 토큰을
 * 단 항목이 통째로 사라진다. 그 위험은 `isOurEntry` KDoc 이 이미 적어 뒀는데 **재는 자리가
 * 없었다** — 적어 둔 것과 지키는 것은 다르다.
 *
 * ⚠ **없음만 세지 않는다.** 우리 형상(짝이 갖춰진 항목)은 **실제로 갱신된다**를 함께 문다.
 * 안 그러면 「전부 거절」로 고쳐도 초록이다.
 */
test("🔴 남의 http 항목은 안 덮는다 — 표식은 type 도, oauth 짝도 아니다", async () => {
    const theirs = [
        // 🔴 **짝이 갖춰진 남의 항목.** 이것이 이 시험의 핵심이다 — `{type, oauth:{clientId,
        //    authServerMetadataUrl}}` 는 OAuth 원격 서버를 적는 **일반 스키마**라 우리를 가리키는
        //    바이트가 하나도 없다. 짝만 보던 판에서 이 항목이 **변이 없이** 덮였다(실측:
        //    action=updated · Authorization 헤더 소멸). 그래서 주소(origin)를 함께 본다.
        {
            type: "http",
            url: "https://mcp.linear.app/sse",
            oauth: { clientId: "linear-client-1234", authServerMetadataUrl: "https://linear.app/.well-known/oauth-authorization-server" },
            headers: { Authorization: "Bearer 비밀" },
        },
        {
            type: "http",
            url: "https://mcp.sentry.dev/mcp",
            oauth: { clientId: "sentry", authServerMetadataUrl: "https://sentry.io/.well-known/oauth-authorization-server" },
            headers: { Authorization: "Bearer 비밀" },
        },
        // 짝이 통째로 없다 — 가장 흔한 남의 형상.
        { type: "http", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer 비밀" } },
        // 짝이 반만 있다. 하나만 보는 판정이면 여기서 샌다.
        { type: "http", url: "https://x/mcp", oauth: { clientId: "남" }, headers: { Authorization: "비밀" } },
        { type: "http", url: "https://x/mcp", oauth: { authServerMetadataUrl: "https://남/.well-known" }, headers: { Authorization: "비밀" } },
        // 짝은 있는데 타입이 아니다 — `typeof` 를 느슨하게 하면 샌다.
        // ⚠ **`null` 을 쓰지 않는다.** `null` 반쪽은 `!= null`·truthiness 느슨화를 **스스로 무력화**해
        //    자연스러운 느슨화 셋 중 둘을 못 잡는다(실측). 숫자로 둘 다 물린다.
        { type: "http", url: "https://x/mcp", oauth: { clientId: 1, authServerMetadataUrl: 2 }, headers: { Authorization: "비밀" } },
        // 🔴 **주소는 우리 것인데 짝이 반만 있는 항목.** 위의 남의-origin 반쪽 항목은 origin 에서
        //    먼저 걸려 짝 검사에 하중이 안 갔다 — 한쪽만 보는 변이 둘이 생존했다(실측). 두 검사가
        //    서로를 가리므로 **한 축만 틀린** 항목이 양쪽에 다 필요하다.
        {
            type: "http",
            url: "https://api.zalkera.com/mcp/source/somebody",
            oauth: { clientId: "남" },
            headers: { Authorization: "비밀" },
        },
        {
            type: "http",
            url: "https://api.zalkera.com/mcp/source/somebody",
            oauth: { authServerMetadataUrl: "https://남/.well-known" },
            headers: { Authorization: "비밀" },
        },
        // 🔴 **주소는 우리 것인데 짝의 타입이 틀린 항목.** 위 줄은 주소가 남의 것이라 origin 에서
        //    먼저 걸려, 짝 검사를 느슨하게 해도 초록이었다(실측: `!= null`·truthiness 둘 다 생존).
        //    두 검사가 서로를 가리지 않게 **한 축만 틀린** 항목을 함께 둔다.
        {
            type: "http",
            url: "https://api.zalkera.com/mcp/source/somebody",
            oauth: { clientId: 1, authServerMetadataUrl: 2 },
            headers: { Authorization: "비밀" },
        },
        // 🔴 **짝은 온전하고 주소만 «거의» 우리 것.** 여기 있는 다른 남의 항목은 오리진이 멀어서
        //    (`linear.app`) 판정을 느슨하게 해도 안 걸렸다 — 「같은 오리진인가」를 「비슷한가」로
        //    바꾸는 변이 넷이 전부 초록이었고, 그 넷은 실제로 **남의 토큰을 지운다**(실측).
        //    비교를 조이는 유일한 하중이 이 셋이다.
        // `startsWith`·`includes` 로 느슨해지면 우리 것으로 오인한다 — 남이 산 다른 TLD.
        {
            type: "http",
            url: "https://api.zalkera.community/mcp",
            oauth: { clientId: "남", authServerMetadataUrl: "https://남/.well-known" },
            headers: { Authorization: "비밀" },
        },
        // 오리진을 호스트(이름)로 낮추면 통과한다 — **평문 http 는 우리 서버가 아니다.**
        {
            type: "http",
            url: "http://api.zalkera.com/mcp",
            oauth: { clientId: "남", authServerMetadataUrl: "https://남/.well-known" },
            headers: { Authorization: "비밀" },
        },
        // 스킴이 없어 `new URL` 이 던진다. try/catch 를 걷으면 `DevtoolsError` 가 아니라
        // 날 `TypeError` 가 올라와 이 문의 술어에서 걸린다.
        {
            type: "http",
            url: "api.zalkera.com/mcp",
            oauth: { clientId: "남", authServerMetadataUrl: "https://남/.well-known" },
            headers: { Authorization: "비밀" },
        },
    ];
    for (const entry of theirs) {
        const dir = await tempDir("mcp-http-theirs-");
        try {
            await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "zalkera-site": entry } }));
            await rejects(
                () => registerMcpServer(dir, registration),
                (error: unknown) => error instanceof DevtoolsError,
                `덮었다: ${JSON.stringify(entry)}`,
            );
            const after = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")) as {
                mcpServers: Record<string, { headers?: Record<string, string> }>;
            };
            ok(after.mcpServers["zalkera-site"]?.headers, `남의 헤더가 사라졌다: ${JSON.stringify(entry)}`);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

/**
 * 우리 형상은 **실제로 갱신된다.**
 *
 * ⚠ **변이 하중은 0 이다.** 이 문을 지워도 관련 변이가 전부 red 로 남는다(실측) — 같은 축을
 *   위 `mcp.zalkera.com/a`→`/b` 통제군이 이미 물고 있다. 그런데도 두는 이유는 이것이 **실제
 *   등록 픽스처(`registration`)의 주소**로 「우리 것은 갱신된다」를 이름 붙여 적은 유일한
 *   자리이기 때문이다. 읽는 사람을 위한 문이지 그물이 아니다.
 */
test("🔴 우리 http 항목은 갱신된다 — 같은 서버의 다른 경로도 우리 것이다", async () => {
    const dir = await tempDir("mcp-http-ours-");
    try {
        await writeFile(
            join(dir, ".mcp.json"),
            JSON.stringify({
                mcpServers: {
                    "zalkera-site": {
                        type: "http",
                        url: "https://api.zalkera.com/mcp/source/OLD",
                        oauth: { clientId: "zalkera-mcp", authServerMetadataUrl: "https://sso/.well-known" },
                    },
                },
            }),
        );
        const result = await registerMcpServer(dir, registration);
        strictEqual(result.action, "updated");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
