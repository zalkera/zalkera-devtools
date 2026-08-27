/**
 * **받기** — 서버 판을 로컬 작업본에 반영한다(memo184 §2.2 · T1).
 *
 * ■ 이 동사가 「폴더 갈아 끼우기」와 다른 점
 *
 * `refreshSiteSource` 는 폴더를 **통째로** 서버 정본으로 바꾼다. 받기는 그럴 수 없다 — 고객이 옆에
 * 두고 쓰는 파일(메모·스크립트·아직 안 올린 작업)이 같이 사라지기 때문이다. 그래서 세 집합으로
 * 갈라 **판이 아는 경로만** 손대고, 손대야 하는데 로컬이 달라졌으면 **아무것도 안 하고 거절한다.**
 *
 * ■ 순서가 계약이다
 *
 * ⑴ 받는다 → ⑵ 대조한다 → ⑶ 정한다 → ⑷ 거절이면 **여기서 끝**(폴더 무접촉) → ⑸ 쓴다·지운다 →
 * ⑹ **장부는 맨 마지막에 한 번.**
 *
 * ⚠ 로컬 파일시스템에 트랜잭션이 없다. **원자성을 주장하지 않는다 — 멱등 재실행이 계약이다.**
 *   ⑸ 중간에 죽으면 장부는 옛 상태이고 작업본은 반쯤이며, 다음 실행이 관용 1(로컬 sha == 받을 sha
 *   면 충돌 아님)로 이어받는다. 장부를 먼저 쓰면 그 재실행이 **자기 잔해를 순수 로컬로 착각**해
 *   영영 안 고친다.
 */
import {mkdir, readFile, rename, rmdir, unlink, writeFile} from "node:fs/promises";
import {dirname, join, basename, resolve} from "node:path";
import type {ZalkeraApi} from "./api.ts";
import {DevtoolsError} from "./errors.ts";
import {fetchVerifiedSourceTar} from "./fetchSource.ts";
import {MAX_EXTRACT_BYTES} from "./limits.ts";
import {applyAfterDiscard, planPull, type PullPlan} from "./pullPlan.ts";
import {
    SYNC_LEDGER_FORMAT,
    SYNC_LEDGER_PATH,
    parseSyncLedger,
    serializeSyncLedger,
    type SyncLedger,
} from "./syncLedger.ts";
import {extractTarGz, readTarGzManifest} from "./untar.ts";
import {hashWorkdir, resolveExisting} from "./workdir.ts";

/**
 * 충돌 파일을 치워 두는 형제 폴더의 이름 접두(memo184 §2.8 (가)).
 *
 * ⚠ **형제여야 한다.** 시스템 임시 폴더로 옮기면 파일시스템이 달라 `rename` 이 `EXDEV` 로 죽고,
 *   「치워 뒀습니다」가 거짓이 된다 — `replaceDir.ts` 가 이미 겪은 함정이다.
 * ⚠ **`STASH_PREFIX` 를 재사용하지 않는다.** 그쪽은 갈아 끼우기가 실패했을 때만 남는 **잔재**라
 *   감지기가 「지난 작업이 남긴 것」이라 신고한다. 이 폴더는 사람이 되찾아 가라고 **일부러** 남기는
 *   자리다. 한 이름으로 묶으면 일부러 남긴 것을 잔재라 부르게 된다.
 */
export const SAVED_SUFFIX = ".zalkera-saved";

export interface PullOptions {
    api: ZalkeraApi;
    /** 사이트 소스 폴더. */
    folder: string;
    /** 받을 판. 없으면 서버가 고른다(활성 판). */
    revisionNo?: number;
    /** 충돌을 **치워 두고** 진행한다. 명시 동의가 있을 때만 참이다. */
    discardLocal?: boolean;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}

export interface PullResult {
    revisionNo: number;
    /** 쓴 파일 수(새로 만든 것 + 덮은 것). */
    written: number;
    deleted: number;
    unchanged: number;
    /** 어느 매니페스트에도 없던 순수 로컬 파일 수. **안 건드렸다.** */
    untracked: number;
    /** `discardLocal` 로 치워 둔 자리. 치운 것이 없으면 `null`. */
    savedTo: string | null;
    /**
     * 장부를 다시 썼는가. **거짓이면 다음 `push` 가 거절된다** — 「모름」이 정직한 답이고,
     * 복구는 `baseline` 이다(작업본 무접촉).
     */
    ledgerWritten: boolean;
}

/** 받기를 실행한다. 거절이면 [DevtoolsError] `PULL_WOULD_OVERWRITE` 를 던지고 폴더는 그대로다. */
export async function pullSiteSource(options: PullOptions): Promise<PullResult> {
    const report = options.onProgress ?? (() => {});
    const root = resolve(options.folder);

    const ledger = await readLedger(root);
    report("사이트 소스를 받는 중입니다…");
    const tar = await fetchVerifiedSourceTar({
        api: options.api,
        revisionNo: options.revisionNo,
        onProgress: report,
        fetchImpl: options.fetchImpl,
    });

    report("무엇이 달라졌는지 견주는 중입니다…");
    const incoming = await readTarGzManifest(tar.buffer, {maxBytes: MAX_EXTRACT_BYTES});
    const local = await hashWorkdir(root);
    const plan = planPull({incoming, ledger: ledger?.files ?? {}, local});

    let savedTo: string | null = null;
    if (plan.conflicts.length > 0) {
        // ⑷ **폴더 무접촉으로 끝나는 자리.** 여기서 한 글자라도 쓰면 「아무것도 하지 않았습니다」가
        //    거짓이 되고, 사람은 되돌릴 자리를 못 찾는다.
        if (!options.discardLocal) throw conflictRefusal(plan);
        savedTo = await setAside(root, plan);
        report(`고친 내용을 ${basename(savedTo)} 에 옮겨 두었습니다.`);
    }

    // ⑸ 쓰기·지우기. `decide` 가 계획을 그대로 해제기에 건넨다 — 경로 판정은 해제기의 굳은 자리를
    //    그대로 지난다(우리가 손으로 `writeFile` 하면 그 방어가 통째로 빠진다).
    // 치운 뒤에는 **처분이 달라진다** — 치워 두기만 하고 서버 내용을 안 쓰면 그 경로가 통째로
    // 사라진다([applyAfterDiscard]).
    const todo = savedTo ? applyAfterDiscard(plan, incoming) : {writes: plan.writes, deletes: plan.deletes};
    const writes = new Set(todo.writes);
    await extractTarGz(tar.buffer, root, {
        maxBytes: MAX_EXTRACT_BYTES,
        rejectVendored: true,
        decide: (path) => (writes.has(path) ? "replace" : "skip"),
    });
    const deleted = await applyDeletes(root, todo.deletes);

    // ⑹ **장부는 맨 마지막에 한 번.**
    const generation = await currentGeneration(options.api);
    const next: SyncLedger = {
        format: SYNC_LEDGER_FORMAT,
        tenant: options.api.tenantCode(),
        base: {revisionNo: tar.revisionNo, tarSha256: tar.sha256},
        files: Object.fromEntries(
            Object.entries(incoming).map(([path, entry]) => [path, {sha256: entry.sha256, bytes: entry.bytes}]),
        ),
        server: generation === null ? null : {generation},
        mine: {},
        pulledAt: new Date().toISOString(),
        pushedAt: ledger?.pushedAt ?? null,
    };
    const ledgerWritten = await writeLedger(root, next);

    return {
        revisionNo: tar.revisionNo,
        written: todo.writes.length,
        deleted,
        unchanged: plan.unchanged.length,
        untracked: plan.untracked.length,
        savedTo,
        ledgerWritten,
    };
}

/** 장부를 읽는다. 없거나 깨졌으면 `null` — **부분 복구하지 않는다.** */
export async function readLedger(root: string): Promise<SyncLedger | null> {
    const text = await readFile(join(root, SYNC_LEDGER_PATH), "utf8").catch(() => null);
    return text === null ? null : parseSyncLedger(text);
}

/**
 * 장부를 쓴다. **못 써도 던지지 않는다** — 작업본은 이미 새 판이고, 여기서 던지면 사람은
 * 「받기가 실패했다」로 읽고 다시 받는다(`refreshSource.ts` 가 같은 이유로 같은 선택을 했다).
 * 못 쓴 사실은 반환값이 말하고, 다음 `push` 가 거절하며, 복구는 `baseline` 이다.
 */
export async function writeLedger(root: string, ledger: SyncLedger): Promise<boolean> {
    try {
        await mkdir(join(root, dirname(SYNC_LEDGER_PATH)), {recursive: true});
        await writeFile(join(root, SYNC_LEDGER_PATH), serializeSyncLedger(ledger));
    } catch {
        return false;
    }
    // `.gitignore` 는 **부가**다. 못 써도 장부는 이미 섰다 — 여기서 거짓을 돌려주면 다음 push 가
    // 멀쩡한 장부를 두고 거절한다.
    await ignoreLedger(root).catch(() => {});
    return true;
}

/**
 * `.gitignore` 에 장부를 적는다(memo184 §2.1).
 *
 * ⚠ 목적은 **유출 방지가 아니라 거짓 상태 방지**다. 장부에는 비밀이 없다. 다른 기계의 `mine` 이
 *   커밋을 타고 넘어오면 이 폴더는 자기가 안 올린 것을 올렸다고 믿는다.
 */
async function ignoreLedger(root: string): Promise<void> {
    const path = join(root, ".gitignore");
    const current = await readFile(path, "utf8").catch(() => "");
    if (current.split(/\r?\n/).some((line) => line.trim() === SYNC_LEDGER_PATH)) return;
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    await writeFile(path, `${current}${prefix}${SYNC_LEDGER_PATH}\n`);
}

/** 지금 서버 드래프트 세대. 못 읽으면 `null`(= 다음 push 가 서버에 다시 묻는다). */
async function currentGeneration(api: ZalkeraApi): Promise<string | null> {
    return await api
        .draftFiles()
        .then((state) => state.generation ?? null)
        .catch(() => null);
}

/**
 * 계획의 삭제를 적용하고 **빈 폴더를 정리한다.**
 *
 * ⚠ 경로는 [resolveExisting] 을 지난다 — 장부는 로컬 파일이라 손으로 고칠 수도, 남이 만든 zip 에
 *   실려 올 수도 있다. 적힌 경로를 그대로 `unlink` 하면 `../../` 한 줄로 폴더 밖이 지워진다.
 */
async function applyDeletes(root: string, paths: readonly string[]): Promise<number> {
    let count = 0;
    const parents = new Set<string>();
    for (const path of paths) {
        const target = await resolveExisting(root, path);
        if (!target) continue;
        await unlink(target).catch(() => {});
        count += 1;
        let dir = dirname(target);
        while (dir.length > root.length && dir.startsWith(root)) {
            parents.add(dir);
            dir = dirname(dir);
        }
    }
    // 깊은 것부터 지워야 부모가 비워진다.
    for (const dir of [...parents].sort((a, b) => b.length - a.length)) {
        await rmdir(dir).catch(() => {});
    }
    return count;
}

/**
 * 충돌 파일을 **형제 폴더로 옮긴다.** 지우지 않는다 — 사람이 되찾아 갈 수 있어야 한다.
 *
 * 로컬에서 지워진 경로(`deleted-locally`)는 옮길 실물이 없으므로 건너뛴다. 그 경로는 다음 걸음의
 * 해제기가 서버 내용으로 되살린다.
 */
async function setAside(root: string, plan: PullPlan): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const saved = join(dirname(root), `${basename(root)}${SAVED_SUFFIX}`, stamp);
    for (const conflict of plan.conflicts) {
        const from = await resolveExisting(root, conflict.path);
        if (!from) continue;
        const to = join(saved, conflict.path);
        await mkdir(dirname(to), {recursive: true});
        await rename(from, to);
    }
    return saved;
}

/**
 * 거절 문면(memo184 §2.9).
 *
 * ⚠ **경로를 전량 나열하지 않는다** — 건수 + 최대 10경로 + 「외 N개」. 수백 줄이 쏟아지면 사람은
 *   맨 아래 「어떻게 하라」를 못 본다.
 * ⚠ 사실만 적고 끊지 않는다 — **다음에 할 일을 문장 안에 둔다.**
 */
export const CONFLICT_LIST_CAP = 10;

function conflictRefusal(plan: PullPlan): DevtoolsError {
    const paths = plan.conflicts.map((c) => c.path);
    const shown = paths.slice(0, CONFLICT_LIST_CAP);
    const rest = paths.length - shown.length;
    const list = shown.map((p) => `  · ${p}`).join("\n") + (rest > 0 ? `\n  · 외 ${rest}개` : "");
    return new DevtoolsError(
        "PULL_WOULD_OVERWRITE",
        `이 폴더에서 고친 것이 ${paths.length}개 있어 아무것도 받지 않았습니다.\n${list}`,
        "고친 내용을 먼저 올리려면 `zalkera push`, 버리고 서버 것으로 받으려면 `zalkera pull --discard-local` 을 실행하세요. 버리는 쪽을 골라도 고친 파일은 옆 폴더에 옮겨 둡니다.",
    );
}
