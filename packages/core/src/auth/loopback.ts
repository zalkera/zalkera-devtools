import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 루프백 리다이렉트 수신기(RFC 8252 §7.3). 브라우저가 인가 코드를 들고 **로컬 임시 포트**로 돌아온다.
 *
 * 커스텀 스킴(`vscode://`)을 쓰지 않는 이유: Cursor·Windsurf 같은 포크는 자기 스킴을 쓰므로 "같은 확장이
 * 모든 포크에서 먹는다"와 자기모순이고, 스킴마다 서버 화이트리스트가 늘어난다. 루프백은 등록 1건으로
 * 전 포크가 같이 돈다(Keycloak 은 루프백의 포트를 가리지 않는다 — backend `verify-devtools-client.sh` 실측).
 */
export interface LoopbackResult {
    code: string;
    state: string;
}

export interface LoopbackReceiver {
    /** 브라우저가 돌아올 주소. authorize 요청의 `redirect_uri` 로 그대로 쓴다. */
    redirectUri: string;
    /** 코드를 기다린다. 취소·타임아웃이면 reject. */
    waitForCode(): Promise<LoopbackResult>;
    /** 서버를 닫는다(멱등). 성공·실패 어느 쪽으로 끝나든 반드시 부른다. */
    close(): void;
}

export interface LoopbackOptions {
    /** 기다릴 시간(ms). 사람이 브라우저에서 로그인하는 시간이라 넉넉해야 한다. 기본 5분. */
    timeoutMs?: number;
    /** 로그인 완료 뒤 브라우저 탭에 보일 문구. */
    successHtml?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>로그인 완료</title></head>
<body style="font-family:system-ui,sans-serif;padding:3rem;text-align:center">
<h1 style="font-size:1.25rem">로그인이 끝났습니다</h1>
<p style="color:#555">이 창을 닫고 편집기로 돌아가세요.</p>
</body></html>`;

/**
 * 수신기를 띄운다. **127.0.0.1 에만 바인딩한다** — 0.0.0.0 에 열면 같은 네트워크의 다른 기계가 인가
 * 코드를 가로챌 수 있다. 포트는 OS 가 고르게 둔다(0) — 고정 포트는 충돌하고, 충돌 회피 로직은 그 자체가 결함원이다.
 */
export async function startLoopbackReceiver(options: LoopbackOptions = {}): Promise<LoopbackReceiver> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const successHtml = options.successHtml ?? DEFAULT_SUCCESS_HTML;

    let resolveCode: (result: LoopbackResult) => void;
    let rejectCode: (error: Error) => void;
    const codePromise = new Promise<LoopbackResult>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (error) {
            // 서버는 유효한 redirect_uri 로는 **오류도 리다이렉트로** 돌려준다(OAuth 규약). 여기서 받아 읽지
            // 않으면 "브라우저는 돌아왔는데 아무 일도 안 일어난다"가 된다.
            respond(response, 400, `<p>로그인이 취소되었거나 거절되었습니다: ${escapeHtml(error)}</p>`);
            rejectCode(new Error(url.searchParams.get("error_description") ?? error));
            return;
        }
        if (!code || !state) {
            respond(response, 400, "<p>잘못된 요청입니다.</p>");
            return;
        }
        respond(response, 200, successHtml);
        resolveCode({ code, state });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const port = (server.address() as AddressInfo).port;
    const timer = setTimeout(() => {
        rejectCode(new Error("로그인이 시간 안에 끝나지 않았습니다."));
    }, timeoutMs);
    timer.unref?.();

    const close = () => {
        clearTimeout(timer);
        server.close();
    };

    return {
        redirectUri: `http://127.0.0.1:${port}/callback`,
        waitForCode: () => codePromise,
        close,
    };
}

function respond(response: ServerResponse, status: number, html: string): void {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
