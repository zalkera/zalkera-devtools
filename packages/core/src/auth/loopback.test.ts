import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DevtoolsError } from "../errors.ts";
import { startLoopbackReceiver } from "./loopback.ts";

/** 브라우저가 돌아온 것을 흉내 낸다 — 실제 리다이렉트와 같은 경로로 수신기를 친다. */
async function callback(redirectUri: string, query: string): Promise<number> {
    const response = await fetch(`${redirectUri}?${query}`);
    return response.status;
}

test("코드를 받으면 state 와 함께 돌려준다", async () => {
    const receiver = await startLoopbackReceiver();
    try {
        const waiting = receiver.waitForCode();
        strictEqual(await callback(receiver.redirectUri, "code=abc&state=xyz"), 200);
        const result = await waiting;
        strictEqual(result.code, "abc");
        strictEqual(result.state, "xyz");
    } finally {
        receiver.close();
    }
});

test("사람이 브라우저에서 취소하면 CANCELLED 다 — 오류가 아니다", async () => {
    // Keycloak 은 로그인 화면의 취소를 `access_denied` 리다이렉트로 돌려준다. 이것을 일반 오류로
    // 다루면 오류 창이 뜨고 진행 알림이 남아 **사용자가 취소를 두 번** 하게 된다(실사용 신고).
    const receiver = await startLoopbackReceiver();
    try {
        const waiting = receiver.waitForCode();
        // 취소는 실패가 아니므로 브라우저에도 200 과 안내 문구를 준다.
        strictEqual(await callback(receiver.redirectUri, "error=access_denied"), 200);
        await waiting.then(
            () => ok(false, "취소인데 성공으로 끝났다"),
            (error: unknown) => {
                ok(error instanceof DevtoolsError);
                strictEqual(error.code, "CANCELLED");
            },
        );
    } finally {
        receiver.close();
    }
});

test("진짜 오류는 CANCELLED 로 뭉개지 않는다", async () => {
    // `server_error` 는 사람이 할 일이 다르다(설정·서버 점검). 취소로 삼키면 원인이 사라진다.
    const receiver = await startLoopbackReceiver();
    try {
        const waiting = receiver.waitForCode();
        strictEqual(await callback(receiver.redirectUri, "error=server_error&error_description=terrible"), 400);
        await waiting.then(
            () => ok(false, "오류인데 성공으로 끝났다"),
            (error: unknown) => {
                ok(!(error instanceof DevtoolsError && error.code === "CANCELLED"), "취소로 뭉개면 안 된다");
                strictEqual((error as Error).message, "terrible");
            },
        );
    } finally {
        receiver.close();
    }
});

test("close() 는 대기를 매달린 채로 두지 않는다", async () => {
    // close() 가 타이머만 지우고 약속을 안 깨우면, 취소 경로에서 **타임아웃마저 사라져 영원히**
    // 매달린다(실측 결함). 닫혔는데 안 끝났으면 취소로 정착시킨다.
    const receiver = await startLoopbackReceiver();
    const waiting = receiver.waitForCode();
    receiver.close();
    await waiting.then(
        () => ok(false, "닫혔는데 성공으로 끝났다"),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            strictEqual(error.code, "CANCELLED");
        },
    );
});

test("취소 신호를 주면 수신기가 스스로 닫힌다", async () => {
    const controller = new AbortController();
    const receiver = await startLoopbackReceiver({ signal: controller.signal });
    const waiting = receiver.waitForCode();
    controller.abort();
    await waiting.then(
        () => ok(false, "취소인데 성공으로 끝났다"),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            strictEqual(error.code, "CANCELLED");
        },
    );
});
