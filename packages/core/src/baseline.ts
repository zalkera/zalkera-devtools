/**
 * **장부를 판에서 다시 세운다**(memo184 §2.1 전이표 — `baseline`).
 *
 * ■ 무엇을 위한 동사인가
 *
 * 장부가 없거나 깨졌으면 `push` 는 거절된다 — 선행조건을 세울 근거가 없기 때문이다. 그때 사람에게
 * 「폴더를 지우고 다시 받으세요」라고 말하면 **작업본이 사라진다.** 이 동사는 서버 판 매니페스트를
 * 다시 읽어 장부만 고쳐 세운다.
 *
 * ⚠ **작업본을 안 건드린다.** 그래서 고쳐 둔 것이 그대로 남고, 다음 `status` 가 그것을 「고친 것」으로
 *   정직하게 보고한다. 파일을 맞춰 주는 일은 `pull` 의 몫이다 — 한 동사가 둘 다 하면 「장부만 고치려
 *   했는데 내 작업이 사라졌다」가 난다.
 *
 * ⚠ **`files` 를 「직전 작업본」으로 추정하지 않는다.** 서버가 경로 정규화·제외 목록을 적용하므로
 *   추정은 조용히 어긋난다. 판의 tar 를 받아 **다시 읽는다.**
 */
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import type {ZalkeraApi} from "./api.ts";
import {fetchVerifiedSourceTar} from "./fetchSource.ts";
import {MAX_EXTRACT_BYTES} from "./limits.ts";
import {
    SYNC_LEDGER_FORMAT,
    SYNC_LEDGER_PATH,
    parseSyncLedger,
    serializeSyncLedger,
    type SyncLedger,
} from "./syncLedger.ts";
import {readTarGzManifest} from "./untar.ts";

export interface BaselineOptions {
    api: ZalkeraApi;
    folder: string;
    /** 어느 판을 기준으로 세울지. 없으면 서버가 고른다(활성 판). */
    revisionNo?: number;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}

export interface BaselineResult {
    revisionNo: number;
    /** 판이 담고 있는 파일 수. */
    files: number;
    /** 종전 장부가 있었는가. 거짓이면 새로 세운 것이다. */
    replaced: boolean;
}

/** 장부를 판에서 다시 세운다. 작업본은 **읽지도 쓰지도 않는다.** */
export async function rebuildBaseline(options: BaselineOptions): Promise<BaselineResult> {
    const report = options.onProgress ?? (() => {});
    const root = resolve(options.folder);

    const previousText = await readFile(join(root, SYNC_LEDGER_PATH), "utf8").catch(() => null);
    const previous = previousText === null ? null : parseSyncLedger(previousText);

    report("판의 파일 목록을 다시 읽는 중입니다…");
    const tar = await fetchVerifiedSourceTar({
        api: options.api,
        revisionNo: options.revisionNo,
        onProgress: report,
        fetchImpl: options.fetchImpl,
    });
    const manifest = await readTarGzManifest(tar.buffer, {maxBytes: MAX_EXTRACT_BYTES});

    // 세대는 **다시 묻는다.** 옛 장부의 값을 물려받으면 이미 지난 세대를 지금 값이라 믿는다.
    const generation = await options.api
        .draftFiles()
        .then((state) => state.generation ?? null)
        .catch(() => null);

    const ledger: SyncLedger = {
        format: SYNC_LEDGER_FORMAT,
        tenant: options.api.tenantCode(),
        base: {revisionNo: tar.revisionNo, tarSha256: tar.sha256},
        files: Object.fromEntries(
            Object.entries(manifest).map(([path, entry]) => [path, {sha256: entry.sha256, bytes: entry.bytes}]),
        ),
        server: generation === null ? null : {generation},
        // ⚠ **`mine` 은 비운다.** 옛 장부의 `mine` 을 살리면 「내가 올린 것」이라는 주장이 근거 없이
        //   되살아난다 — 그 주장이 좌초 안내와 응답 유실 화해의 입력이다.
        mine: {},
        pulledAt: previous?.pulledAt ?? new Date().toISOString(),
        pushedAt: previous?.pushedAt ?? null,
    };

    await mkdir(join(root, dirname(SYNC_LEDGER_PATH)), {recursive: true});
    await writeFile(join(root, SYNC_LEDGER_PATH), serializeSyncLedger(ledger));

    return {revisionNo: tar.revisionNo, files: Object.keys(manifest).length, replaced: previous !== null};
}
