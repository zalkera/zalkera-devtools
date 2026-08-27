import { deepEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ensureAgentDocs } from "./agents.ts";
import { DevtoolsError } from "./errors.ts";
import { registerLocalMcpServer, registerMcpServer, type McpRegistration } from "./mcp.ts";
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

test("로컬(stdio) 서버를 적는다 — 주소·OAuth 가 없고 **토큰도 없다**", async () => {
    const dir = await tempDir("zalkera-mcp-local-");
    await registerLocalMcpServer(dir, {serverName: serverName("zalkera-source"), command: "npx", args: ["-y", "@zalkera/cli", "mcp"]});
    const written = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, {type: string; command: string; args: string[]; env?: unknown}>;
    };
    const entry = written.mcpServers["zalkera-source"];
    strictEqual(entry?.type, "stdio");
    strictEqual(entry.command, "npx");
    ok(entry.args.includes("@zalkera/cli"), "우리 패키지 이름이 인자에 없다 — 소유 판별이 안 된다");
    // `.mcp.json` 은 팀이 공유하고 레포에 들어간다. 로그인은 그 명령이 자기 보관소에서 읽는다.
    strictEqual(entry.env, undefined, "설정 파일에 자격증명 자리를 만들었다");
});

test("🔴 로컬·원격이 **한 파일에 같이** 산다 — 한쪽이 다른 쪽을 안 지운다", async () => {
    const dir = await tempDir("zalkera-mcp-both-");
    await registerMcpServer(dir, {
        serverName: serverName("zalkera"), url: "https://api.example.com/mcp",
        clientId: "c", authServerMetadataUrl: "https://auth.example.com/.well-known/x",
    });
    await registerLocalMcpServer(dir, {serverName: serverName("zalkera-source"), command: "npx", args: ["-y", "@zalkera/cli", "mcp"]});
    const written = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")) as {mcpServers: Record<string, unknown>};
    deepEqual(Object.keys(written.mcpServers).sort(), ["zalkera", "zalkera-source"]);
});

test("🔴 **남의 stdio 항목은 안 덮는다** — `command` 가 흔해서 그것만 보면 토큰째로 파괴한다", async () => {
    const dir = await tempDir("zalkera-mcp-theirs-");
    await writeFile(
        join(dir, ".mcp.json"),
        JSON.stringify({mcpServers: {"zalkera-source": {command: "npx", args: ["-y", "somebody-else"], env: {TOKEN: "비밀"}}}}),
    );
    await rejects(
        () => registerLocalMcpServer(dir, {serverName: serverName("zalkera-source"), command: "npx", args: ["-y", "@zalkera/cli", "mcp"]}),
        (e: unknown) => e instanceof DevtoolsError,
    );
    const after = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, {env?: Record<string, string>}>;
    };
    strictEqual(after.mcpServers["zalkera-source"]?.env?.TOKEN, "비밀", "남의 토큰을 지웠다");
});

test("🔴 **옛 이름으로 적힌 우리 항목도 우리 것으로 본다** — 아니면 개명한 날 다시 등록을 못 한다", async () => {
    // ⚠ **맨 낱말 `zalkera` 는 뺐다.** 남의 항목이 그 낱말 하나로 우리 것이 되기 때문이고
    //   (`docker run -i zalkera mcp` · 실측), npm 이 그 이름을 거절해 우리가 쓴 적도 없다.
    //   실제로 쓰인 옛 이름은 스코프 붙은 것들이다.
    const dir = await tempDir("zalkera-mcp-old-");
    await writeFile(
        join(dir, ".mcp.json"),
        JSON.stringify({mcpServers: {"zalkera-source": {type: "stdio", command: "npx", args: ["-y", "@zalkera/devtools", "mcp"]}}}),
    );
    const result = await registerLocalMcpServer(dir, {
        serverName: serverName("zalkera-source"), command: "npx", args: ["-y", "@zalkera/cli", "mcp"],
    });
    strictEqual(result.action, "updated");
});

test("🔴 **남의 stdio 항목을 안 덮는다** — 실측 변이 셋(그 env 에 토큰이 있다)", async () => {
    // 종전 판정은 `args` 에 맨 낱말 `zalkera` 가 한 번 있으면 우리 것으로 봤다.
    const theirs = [
        {type: "stdio", command: "node", args: ["srv.js", "zalkera"], env: {GITHUB_TOKEN: "비밀"}},
        {command: "uvx", args: ["mcp-server", "zalkera"], env: {API_KEY: "비밀"}},
        {command: "docker", args: ["run", "-i", "zalkera"], env: {TOK: "비밀"}},
        // ⚠ **우리 하위 명령까지 겹쳐도** 안 덮는다 — 맨 낱말 `zalkera` 로는 우리 것이 안 된다.
        {command: "docker", args: ["run", "-i", "zalkera", "mcp"], env: {TOK: "비밀"}},
        {type: "stdio", command: "node", args: ["srv.js", "zalkera", "mcp"], env: {T: "비밀"}},
    ];
    for (const entry of theirs) {
        const dir = await tempDir("zalkera-theirs-");
        await writeFile(join(dir, ".mcp.json"), JSON.stringify({mcpServers: {"zalkera-source": entry}}));
        await rejects(
            () => registerLocalMcpServer(dir, {
                serverName: serverName("zalkera-source"), command: "npx", args: ["-y", "@zalkera/cli@1.0.0", "mcp"],
            }),
            (e: unknown) => e instanceof DevtoolsError,
            `덮었다: ${JSON.stringify(entry)}`,
        );
        const after = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")) as {
            mcpServers: Record<string, {env?: Record<string, string>}>;
        };
        ok(after.mcpServers["zalkera-source"]?.env, `남의 env 가 사라졌다: ${JSON.stringify(entry)}`);
    }
});

test("🔴 **우리가 적은 것은 다시 적을 수 있다** — 판이 붙어도, 전역 설치 모양이어도", async () => {
    // 좁히다 못 알아보면 「잘커라에 문의해 주세요」로 **영구 잠김**이 된다(사람이 손으로 지워야 한다).
    const ours = [
        {type: "stdio", command: "npx", args: ["-y", "@zalkera/cli@0.20.2", "mcp", "--folder", "/x"]},
        {type: "stdio", command: "npx", args: ["-y", "zalkera-cli", "mcp"]},
        {command: "zalkera", args: ["mcp"]},
        // 🔴 **확장 동봉본.** 이 모양을 못 알아보면 우리가 적은 항목을 남의 것으로 보고 거절해
        //    **영구 잠김**이 된다 — 사람이 손으로 지우기 전까지 다시 등록을 못 한다(실측).
        {type: "stdio", command: "/usr/bin/node", args: ["/ext/dist/zalkera-cli.js", "mcp", "--folder", "/x"]},
    ];
    for (const entry of ours) {
        const dir = await tempDir("zalkera-ours-");
        await writeFile(join(dir, ".mcp.json"), JSON.stringify({mcpServers: {"zalkera-source": entry}}));
        const result = await registerLocalMcpServer(dir, {
            serverName: serverName("zalkera-source"), command: "npx", args: ["-y", "@zalkera/cli@1.0.0", "mcp"],
        });
        ok(result.action === "updated" || result.action === "unchanged", `못 알아봤다: ${JSON.stringify(entry)}`);
    }
});
