import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DevtoolsError } from "./errors.ts";
import type { McpServerName } from "./serverUrl.ts";
import { writeOwnFile } from "./safeWrite.ts";

/**
 * E2「MCP 등록 대행」(memo146 §5 E4 · T4-5).
 *
 * 에이전트 설정 파일에 잘커라 서버 한 줄을 적어 준다. **로직은 그것뿐이다** — 우리가 대신 로그인해 주거나
 * 토큰을 넣어 주지 않는다(첫 사용 때 에이전트가 브라우저로 직접 로그인한다).
 *
 * **병합 규율은 `.env.local` 과 같다**: 우리 항목 하나만 소유·갱신하고 나머지는 한 글자도 안 건드린다.
 * 파싱이 안 되는 파일은 **덮지 않고 사람에게 알린다** — 남의 설정을 우리가 판단해 버리지 않는다.
 */
export interface McpRegistration {
    /**
     * 서버 이름 = **설정 파일의 키**. 핸드셰이크가 주지만 생 `string` 은 받지 않는다 —
     * `mcpServerName()` 을 지난 값만 여기 들어온다(형태 검사 우회를 타입이 막는다).
     */
    serverName: McpServerName;
    /** `{tenantCode}` 가 치환된 최종 주소. */
    url: string;
    clientId: string;
    authServerMetadataUrl: string;
}

/**
 * **로컬(stdio) 서버 등록.** 원격과 달리 주소·OAuth 가 없다 — 에이전트가 이 명령을 **직접 띄운다.**
 *
 * ⚠ **토큰을 여기 담지 않는다.** `.mcp.json` 은 팀이 공유하는 파일이고 레포에 들어간다. 로그인은
 *   그 명령이 자기 보관소(`~/.config/zalkera/auth.json`)에서 읽는다 — 이 파일은 「무엇을 띄울지」만 안다.
 */
export interface LocalMcpRegistration {
    serverName: McpServerName;
    /** 실행할 명령(예: `npx`). */
    command: string;
    /** 그 인자. **우리 패키지 이름이 여기 있어야** 나중에 이 항목이 우리 것으로 판별된다. */
    args: readonly string[];
}

export interface RegisterMcpResult {
    path: string;
    action: "created" | "updated" | "unchanged";
}

/**
 * 우리가 적은 항목인가. 아니면 남의 것이다 — 이름이 같아도 덮지 않는다.
 *
 * ⚠ `type === "http"` 는 **우리 표식이 아니라 MCP 규격의 전송 방식**이다. 그것으로 판정하면
 *   Linear·Sentry 처럼 http 로 붙는 남의 항목을 우리 것으로 오인해 덮는다 — `headers.Authorization`
 *   에 토큰을 단 항목이 통째로 사라진다(심의 실측). 우리가 적는 형상 그대로를 표식으로 쓴다.
 */
function isOurEntry(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const e = value as { type?: unknown; oauth?: unknown; command?: unknown; args?: unknown };
    // ⑴ 원격(HTTP) 항목 — 우리는 항상 `oauth.{clientId,authServerMetadataUrl}` 를 같이 적는다.
    //    그 짝이 없으면 남의 것이다.
    if (e.type === "http") {
        const o = e.oauth;
        if (typeof o !== "object" || o === null) return false;
        const oauth = o as { clientId?: unknown; authServerMetadataUrl?: unknown };
        return typeof oauth.clientId === "string" && typeof oauth.authServerMetadataUrl === "string";
    }
    // ⑵ 로컬(stdio) 항목 — 인자에 우리 패키지 이름이 있어야 우리 것이다.
    //
    // ⚠ **`command` 로 판정하지 않는다.** 그 값은 `npx`·`node` 처럼 흔해서, 그것만 보면 고객이
    //   쓰던 남의 stdio 서버를 우리 것으로 오인해 **덮는다** — 그 항목의 `env` 에 든 토큰째로.
    //   유출이 아니라 **파괴**다(형제 갈래가 같은 이유로 그렇게 적혀 있다).
    if (e.type === "stdio" || e.type === undefined) {
        const args = Array.isArray(e.args) ? e.args : [];
        return args.some((a) => typeof a === "string" && LOCAL_TOOL_ARGS.has(a));
    }
    return false;
}

/**
 * 로컬 항목의 **소유 표식** — 인자에 이 중 하나가 있으면 우리가 적은 것이다.
 *
 * ⚠ **옛 이름도 남긴다.** 이 도구는 발행 전에 이미 이름이 한 번 갈렸다(npm 유사도 거절). 목록이
 *   「지금 이름 하나」로 좁아지면 개명한 날 **우리가 적은 항목을 남의 것으로 보고 거절한다** —
 *   그러면 사람이 손으로 지우기 전까지 다시 등록을 못 한다.
 */
const LOCAL_TOOL_ARGS = new Set(["@zalkera/cli", "zalkera", "zalkera-cli", "@zalkera/devtools"]);

/** 프로젝트 스코프 `.mcp.json` 에 우리 서버를 적는다(팀이 공유하는 자리 — 시크릿은 담기지 않는다). */
export async function registerMcpServer(
    projectDir: string,
    registration: McpRegistration,
): Promise<RegisterMcpResult> {
    return writeEntry(projectDir, registration.serverName, {
        type: "http",
        url: registration.url,
        oauth: {
            clientId: registration.clientId,
            authServerMetadataUrl: registration.authServerMetadataUrl,
        },
    });
}

/**
 * 로컬(stdio) 서버를 같은 파일에 적는다.
 *
 * ⚠ **병합 규율은 원격과 한 벌이다** — 남의 항목을 안 덮고, 형태가 틀리면 멈추고, 최상위의 다른
 *   키를 살린다. 두 벌이 되면 한쪽만 조여진다.
 */
export async function registerLocalMcpServer(
    projectDir: string,
    registration: LocalMcpRegistration,
): Promise<RegisterMcpResult> {
    return writeEntry(projectDir, registration.serverName, {
        type: "stdio",
        command: registration.command,
        args: [...registration.args],
    });
}

async function writeEntry(
    projectDir: string,
    serverName: McpServerName,
    entry: Record<string, unknown>,
): Promise<RegisterMcpResult> {
    const path = join(projectDir, ".mcp.json");
    const registration = {serverName};

    if (!existsSync(path)) {
        await writeOwnFile(path, `${JSON.stringify({ mcpServers: { [registration.serverName]: entry } }, null, 2)}\n`);
        return { path, action: "created" };
    }

    const raw = await readFile(path, "utf8");
    let parsed: { mcpServers?: Record<string, unknown> };
    try {
        parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    } catch (cause) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            ".mcp.json 을 읽지 못했습니다(형식 오류).",
            "파일을 고친 뒤 다시 시도해 주세요. 덮어쓰지 않았습니다.",
            cause,
        );
    }

    // ⚠ 파싱은 됐는데 **형태가 틀린** 경우도 덮지 않는다. 문자열을 스프레드하면 글자로 흩어져
    //   `{"0":"a","1":"b"}` 가 되고, 우리는 그것을 "갱신"이라 보고한다(심의 실측).
    const rawServers: unknown = parsed.mcpServers;
    if (rawServers !== undefined && (typeof rawServers !== "object" || rawServers === null || Array.isArray(rawServers))) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            ".mcp.json 의 `mcpServers` 가 객체가 아닙니다 — 덮어쓰지 않았습니다.",
            "파일을 고친 뒤 다시 시도해 주세요.",
        );
    }
    const servers: Record<string, unknown> = { ...((rawServers as Record<string, unknown> | undefined) ?? {}) };
    const existing = servers[registration.serverName];
    // ⚠ **남의 항목을 덮지 않는다.** 이름 형태 검사는 `github` 같은 **흔한 이름**을 막지 못한다 —
    //   그 자리에 고객이 쓰던 stdio 서버가 있으면 토큰이 든 `env` 째로 사라지고, 우리는 "갱신"이라
    //   보고한다. 유출이 아니라 **파괴**다. 우리 형상(`type: "http"`)이 아닌 것은 손대지 않는다.
    if (existing !== undefined && !isOurEntry(existing)) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            `.mcp.json 에 이미 \`${registration.serverName}\` 항목이 있습니다 — 덮어쓰지 않았습니다.`,
            "그 항목이 다른 도구의 것이면 이름이 겹친 것입니다. 잘커라에 문의해 주세요.",
        );
    }
    servers[registration.serverName] = entry;
    if (JSON.stringify(existing) === JSON.stringify(entry)) return { path, action: "unchanged" };

    // 최상위의 다른 키(있다면)도 그대로 살린다 — 이 파일은 우리 것이 아니다.
    await writeOwnFile(path, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`);
    return { path, action: "updated" };
}
