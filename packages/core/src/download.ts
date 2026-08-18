import { DevtoolsError } from "./errors.ts";
import { apiBaseUrl } from "./serverUrl.ts";

/**
 * **서버가 준 주소에서 바이트를 받는다 — 상한을 걸고.**
 *
 * ■ 왜 한 곳에 모으나
 *   내려받는 자리가 셋인데(시작 소스 zip · 사이트 소스 tar.gz · 의존성 꾸러미) 가드가 자리마다
 *   달랐다. 심의 실측:
 *
 *     | | `fetchSource` | `presets` | `payload` |
 *     |---|---|---|---|
 *     | 주소 검사 | 없음 | 없음 | 있음 |
 *     | 크기 상한 | 없음 | 없음 | 있음 |
 *
 *   같은 규율을 세 곳이 다르게 구현하던 것이 이 레포의 반복 결함이다. 한 곳에 둔다.
 *
 * ■ 주소
 *   **https 이거나 루프백**이어야 한다 — 서버 주소와 같은 정책([apiBaseUrl])이다. 그러지 않으면
 *   서버가 준 한 줄로 평문 `http://` 나 `data:` 에서 받아 풀고 `next dev` 로 **실행**하게 된다.
 *
 * ■ 크기
 *   `response.arrayBuffer()` 는 상한이 없다. 게다가 Node 의 `fetch` 는 `Content-Encoding: gzip` 을
 *   자동으로 푼다 — 실측으로 전선 152,908 B 가 RSS +497MB 가 됐다. 무결성 대조는 그 **뒤**에
 *   오므로, 대조가 있어도 이 자리는 못 막는다. 그래서 **읽으면서** 센다.
 *
 *   `Content-Length` 를 믿지 않는다(서버가 정한다). 실제로 읽은 바이트로만 판정한다.
 */

/** 내려받기 상한. 업로드 상한(100MB · `publish.ts`)에 여유를 얹은 값이다. */
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export interface DownloadOptions {
    fetchImpl: typeof fetch;
    /** 전송 상한(ms). 느린 회선의 정상 수신을 끊지 않을 만큼 넉넉해야 한다. */
    timeoutMs: number;
    /** 실패 문구에 쓸 이름 — 「무엇을」 내려받다 실패했는지 사람이 알아야 한다. */
    what: string;
    /** 상한(바이트). 비우면 [MAX_DOWNLOAD_BYTES]. */
    maxBytes?: number;
}

export async function downloadBounded(url: string, options: DownloadOptions): Promise<Buffer> {
    if (apiBaseUrl(url) === null) {
        // 주소를 서버가 정하므로, 우리가 아는 형태가 아니면 **받지 않는다.**
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `${options.what} 주소를 신뢰할 수 없습니다.`,
            "잘커라에 문의해 주세요. 받지 않고 멈췄습니다.",
        );
    }

    const response = await options.fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs) });
    if (!response.ok || !response.body) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `${options.what}를 내려받지 못했습니다(HTTP ${response.status}).`,
            "잠시 뒤 다시 시도해 주세요.",
        );
    }

    const limit = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > limit) {
            // 스트림을 끊는다 — 남은 것을 마저 받을 이유가 없다.
            await response.body.cancel().catch(() => {});
            throw new DevtoolsError(
                "SERVER_REJECTED",
                `${options.what}가 너무 큽니다(상한 ${Math.round(limit / 1024 / 1024)}MB).`,
                "받은 것이 정상이 아닙니다. 잘커라에 문의해 주세요.",
            );
        }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
}
