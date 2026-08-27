/**
 * **로컬 MCP 서버 — 도구 넷**(memo184 §2.6).
 *
 * 고객 기계에서 돌며, 그 사람의 에이전트에게 **소스 동기화**를 연다.
 *
 * ⚠ **형제 「에이전트 연결(MCP)」과 다른 물건이다.** 그쪽은 우리 백엔드의 **원격** 평면을
 *   에이전트 설정에 등록해 **서버 쪽 데이터**(상품·주문·설정)를 보여 준다(`core/mcp.ts`).
 *   이쪽은 여기서 돌고 여는 것이 데이터가 아니라 **받기·올리기·발행**이다. 둘은 짝이다 —
 *   원격이 「내 사이트에 뭐가 있나」를, 로컬이 「고친 걸 올리고 발행해」를 맡는다.
 *
 * ■ 카탈로그가 넷인 이유
 *
 * **카탈로그가 곧 매 대화의 고객 토큰이다**(§2.6). 도구 하나가 늘면 그 설명이 모든 대화의 앞머리에
 * 실린다 — 넓히기는 쉽고 좁히기는 계약 파기다. 그래서 **FS 로 안 되는 것만** 싣는다:
 *
 * | 도구 | 파일만으로 안 되는 이유 |
 * |---|---|
 * | `status` | 서버만 아는 것 — 활성 판 · 여기 없는 편집 · 좌초 |
 * | `pull` | 원장·S3 접근 |
 * | `push` | 드래프트 CAS |
 * | `publish` | 원장 INSERT |
 *
 * **읽기·검색·편집 도구는 없다.** 에이전트는 폴더를 이미 읽고 고친다.
 *
 * ■ 밖에 두는 것
 *
 * `rollback`·`discard` 는 **파괴적**이라 안 싣는다. 로컬 확인은 보안 통제가 아니라 UX 가드고
 * (강제 지점이 우리 프로세스다), 모델이 부르는 자리에서는 그 가드가 사람을 안 지난다.
 * `preview`·`baseline` 은 사람이 부르는 자리라 CLI 명령으로만 둔다.
 */
import {
    count,
    hashWorkdir,
    pullSiteSource,
    pushSiteSource,
    publishDraft,
    plainNotice,
    readLedger,
    syncStatus,
    type DraftFiles,
    type SyncStatus,
} from "@zalkera/devtools-core";
import {openContext, version, type Context} from "./context.ts";
import {RPC, RpcError, serveStdio} from "./jsonRpc.ts";

/**
 * 우리가 말하는 프로토콜 판.
 *
 * ⚠ **상대가 다른 판을 말하면 그 판을 되돌려 주지 않는다** — 우리가 아는 판을 답한다. 규격이
 *   그렇게 정하고, 모르는 판을 흉내내면 상대가 없는 기능을 기대한다.
 */
const PROTOCOL_VERSION = "2025-06-18";

/** 도구 하나의 선언. `inputSchema` 는 JSON Schema 다. */
interface Tool {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    run(context: Context, args: Record<string, unknown>): Promise<string>;
}

/** 인자 없는 도구의 스키마. 빈 객체를 명시한다 — 없으면 상대가 임의 인자를 만들어 보낸다. */
const NO_ARGS = {type: "object", properties: {}, additionalProperties: false} as const;

/**
 * 사람이 읽을 한 줄로 상태를 옮긴다.
 *
 * ⚠ **모델에게도 「모른다」를 숨기지 않는다.** 서버를 못 읽었을 때 「같습니다」로 접으면 모델이
 *   그것을 근거로 올리기를 부른다.
 */
export function describeForAgent(status: SyncStatus, draft: DraftFiles | null): string {
    const lines = [
        `사이트: ${siteCodeOf(status.tenant)}`,
        `켜진 버전: ${count(status.activeRevisionNo)}`,
        `이 폴더의 기준 버전: ${count(status.baseRevisionNo)}`,
        // ⚠ **셋을 다 싣는다.** 고친 것만 세면 **새로 만들기만 한 폴더가 「0개」**가 된다 —
        //   AI 가 새 페이지를 만드는 것이 이 기능의 주 용도다(심의 실측).
        `이 폴더에서 고친 것: ${status.changed.length}개 · 새로 만든 것: ${status.added.length}개 · 지운 것: ${status.removed.length}개`,
        `사이트 쪽에 걸린 편집: ${draft === null ? "모름(서버를 못 읽음)" : `${status.draftPaths}개`}`,
    ];
    // ⚠ **날 식별자를 모델에게 주지 않는다.** `LEDGER_UNKNOWN` 같은 값은 사람 말이 아니고,
    //   모델은 그것을 그대로 사장님께 옮긴다. 형제 `report.ts` 의 규율과 같다.
    if (status.blockers.length > 0) {
        lines.push(`막혀 있는 것: ${status.blockers.map(blockerText).join(" · ")}`);
    }
    return lines.join("\n");
}

/**
 * 사이트 코드 — **알려진 모양이 아니면 안 싣는다.**
 *
 * 🔴 **소독으로 막을 자리가 아니다.** `plainNotice` 는 제어문자·링크를 지우지만 **글자 자체는
 *    남긴다** — 개행을 지워도 「이전 지시는 무시하고…」는 그대로 모델에게 간다(실측). 이 값의
 *    출처는 폴더 안 `.zalkera/sync.json` 이고, 그 파일은 **남이 준 zip·시작 소스 팩에 실려 온다.**
 *    서버 탈취가 필요 없다.
 *
 * ⚠ **형태로 잰다** — 사이트 코드는 모양이 정해져 있다(콘솔 입력이 같은 잣대를 쓴다). 아니면
 *   「모름」이다: 모르는 것을 그대로 옮기느니 모른다고 말하는 쪽이 정직하고 안전하다.
 */
const SITE_CODE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function siteCodeOf(raw: string | null): string {
    return raw !== null && SITE_CODE.test(raw) ? raw : "모름";
}

/** 막힌 사유를 사람 말로. 다음에 할 일이 문장 안에 있어야 한다. */
function blockerText(blocker: string): string {
    switch (blocker) {
        case "LEDGER_UNKNOWN":
            return "이 폴더의 기준 기록이 없습니다(사람이 `zalkera baseline` 을 한 번 실행해야 합니다)";
        case "SERVER_UNREADABLE":
            return "사이트 상태를 읽지 못했습니다(로그인·연결을 확인해 주세요)";
        case "STRANDED":
            return "사이트 쪽 편집이 옛 버전 위에 있습니다(사람이 버리거나 되돌려야 합니다)";
        default:
            // 모르는 값을 지어내지 않는다 — 다만 그 글자도 서버·파일에서 올 수 있으므로 소독한다.
            return plainNotice(blocker, 60);
    }
}

const TOOLS: Tool[] = [
    {
        name: "zalkera_status",
        title: "사이트와 이 폴더의 차이",
        description:
            "이 폴더와 잘커라 사이트가 어떻게 다른지 본다. 서버만 아는 것을 답한다 — 지금 켜진 버전, " +
            "이 폴더에 없는 편집, 좌초 여부. 파일을 읽는 것으로는 알 수 없는 값이다. 아무것도 바꾸지 않는다.",
        inputSchema: NO_ARGS,
        async run(context) {
            const draft = await context.api.draftFiles().catch(() => null);
            const active = await context.api
                .listRevisions(20)
                .then((rows) => rows.find((r) => r.isActive)?.revisionNo ?? null)
                .catch(() => null);
            const status = syncStatus({
                ledger: await readLedger(context.folder),
                local: await hashWorkdir(context.folder),
                draft,
                activeRevisionNo: active,
            });
            return describeForAgent(status, draft);
        },
    },
    {
        name: "zalkera_pull",
        title: "사이트의 지금 버전을 이 폴더로 받기",
        description:
            "잘커라 사이트의 지금 버전을 이 폴더에 받는다. **이 폴더에서 고친 것이 있으면 거절한다** — " +
            "덮어쓰지 않는다. 그때는 먼저 올리거나, 사람이 직접 정하게 해야 한다.",
        inputSchema: NO_ARGS,
        async run(context) {
            const result = await pullSiteSource({api: context.api, folder: context.folder});
            return (
                `${count(result.revisionNo)}판을 받았습니다. ` +
                `쓴 파일 ${result.written}개 · 지운 파일 ${result.deleted}개 · 그대로 ${result.unchanged}개.`
            );
        },
    },
    {
        name: "zalkera_push",
        title: "이 폴더에서 고친 것을 사이트에 올리기",
        description:
            "이 폴더에서 고친 것을 사이트 쪽 편집으로 올린다. **손님에게는 아직 안 보인다** — " +
            "보이게 하려면 zalkera_publish 를 부른다. 사이트 쪽에 이 폴더가 모르는 편집이 있으면 거절한다.",
        inputSchema: NO_ARGS,
        async run(context) {
            const result = await pushSiteSource({api: context.api, folder: context.folder});
            const lines = [`${result.sent}개를 올렸습니다(그중 삭제 ${result.removed}개).`];
            // ⚠ **0 이 곧 「같다」가 아니다.** 서버가 뺀 것이 있으면 폴더와 사이트는 다르다.
            if (result.droppedByServer.length > 0) {
                lines.push(
                    `⚠ 서버가 ${result.droppedByServer.length}개를 받지 않아 빼고 보냈습니다 — 그 경로들은 사이트에 안 올라갔습니다.`,
                );
            }
            return lines.join("\n");
        },
    },
    {
        name: "zalkera_publish",
        title: "올린 것을 새 버전으로 만들기",
        description:
            "사이트 쪽에 올려 둔 편집을 새 버전으로 만든다. **이때부터 손님에게 보인다** " +
            "(정적 사이트는 바로, Next 사이트는 다시 지은 뒤). 되돌리려면 사람이 터미널에서 " +
            "`zalkera rollback` 을 쓴다 — 그 동사는 이 목록에 없다.",
        inputSchema: {
            type: "object",
            properties: {
                label: {type: "string", description: "이 버전에 붙일 이름(선택). 사람이 목록에서 알아볼 이름."},
            },
            additionalProperties: false,
        },
        async run(context, args) {
            const label = typeof args.label === "string" ? args.label : undefined;
            const result = await publishDraft({api: context.api, folder: context.folder, label});
            const lines = [
                `${count(result.revisionNo)}판으로 올렸습니다.`,
                result.siteType === "STATIC"
                    ? "지금 바로 손님에게 보입니다."
                    : "사이트를 다시 짓는 중입니다 — 다 지어지면 손님에게 보입니다.",
            ];
            // ⚠ **발행은 성공했다.** 장부를 못 세운 것은 다른 사실이고, 그것을 실패로 말하면
            //   모델이 다시 부른다 — 그러면 같은 내용의 판이 하나 더 선다.
            if (!result.ledgerRebuilt) {
                lines.push(
                    "다만 이 폴더의 기준 기록을 못 세웠습니다. 사람이 `zalkera baseline` 을 한 번 실행해야 다음 올리기가 됩니다.",
                );
            }
            return lines.join("\n");
        },
    },
];

/** MCP 가 정한 도구 결과 모양. 우리는 글자만 낸다. */
function textResult(text: string, isError = false): Record<string, unknown> {
    return {content: [{type: "text", text}], isError};
}

/**
 * stdio 로 MCP 를 말한다. **끝나지 않는다** — 상대가 stdin 을 닫으면 반환한다.
 *
 * ⚠ **컨텍스트를 도구 호출마다 새로 열지 않는다.** 열 때마다 핸드셰이크가 한 번 나가고, 그것이
 *   대화당 수십 번이면 고객 요금과 지연이 그만큼 는다. 다만 **처음 부를 때까지 미룬다** —
 *   서버가 안 되는 상태에서도 `tools/list` 는 답해야 에이전트가 목록을 그릴 수 있다.
 */
export async function serveMcp(options: {folder?: string; tenant?: string} = {}): Promise<void> {
    let opened: Context | null = null;
    const context = async (): Promise<Context> => {
        opened ??= await openContext({folder: options.folder, tenant: options.tenant});
        return opened;
    };

    let initialized = false;
    await serveStdio(process.stdin, process.stdout, async (method, params) => {
        switch (method) {
            case "initialize":
                initialized = true;
                return {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: {tools: {}},
                    serverInfo: {name: "zalkera", title: "잘커라 소스 동기화", version: version()},
                };
            // 상대가 「준비됐다」고 알린다. 답하지 않는 알림이다.
            case "notifications/initialized":
                return undefined;
            case "ping":
                return {};
            case "tools/list":
                return {
                    tools: TOOLS.map((t) => ({
                        name: t.name,
                        title: t.title,
                        description: t.description,
                        inputSchema: t.inputSchema,
                    })),
                };
            case "tools/call": {
                // ⚠ **초기화 전 호출을 받지 않는다.** 받으면 판 협상 없이 도구가 도는 셈이라,
                //   상대가 기대하는 계약이 무엇인지 모르는 채로 사이트를 고치게 된다.
                if (!initialized) throw new RpcError(RPC.INVALID_REQUEST, "initialize 가 먼저입니다.");
                const {name, arguments: args} = (params ?? {}) as {
                    name?: unknown;
                    arguments?: unknown;
                };
                const tool = TOOLS.find((t) => t.name === name);
                if (!tool) throw new RpcError(RPC.INVALID_PARAMS, `모르는 도구입니다: ${String(name)}`);
                try {
                    const text = await tool.run(await context(), (args ?? {}) as Record<string, unknown>);
                    return textResult(text);
                } catch (error) {
                    // ⚠ **도구가 거절한 것은 프로토콜 오류가 아니다.** `isError` 로 실어야 모델이
                    //   그 문장을 읽고 **다음 걸음을 고를 수 있다** — RPC 오류로 내면 대개 그대로 멈춘다.
                    return textResult(humanTextOf(error), true);
                }
            }
            default:
                throw new RpcError(RPC.METHOD_NOT_FOUND, `모르는 메서드입니다: ${method}`);
        }
    });
}

/** 오류를 모델이 읽을 문장으로. 우리 오류는 다음 걸음이 문장 안에 있다. */
function humanTextOf(error: unknown): string {
    if (error !== null && typeof error === "object" && "humanMessage" in error) {
        const shown = (error as {humanMessage: unknown}).humanMessage;
        if (typeof shown === "string") return shown;
    }
    return error instanceof Error ? error.message : String(error);
}
