/**
 * **stdio JSON-RPC 2.0 전송층**(MCP 로컬 서버가 딛는 자리 · memo184 §2.6).
 *
 * ■ 왜 SDK 를 안 쓰나
 *
 * `@modelcontextprotocol/sdk` 는 의존 17개(express·hono·jose·cors·eventsource…)를 끌고 온다 —
 * HTTP 서버 스택 전부인데, 여기서 쓰는 것은 **stdio 하나에 도구 넷**이다. 이 패키지는 런타임
 * 의존이 0이고 고객 기계에서 **refresh 토큰을 들고 도는 바이너리**다. 그 자리에 의존 17개를
 * 얹는 대가가 이 파일보다 크다.
 *
 * ⚠ **대가는 있다 — 프로토콜 정확성이 우리 책임이다.** 그래서 여기 담는 것은 전송뿐이고,
 *   MCP 의미론은 `mcpServer.ts` 한 자리에 둔다.
 *
 * ■ 프레이밍 — **줄바꿈으로 가른다**
 *
 * MCP stdio 는 메시지 하나를 한 줄 JSON 으로 보낸다(`Content-Length` 헤더가 아니다 — 그쪽은 LSP 다).
 *
 * ⚠ **줄 안에 생 줄바꿈이 없어야 한다.** `JSON.stringify` 는 문자열 안의 개행을 `\\n` 으로
 *   이스케이프하므로 그 성질이 지켜진다. 우리가 직접 문자열을 이어 붙이지 않는 이유다.
 *
 * ⚠ **stdout 에는 프로토콜만 나간다.** 진행 문면·경고를 stdout 에 찍으면 그것이 메시지 사이에
 *   섞여 **상대가 파싱에 실패한다** — 그리고 그 실패는 「도구가 안 뜬다」로만 보인다.
 *   사람에게 할 말은 전부 stderr 로 간다.
 */
import type {Readable, Writable} from "node:stream";

/** JSON-RPC 요청 하나. `id` 가 없으면 알림(notification)이라 답하지 않는다. */
export interface RpcRequest {
    jsonrpc: "2.0";
    id?: string | number | null;
    method: string;
    params?: unknown;
}

/** 규격이 정한 오류 코드. 우리가 쓰는 것만 둔다. */
export const RPC = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
} as const;

/** 한 줄이 감당할 수 있는 최대 길이. 넘으면 그 줄을 버린다 — 상대가 우리 메모리를 못 밀어붙인다. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class RpcError extends Error {
    readonly code: number;
    constructor(code: number, message: string) {
        super(message);
        this.name = "RpcError";
        this.code = code;
    }
}

/**
 * 한 줄씩 읽어 핸들러에 넘기고, 답을 한 줄씩 쓴다.
 *
 * @param handle 메서드 하나를 처리한다. 던지면 오류 응답이 된다(`RpcError` 면 그 코드로).
 *               알림(`id` 없음)에는 **아무것도 안 쓴다** — 규격이 금지한다.
 */
export async function serveStdio(
    input: Readable,
    output: Writable,
    handle: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
    const write = (message: unknown): void => {
        output.write(`${JSON.stringify(message)}\n`);
    };

    let buffered = "";
    // 상한을 넘긴 줄을 건너뛰는 중인가 — 다음 `\n` 에서 풀린다.
    let skipping = false;
    input.setEncoding("utf8");
    for await (const chunk of input) {
        buffered += chunk as string;
        // ⚠ **상한을 건다.** 줄바꿈 없는 스트림을 무한히 모으면 우리 메모리가 상대 손에 있다.
        //
        // 🔴 **버퍼를 통째로 비우지 않는다.** 종전에는 그랬는데, 그러면 같은 청크에 이미 들어와
        //    있던 **완결된 정상 요청들**이 응답도 오류도 없이 사라진다(실측). JSON-RPC 에서
        //    「답이 영영 안 오는 요청」은 상대를 매달고, 그 실패는 「도구가 안 뜬다」로만 보인다.
        //    다음 줄바꿈까지만 건너뛰어 **줄 경계에서 정확히 재동기화**한다.
        if (skipping) {
            const end = buffered.indexOf("\n");
            if (end === -1) {
                buffered = "";
                continue;
            }
            buffered = buffered.slice(end + 1);
            skipping = false;
        }
        if (buffered.length > MAX_LINE_BYTES && !buffered.includes("\n")) {
            buffered = "";
            skipping = true;
            write({jsonrpc: "2.0", id: null, error: {code: RPC.PARSE_ERROR, message: "메시지가 너무 깁니다."}});
            continue;
        }
        let cut = buffered.indexOf("\n");
        while (cut !== -1) {
            const line = buffered.slice(0, cut).trim();
            buffered = buffered.slice(cut + 1);
            cut = buffered.indexOf("\n");
            if (line === "") continue;

            let request: RpcRequest;
            try {
                request = JSON.parse(line) as RpcRequest;
            } catch {
                // ⚠ **`id` 를 모를 때는 `null` 이다.** 규격이 그렇게 정한다 — 못 읽은 요청의 id 를
                //   지어내면 상대가 엉뚱한 요청의 답으로 짝짓는다.
                write({jsonrpc: "2.0", id: null, error: {code: RPC.PARSE_ERROR, message: "JSON 이 아닙니다."}});
                continue;
            }

            // 🔴 **배열(배치)을 조용히 삼키지 않는다.** JSON-RPC 2.0 은 배열을 허용하고, 종전에는
            //    `method` 가 문자열이 아니라 **알림으로 접혀 아무것도 안 썼다** — 상대는 영원히
            //    기다린다(실측). 우리는 배치를 안 받으므로 **그렇다고 말한다.**
            if (Array.isArray(request)) {
                write({
                    jsonrpc: "2.0",
                    id: null,
                    error: {code: RPC.INVALID_REQUEST, message: "이 서버는 배치 요청을 받지 않습니다."},
                });
                continue;
            }

            const id = request?.id;
            // 🔴 **알림은 `id` 가 «없는» 것이지 `null` 인 것이 아니다.** 종전에는 `id: null` 을
            //    알림으로 접어 아무것도 안 썼는데, 규격상 그것은 **답해야 하는 요청**이다.
            //    (`id === 0` 도 같은 함정이라 `!id` 로 재지 않는다.)
            const isNotification = !("id" in (request ?? {})) || id === undefined;

            if (typeof request?.method !== "string") {
                if (!isNotification) {
                    write({jsonrpc: "2.0", id: id ?? null, error: {code: RPC.INVALID_REQUEST, message: "method 가 없습니다."}});
                }
                continue;
            }

            // ⚠ **한 번에 하나씩 처리한다 — 의도한 것이다.**
            //
            //   대가: 긴 도구 호출(큰 사이트 `pull` 은 수십 초) 동안 `ping` 과 취소 알림을 못 읽는다.
            //   실측으로 4초 도구 뒤의 ping 이 그만큼 밀렸다.
            //
            //   그래도 직렬로 두는 이유 둘:
            //   ⑴ `initialize` 는 다른 요청보다 **먼저 끝나야 한다**(규격). 띄워 두면 `tools/call` 이
            //      그것을 추월해 판 협상 없이 사이트를 고치는 창이 생긴다.
            //   ⑵ 우리 도구는 **같은 폴더의 장부 한 파일**을 쓴다. 두 `push` 가 겹치면 그 쓰기가
            //      경합하고, 서버 쪽 드래프트 CAS 도 함께 흔들린다.
            //
            //   푸는 값어치가 생기면 ⑴을 지키는 선별 병렬(초기화 뒤 · 읽기 도구만)로 간다.
            try {
                const result = await handle(request.method, request.params);
                // ⚠ **`result` 를 빠뜨리지 않는다.** 규격은 응답에 `result` 나 `error` **하나가
                //   반드시** 있어야 한다고 정한다 — `undefined` 를 그대로 두면 `JSON.stringify` 가
                //   그 칸을 지워 둘 다 없는 응답이 나간다.
                if (!isNotification) write({jsonrpc: "2.0", id: id ?? null, result: result ?? {}});
            } catch (error) {
                if (isNotification) continue;
                const code = error instanceof RpcError ? error.code : RPC.INTERNAL_ERROR;
                // ⚠ **여기서 스택을 안 싣는다.** 상대는 우리 파일 경로를 알 필요가 없고, 그 문자열은
                //   에이전트가 사람에게 그대로 옮긴다.
                const message = error instanceof Error ? error.message : String(error);
                write({jsonrpc: "2.0", id: id ?? null, error: {code, message}});
            }
        }
    }
}
