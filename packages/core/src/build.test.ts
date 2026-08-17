import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { waitForBuild } from "./build.ts";
import type { SiteRevision } from "./api.ts";
import { DevtoolsError } from "./errors.ts";

/** 시계와 잠을 **가짜로** 준다 — 진짜 3초를 기다리는 테스트는 아무도 안 돌린다. */
function harness(pages: SiteRevision[][]) {
    let clock = 0;
    let page = 0;
    const slept: number[] = [];
    return {
        slept,
        get calls() {
            return page;
        },
        now: () => clock,
        sleep: async (ms: number) => {
            slept.push(ms);
            clock += ms;
        },
        listRevisions: async () => {
            // ⚠ **비면 던진다.** 종전에는 `undefined` 가 나갔다 — 시험이 준비한 것보다 더 많이 부르면
            //   그 사실이 조용히 «빈 목록»으로 둔갑해, 무엇을 재는지 모르는 채 초록이 된다.
            const at = Math.min(page++, pages.length - 1);
            const found = pages[at];
            if (!found) throw new Error(`시험이 준비한 응답이 없다(${at}번째 · 준비 ${pages.length}개)`);
            return found;
        },
    };
}

const rev = (revisionNo: number, status: string, failReason?: string): SiteRevision => ({
    revisionNo,
    status,
    isActive: false,
    createdAt: "2026-08-10T00:00:00Z",
    ...(failReason === undefined ? {} : { failReason }),
});

test("이미 READY 면 한 번 보고 끝난다 — 재우지 않는다", async () => {
    const h = harness([[rev(4, "READY")]]);
    const outcome = await waitForBuild({ revisionNo: 4, ...h });

    strictEqual(outcome.kind, "ready");
    strictEqual(h.calls, 1, "목록을 한 번만 본다");
    deepStrictEqual(h.slept, [], "READY 인데 3초를 재우면 그냥 3초 손해다");
});

test("BUILDING 이면 READY 가 될 때까지 기다린다", async () => {
    const h = harness([[rev(4, "BUILDING")], [rev(4, "BUILDING")], [rev(4, "READY")]]);
    const messages: string[] = [];
    const outcome = await waitForBuild({ revisionNo: 4, ...h, onProgress: (m) => messages.push(m) });

    strictEqual(outcome.kind, "ready");
    strictEqual(h.calls, 3);
    deepStrictEqual(h.slept, [3000, 3000]);
    strictEqual(messages.length, 1, "BUILDING 을 두 번 봤지만 진행 보고는 2회차부터다");
    strictEqual(messages[0], "서버가 빌드하는 중… (3초)");
});

test("FAILED 면 사유를 들고 끝난다", async () => {
    const h = harness([[rev(4, "FAILED", "Module not found: ./missing")]]);
    const outcome = await waitForBuild({ revisionNo: 4, ...h });

    strictEqual(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    strictEqual(outcome.reason, "Module not found: ./missing");
});

test("사유를 못 받아도(권한 없음) 실패는 실패다", async () => {
    // failReason 은 TENANT_ADMIN+ 에게만 온다 — VIEWER 는 "실패했다"까지만 본다.
    const h = harness([[rev(4, "FAILED")]]);
    const outcome = await waitForBuild({ revisionNo: 4, ...h });

    strictEqual(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    strictEqual(outcome.reason, null, "null 이어야 호출부가 '사유 없음'을 그릴 수 있다");
});

test("상한을 넘으면 실패가 아니라 timeout 이다", async () => {
    // **실패로 부르면 안 된다.** 서버는 계속 빌드하고 있을 수 있다.
    const h = harness([[rev(4, "BUILDING")]]);
    const outcome = await waitForBuild({ revisionNo: 4, ...h, timeoutMs: 10_000 });

    strictEqual(outcome.kind, "timeout");
    // 상한 검사가 **자기 전**에 있어 최대 한 간격만큼 넘길 수 있다(9초 시점에 한 번 더 잔다).
    // 일부러 그렇게 뒀다 — 한 번 더 보는 것이 한 번 덜 보고 timeout 이라 말하는 것보다 낫다.
    strictEqual(h.slept.length, 4, "9초 시점에 한 번 더 자고 12초에 멈춘다");
});

test("목록에서 사라지면 gone — 영원히 기다리지 않는다", async () => {
    const h = harness([[rev(9, "READY")]]);
    const outcome = await waitForBuild({ revisionNo: 4, ...h });

    strictEqual(outcome.kind, "gone");
});

test("조회가 한 번 실패해도 포기하지 않는다 — 다만 말은 한다", async () => {
    let call = 0;
    let clock = 0;
    const messages: string[] = [];
    const outcome = await waitForBuild({
        revisionNo: 4,
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
        },
        onProgress: (m) => messages.push(m),
        listRevisions: async () => {
            call += 1;
            if (call === 1) throw new DevtoolsError("SERVER_REJECTED", "연결이 끊겼습니다.");
            return [rev(4, "READY")];
        },
    });

    strictEqual(outcome.kind, "ready");
    strictEqual(messages[0], "상태를 확인하지 못했습니다. 다시 시도합니다 — 연결이 끊겼습니다.");
});

test("조회 실패가 이어져도 상한에서 멈춘다 — 무한 재시도가 아니다", async () => {
    let clock = 0;
    let call = 0;
    const outcome = await waitForBuild({
        revisionNo: 4,
        timeoutMs: 10_000,
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
        },
        listRevisions: async () => {
            call += 1;
            throw new Error("죽은 서버");
        },
    });

    strictEqual(outcome.kind, "timeout");
    strictEqual(call <= 5, true, `상한 안에서만 두드린다(실제 ${call}회)`);
});

test("취소하면 즉시 멈춘다", async () => {
    const h = harness([[rev(4, "BUILDING")], [rev(4, "BUILDING")]]);
    let cancelled = false;
    const outcome = await waitForBuild({
        revisionNo: 4,
        ...h,
        isCancelled: () => cancelled,
        onProgress: () => {
            cancelled = true; // 첫 진행 보고 직후 사람이 취소를 눌렀다고 친다
        },
    });

    strictEqual(outcome.kind, "cancelled");
});
