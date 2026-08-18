/**
 * 서버가 준 주소에서 받는 자리의 **주소 검사·크기 상한**.
 *
 * 이 둘이 없으면 서버가 준 한 줄로 평문 `http://` 에서 받아 풀고 `next dev` 로 **실행**하게 되고,
 * `Content-Encoding: gzip` 자동 해제로 작은 응답이 수백 MB 의 상주 메모리가 된다. 무결성 대조는
 * 그 **뒤**에 오므로 대조가 있어도 이 자리는 못 막는다(심의 실측).
 */
import { ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { downloadBounded } from "./download.ts";
import { DevtoolsError } from "./errors.ts";

/** 지정한 바이트를 조각으로 흘리는 응답. */
function streaming(totalBytes: number, chunk = 64 * 1024): typeof fetch {
    return (async () => {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent >= totalBytes) {
                    controller.close();
                    return;
                }
                const size = Math.min(chunk, totalBytes - sent);
                sent += size;
                controller.enqueue(new Uint8Array(size));
            },
        });
        return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
}

const opts = { timeoutMs: 5_000, what: "소스" };

test("평문 http 주소는 받지 않는다 — 루프백이 아니면", async () => {
    await rejects(
        () => downloadBounded("http://example.com/a.tar.gz", { ...opts, fetchImpl: streaming(1) }),
        (error: unknown) => error instanceof DevtoolsError && /신뢰할 수 없습니다/.test(error.message),
    );
});

test("data:·file: 주소도 받지 않는다", async () => {
    for (const url of ["data:application/gzip;base64,AAAA", "file:///etc/passwd", "ftp://x/y", "javascript:1"]) {
        await rejects(
            () => downloadBounded(url, { ...opts, fetchImpl: streaming(1) }),
            (error: unknown) => error instanceof DevtoolsError,
            url,
        );
    }
});

test("상한을 넘으면 끊는다 — 다 받고 나서가 아니라 받는 중에", async () => {
    // ⚠ **픽스처 자체에 상한을 둔다.** 종전엔 무한 스트림이었는데, 상한을 지우는 변이 시험을
    //   돌리자 이 시험이 메모리를 다 먹고 **기계를 내렸다**(실측: 20초 만에 여유 20G → 1G).
    //   가드가 깨졌을 때 시험은 **실패해야** 하지 기계를 죽이면 안 된다.
    const FIXTURE_CAP = 512; // 조각(= 32MB). 상한(256KB)의 128배라 «안 끊었다» 판정에 충분하다.
    let pulled = 0;
    const counting: typeof fetch = (async () => {
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulled >= FIXTURE_CAP) {
                    controller.close();
                    return;
                }
                pulled += 1;
                controller.enqueue(new Uint8Array(64 * 1024));
            },
        });
        return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    await rejects(
        () => downloadBounded("https://cdn.example/a.tar.gz", { ...opts, fetchImpl: counting, maxBytes: 256 * 1024 }),
        (error: unknown) => error instanceof DevtoolsError && /너무 큽니다/.test(error.message),
    );
    // 픽스처 상한보다 훨씬 앞에서 끊겼어야 한다 — 다 받고 나서 판정하면 상한이 아니다.
    ok(pulled < 64, `상한을 넘고도 ${pulled}조각을 더 받았다(픽스처 상한 ${FIXTURE_CAP})`);
});

test("HTTP 오류는 사람 말로 끊는다", async () => {
    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await rejects(
        () => downloadBounded("https://cdn.example/a.tar.gz", { ...opts, fetchImpl: failing }),
        (error: unknown) => error instanceof DevtoolsError && /HTTP 503/.test(error.message),
    );
});

test("양성 통제군 — https 는 그대로 받는다", async () => {
    const buffer = await downloadBounded("https://cdn.example/a.tar.gz", { ...opts, fetchImpl: streaming(300 * 1024) });
    strictEqual(buffer.length, 300 * 1024);
});

test("양성 통제군 — 루프백 http 는 받는다(로컬 개발)", async () => {
    const buffer = await downloadBounded("http://127.0.0.1:9000/a.zip", { ...opts, fetchImpl: streaming(1024) });
    strictEqual(buffer.length, 1024);
});

test("양성 통제군 — 상한 바로 아래는 그대로 받는다", async () => {
    const limit = 256 * 1024;
    const buffer = await downloadBounded("https://cdn.example/a.zip", {
        ...opts,
        fetchImpl: streaming(limit),
        maxBytes: limit,
    });
    strictEqual(buffer.length, limit);
});
