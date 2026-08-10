import type { SiteRevision } from "./api.ts";
import { DevtoolsError } from "./errors.ts";

/**
 * 올린 버전이 **서버에서 빌드될 때까지** 기다린다(memo76 §7 상태 게이트).
 *
 * ■ 왜 필요한가
 *   `STATIC` 은 올리는 즉시 `READY` 지만, `NEXT_SOURCE` 는 서버가 빌드를 마쳐야 `READY` 가 된다.
 *   그때까지 활성 전환은 409 `REVISION_NOT_READY` 로 거절된다. 종전에는 확장이 이 사실을 몰라
 *   **"올렸습니다"에서 이야기가 끊겼고**, 사용자는 왜 못 켜는지 알 수 없었다.
 *
 * ■ 무엇을 하지 않는가
 *   **켜지 않는다.** 여기서 하는 일은 "켤 수 있게 됐는가"를 지켜보는 것뿐이다. 올리기와 켜기를 한 번에
 *   이으면 확인 없이 손님에게 가고, 그건 오너가 금지한 자리다(무검수 자동배포 금지).
 *
 * ■ 왜 폴링인가
 *   서버가 완료를 알려 줄 통로가 없다(웹훅도, 스트림도). 있는 것은 버전 목록뿐이라 그것을 다시 본다.
 *   통로가 생기면 이 함수만 갈아 끼우면 된다 — 호출부는 결과만 본다.
 */
export type BuildOutcome =
    | { kind: "ready"; revision: SiteRevision }
    | { kind: "failed"; revision: SiteRevision; reason: string | null }
    /** 상한까지 안 끝났다. **실패가 아니다** — 계속 빌드 중일 수 있다. */
    | { kind: "timeout" }
    /** 사람이 그만뒀다. */
    | { kind: "cancelled" }
    /** 목록에서 그 번호가 사라졌다(다른 사람이 지웠다 등). 조용히 넘기면 영원히 기다린다. */
    | { kind: "gone" };

export interface WaitOptions {
    revisionNo: number;
    listRevisions: () => Promise<SiteRevision[]>;
    /** 진행 상황 한 줄씩. 기다림이 길어질 때 **아무 말이 없는 것**이 제일 나쁘다. */
    onProgress?: (message: string) => void;
    /** 사람이 취소했는가. 매 회차 시작에 본다. */
    isCancelled?: () => boolean;
    /** 기본 3초. 서버를 두드리는 간격이라 짧게 하지 않는다. */
    intervalMs?: number;
    /** 기본 10분. 넘으면 실패가 아니라 [BuildOutcome] `timeout` 이다. */
    timeoutMs?: number;
    /** 시험용 주입 — 실제로는 `setTimeout`. */
    sleep?: (ms: number) => Promise<void>;
    /** 시험용 주입 — 단조 시계. */
    now?: () => number;
}

const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function waitForBuild(options: WaitOptions): Promise<BuildOutcome> {
    const report = options.onProgress ?? (() => {});
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = now();

    // **첫 회차는 기다리지 않고 본다.** 이미 READY 인 것을 3초 재우는 것은 그냥 3초 손해다.
    for (let attempt = 0; ; attempt += 1) {
        if (options.isCancelled?.()) return { kind: "cancelled" };
        if (attempt > 0) {
            if (now() - startedAt >= timeout) return { kind: "timeout" };
            await sleep(interval);
            if (options.isCancelled?.()) return { kind: "cancelled" };
        }

        let revisions: SiteRevision[];
        try {
            revisions = await options.listRevisions();
        } catch (error) {
            // 한 번의 실패로 끝내지 않는다 — 노트북 뚜껑을 닫았다 연 것일 수도 있다.
            // 다만 **말은 한다**. 조용히 재시도하면 사용자는 멈춘 줄 안다.
            if (now() - startedAt >= timeout) return { kind: "timeout" };
            report(`상태를 확인하지 못했습니다. 다시 시도합니다 — ${describe(error)}`);
            continue;
        }

        const mine = revisions.find((r) => r.revisionNo === options.revisionNo);
        if (!mine) return { kind: "gone" };
        if (mine.status === "READY") return { kind: "ready", revision: mine };
        if (mine.status === "FAILED") return { kind: "failed", revision: mine, reason: mine.failReason ?? null };

        // BUILDING. 경과를 알려 준다 — 몇 분짜리 기다림에서 숫자가 움직이는 것이 곧 "살아 있다"는 신호다.
        const elapsed = Math.round((now() - startedAt) / 1000);
        if (attempt > 0) report(`서버가 빌드하는 중… (${elapsed}초)`);
    }
}

function describe(error: unknown): string {
    if (error instanceof DevtoolsError) return error.humanMessage;
    return error instanceof Error ? error.message : String(error);
}
