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
