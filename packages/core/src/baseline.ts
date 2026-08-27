/**
 * **장부를 판에서 다시 세운다**(memo184 §2.1 전이표 — `baseline`).
 *
 * ■ 무엇을 위한 동사인가
 *
 * 장부가 없거나 깨졌으면 `push` 는 거절된다 — 선행조건을 세울 근거가 없기 때문이다. 그때 사람에게
 * 「폴더를 지우고 다시 받으세요」라고 말하면 **작업본이 사라진다.** 이 동사는 서버 판 매니페스트를
 * 다시 읽어 장부만 고쳐 세운다.
 *
 * ⚠ **작업본을 안 고친다.** 그래서 고쳐 둔 것이 그대로 남고, 다음 `status` 가 그것을 「고친 것」으로
 *   정직하게 보고한다. 파일을 맞춰 주는 일은 `pull` 의 몫이다 — 한 동사가 둘 다 하면 「장부만 고치려
 *   했는데 내 작업이 사라졌다」가 난다.
 *
 * ■ 🔴 그러나 **읽기는 한다** — 안 읽으면 위험한 거짓을 조용히 세운다
 *
 * 이 동사의 전제는 「이 폴더가 **그 판에 있다**」이다. 그 전제가 깨진 폴더에 기준을 세우면, 장부는
 * 「이 폴더는 9판 기반이다」라고 **거짓을 선언**하고 그 뒤의 `push` 는 9판과 다른 것을 전부 보낸다 —
 * 내가 만진 적 없는 파일까지. 그 선행조건은 새 매니페스트에서 나오므로 **정당하게 통과**하고,
 * 남이 9판에 넣은 변경이 조용히 옛 내용으로 되돌아간다(실측: 만진 것 1개 · 나간 것 4개).
 *
 * 그래서 **작업본을 읽어 몇 개가 그 판과 다른지 센다.** 고치지 않고, 말한다.
 *
 * ⚠ **`files` 를 「직전 작업본」으로 추정하지 않는다.** 서버가 경로 정규화·제외 목록을 적용하므로
 *   추정은 조용히 어긋난다. 판의 tar 를 받아 **다시 읽는다.**
 */
import {readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import type {ZalkeraApi} from "./api.ts";
import {DevtoolsError} from "./errors.ts";
import {fetchVerifiedSourceTar} from "./fetchSource.ts";
import {writeLedger} from "./pull.ts";
import {MAX_EXTRACT_BYTES} from "./limits.ts";
import {
    SYNC_LEDGER_FORMAT,
    SYNC_LEDGER_PATH,
    parseSyncLedger,
    type SyncLedger,
} from "./syncLedger.ts";
import {readTarGzManifest} from "./untar.ts";
import {hashWorkdir} from "./workdir.ts";

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
    /**
     * 🔴 **이 폴더가 그 판과 다른 경로들.** 비어 있는 것이 정상이다.
     *
     * 비지 않으면 이 폴더는 그 판에 있지 않고, 방금 세운 기준은 **그만큼 거짓**이다. 그 상태로
     * `push` 하면 여기 실린 것이 **전부** 올라가 그 판의 내용을 덮는다 — 내가 만진 적 없는 것까지.
     * 부르는 쪽은 이것을 **말해야 한다.**
     */
    differing: string[];
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

    // ⚠ 장부 쓰기는 **한 문**을 지난다([writeLedger]) — 여기만 맨 `writeFile` 이면 심링크 방어와
    //   git 배제가 이 동사에서만 빠진다. `baseline` 은 장부를 **처음 세우는 복구 동사**라 그 둘이
    //   특히 필요하다(심의 지적).
    const written = await writeLedger(root, ledger);
    if (!written) {
        throw new DevtoolsError(
            "LEDGER_UNKNOWN",
            "기준 기록을 쓰지 못했습니다.",
            "폴더의 `.zalkera` 자리가 링크이거나 쓸 수 없는 상태인지 확인해 주세요.",
        );
    }

    // 고치지 않고 **읽어서 센다** — 전제가 깨진 폴더에 기준을 세운 것인지 부르는 쪽이 알아야 한다.
    const local = await hashWorkdir(root);
    const differing = Object.keys(manifest)
        .filter((path) => local[path]?.sha256 !== manifest[path]?.sha256)
        .concat(Object.keys(local).filter((path) => manifest[path] === undefined))
        .sort();

    return {
        revisionNo: tar.revisionNo,
        files: Object.keys(manifest).length,
        replaced: previous !== null,
        differing,
    };
}
