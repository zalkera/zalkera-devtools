import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DevtoolsError } from "./errors.ts";
import type { McpServerName } from "./serverUrl.ts";
import { assertOwnFileWritable } from "./safeWrite.ts";

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

export interface RegisterMcpResult {
    path: string;
    action: "created" | "updated" | "unchanged";
}

/** 우리가 적은 항목의 형상인가. 아니면 남의 것이다 — 이름이 같아도 덮지 않는다. */
function isOurEntry(value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "http";
}

/** 프로젝트 스코프 `.mcp.json` 에 우리 서버를 적는다(팀이 공유하는 자리 — 시크릿은 담기지 않는다). */
export async function registerMcpServer(
    projectDir: string,
    registration: McpRegistration,
): Promise<RegisterMcpResult> {
    const path = join(projectDir, ".mcp.json");
    const entry = {
        type: "http",
        url: registration.url,
        oauth: {
            clientId: registration.clientId,
            authServerMetadataUrl: registration.authServerMetadataUrl,
        },
    };

    if (!existsSync(path)) {
        await assertOwnFileWritable(path, ".mcp.json");
        await writeFile(path, `${JSON.stringify({ mcpServers: { [registration.serverName]: entry } }, null, 2)}\n`);
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

    const servers = { ...(parsed.mcpServers ?? {}) };
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
    await assertOwnFileWritable(path, ".mcp.json");
    await writeFile(path, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`);
    return { path, action: "updated" };
}
