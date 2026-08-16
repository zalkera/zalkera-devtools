/**
 * **서버가 준 값을 쓸지 정하는 자리.** 순수 함수만 있고 `vscode` 를 모른다.
 *
 * ■ 왜 한 모듈인가
 *   핸드셰이크(`/api/devtools/handshake`)는 확장의 동작을 지시한다 — 어디로 로그인하러 갈지
 *   (`issuer`), 고객의 에이전트를 어디로 보낼지(`authServerMetadataUrl`·`sourceUrlTemplate`),
 *   고객 `.mcp.json` 의 어느 키를 쓸지(`serverName`). 그런데 검증은 **매뉴얼 주소 하나**에만
 *   걸려 있었다. 판정이 흩어지면 새로 늘어나는 필드는 매번 맨몸으로 들어온다.
 *
 * ■ 무엇을 막나
 *   `new URL()` 은 `javascript:`·`file:`·`vscode:` 를 순순히 판다.
 *   재현: `node -e 'console.log(new URL("vscode://x/protocol/openid-connect/auth").protocol)'` → `vscode:`
 *   그 값이 `openExternal` 로 가면 URI 핸들러가 열리고, `.mcp.json` 으로 가면 고객의 에이전트가
 *   그쪽으로 로그인하러 간다.
 *
 * ■ 왜 `apiBase` 만 규칙이 다른가
 *   나머지는 **그 `apiBase` 가 준 값**이다. 뿌리가 평문이면 중간에 앉은 쪽이 나머지를 전부 바꿔
 *   쓸 수 있으므로 뿌리에는 https 를 요구한다. 다만 로컬 개발은 `http://127.0.0.1` 이라
 *   루프백만 예외로 둔다 — 그 경로엔 중간이 없다.
 */

/** `openExternal`·설정 파일에 넘겨도 되는 주소인가. 아니면 `null`. */
export function httpUrl(value: unknown): URL | null {
    if (typeof value !== "string" || value.trim() === "") return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
}

/** 루프백인가 — 중간에 앉을 자리가 없는 주소. */
export function isLoopback(url: URL): boolean {
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
}

/**
 * 서버 주소로 쓸 수 있는가. **https 이거나 루프백**이어야 한다.
 *
 * 여기서 걸러 두면 `issuer`·MCP 좌표가 평문 응답에서 주입될 여지가 없다.
 */
export function apiBaseUrl(value: unknown): URL | null {
    const url = httpUrl(value);
    if (!url) return null;
    return url.protocol === "https:" || isLoopback(url) ? url : null;
}

/**
 * `.mcp.json` 의 **키**로 쓸 수 있는 이름인가.
 *
 * 이 값은 고객 파일의 **키**가 된다. 여기서 막는 것은 **형태**다 — 대소문자·점·슬래시·공백,
 * 그리고 `__proto__`(항목을 안 적으면서 성공을 보고하는 형태).
 *
 * ⚠ **이 검사는 "흔한 이름"을 막지 못한다.** `github` 는 형태가 옳아서 통과한다. 이름이 겹쳐
 * 남의 항목을 덮는 것은 `mcp.ts` 가 **형상으로** 막는다(우리 것이 아니면 손대지 않는다).
 */
export function mcpServerName(value: unknown): McpServerName | null {
    return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? (value as McpServerName) : null;
}

/**
 * 검사를 지난 서버 이름. **[mcpServerName] 만이 만든다** — 생 `string` 은 `registerMcpServer` 에
 * 컴파일이 안 된다.
 *
 * ⚠ **봉인은 경계(`fetchHandshake`)가 진다.** 타입과 텍스트 검사기는 소비처 규율이고, 둘 다 뚫린다 —
 * 브랜드는 `const m = config.mcp;` 한 줄 뒤 캐스트로, 검사기는 그 캐스트를 잡지만 구조분해는 못 잡는다
 * (심의 실측: 둘을 조합하면 세 게이트가 전부 초록). 상보 관계라 둘 다 두되, **경계를 지나지 않은
 * 값은 애초에 소비처에 도달하지 않는다**는 것이 실제 방어다.
 */
export type McpServerName = string & { readonly __mcpServerName: unique symbol };
