import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureAgentDocs } from "./agents.ts";
import { DevtoolsError } from "./errors.ts";
import { registerMcpServer, type McpRegistration } from "./mcp.ts";

const registration: McpRegistration = {
    serverName: "zalkera-site",
    url: "https://api.zalkera.com/mcp/source/acme",
    clientId: "zalkera-mcp",
    authServerMetadataUrl: "https://sso.zalkera.com/realms/zalkera/.well-known/openid-configuration",
};

test("파일이 없으면 만든다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-mcp-"));
    strictEqual((await registerMcpServer(dir, registration)).action, "created");
    const parsed = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    strictEqual(parsed.mcpServers["zalkera-site"].url, registration.url);
    strictEqual(parsed.mcpServers["zalkera-site"].oauth.clientId, "zalkera-mcp");
});

test("남의 서버 설정과 최상위 키를 보존한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-mcp-"));
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
    const dir = await mkdtemp(join(tmpdir(), "zalkera-mcp-"));
    await registerMcpServer(dir, registration);
    strictEqual((await registerMcpServer(dir, registration)).action, "unchanged");
});

test("깨진 JSON 은 덮지 않고 알린다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-mcp-"));
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
    const dir = await mkdtemp(join(tmpdir(), "zalkera-agents-"));
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
    const dir = await mkdtemp(join(tmpdir(), "zalkera-agents-"));
    await ensureAgentDocs(dir);
    const stub = await readFile(join(dir, "AGENTS.md"), "utf8");
    ok(stub.includes("llms.txt"), "정본을 가리킨다");
    ok(stub.length < 600, `사본이 아니라 포인터여야 한다(길이 ${stub.length})`);
});
