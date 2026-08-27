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
import {lstat, mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile} from "node:fs/promises";
import {ensureOwnDir, writeOwnFile} from "./safeWrite.ts";
import {basename, dirname, join, relative, resolve, sep} from "node:path";
import type {ZalkeraApi} from "./api.ts";
import {DevtoolsError} from "./errors.ts";
import {fetchVerifiedSourceTar} from "./fetchSource.ts";
import {MAX_EXTRACT_BYTES} from "./limits.ts";
import {
    PATH_LIST_CAP,
    applyAfterDiscard,
    planPull,
    trimPaths,
    type PullPlan,
} from "./pullPlan.ts";
import {
    SYNC_LEDGER_FORMAT,
    SYNC_LEDGER_PATH,
    parseSyncLedger,
    serializeSyncLedger,
    type SyncLedger,
} from "./syncLedger.ts";
import {extractTar, gunzipTar, readTarManifest} from "./untar.ts";
import {writeSourceMarkTo} from "./localMark.ts";
import {hashWorkdir, resolveExisting} from "./workdir.ts";
import {isExcludedEntry} from "./zip.ts";

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
    /**
     * 거절 문면에 경로를 **전부** 싣는다(`--verbose`).
     *
     * ⚠ 이 손잡이가 없으면 `--verbose` 가 **사람이 잘린 목록을 가장 자주 만나는 자리**에 안 닿는다 —
     *   거절 문면은 여기서 만들어지고 CLI 는 그것을 그대로 옮길 뿐이다(심의 지적).
     */
    listAll?: boolean;
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
     * 서버가 보냈지만 **우리가 안 만지는** 경로들(`.env`·`.git` 따위). 비어 있는 것이 정상이다 —
     * 비지 않으면 정본 tar 에 실리면 안 될 것이 실린 것이므로 **말한다.**
     */
    serverExcluded: string[];
    /**
     * 이 폴더에 **다른 사이트의** 기준 기록이 있었는가. 참이면 그 기록은 판정에 안 쓰였고
     * 이번 받기가 이 사이트 것으로 덮어썼다.
     */
    foreignLedger: boolean;
    /**
     * 🔴 **삭제 전파를 못 했다.** 기준 기록이 없거나 남의 것이었고 폴더에 파일이 이미 있었다는 뜻이다.
     *
     * 그때 「추적 삭제」 집합(`O ∖ N`)이 통째로 비어, **판이 지운 파일이 로컬에 남는다.** 그리고 이번
     * 받기가 장부를 `N` 으로 새로 쓰는 순간 그 파일은 **어느 매니페스트에도 없는 순수 로컬**로
     * 승격되어 이후 어떤 받기도 못 지운다 — 다음 올리기에서 신설로 판정돼 **부활한다.**
     *
     * 설계(§2.2)가 「pull 의 삭제 전파가 **유일한** 방어」라 못박은 그 방어가 이 회차에는 없었다.
     * 그래서 **조용히 넘기지 않고 말한다.**
     */
    deletionsUnknown: boolean;
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

    // ⑤ **소속이 다른 장부는 근거가 못 된다.** 남의 사이트 장부를 들고 있으면 그 `files` 가
    //    이 판의 매니페스트인 양 판정에 들어가 「이 폴더에서 고친 것이 N개」라는 **엉뚱한 이유**로
    //    거절된다(실측). 규칙은 이미 형제 `declaredBaseRevisionNo` 가 세웠다 — 소속이 다르면
    //    선언하지 않는다.
    const found = await readLedger(root);
    const foreignLedger = found !== null && found.tenant !== options.api.tenantCode();
    const ledger = foreignLedger ? null : found;
    report("사이트 소스를 받는 중입니다…");
    const tar = await fetchVerifiedSourceTar({
        api: options.api,
        revisionNo: options.revisionNo,
        onProgress: report,
        fetchImpl: options.fetchImpl,
    });

    report("무엇이 달라졌는지 견주는 중입니다…");
    // `rejectVendored` 를 **읽기 훑기에** 건다 — 거절이 쓰기보다 앞이어야 폴더가 그대로 남는다.
    // ⚠ **gz 는 한 번만 푼다.** 같은 아카이브를 두 번 보는데(판정 → 쓰기) 각자 풀면 산출물만큼을
    //   두 번 램에 올린다 — 상한(450MB)에서 실측 peak RSS 1,071MB 였다(심의).
    const untarred = await gunzipTar(tar.buffer, MAX_EXTRACT_BYTES);
    const declared = await readTarManifest(untarred, {rejectVendored: true});
    const {incoming, dropped} = withoutExcluded(declared);
    const local = await hashWorkdir(root);
    requireNoFoldedCollision(incoming, local);
    // 기준 기록 없이 «이미 파일이 있는» 폴더를 받으면 삭제 전파가 못 돈다 — 그 사실을 여기서 잡는다.
    // 빈 폴더는 지울 것도 없으므로 해당 없다.
    const deletionsUnknown = ledger === null && Object.keys(local).length > 0;
    const plan = planPull({incoming, ledger: ledger?.files ?? {}, local});

    let savedTo: string | null = null;
    /**
     * 치우면서 **이미 없어진** 경로들. 지우기는 이것들을 못 세므로(실물이 없다) 여기서 따로 센다 —
     * 안 그러면 「지운 것 0개」라고 말하면서 실제로는 지운 것과 같은 일이 벌어진 상태가 된다.
     */
    let movedAway: string[] = [];
    if (plan.conflicts.length > 0) {
        // ⑷ **폴더 무접촉으로 끝나는 자리.** 여기서 한 글자라도 쓰면 「아무것도 하지 않았습니다」가
        //    거짓이 되고, 사람은 되돌릴 자리를 못 찾는다.
        if (!options.discardLocal) throw conflictRefusal(plan, options.listAll === true);
        const aside = await setAside(root, plan);
        savedTo = aside.folder;
        movedAway = aside.moved;
        report(`고친 내용을 ${basename(savedTo)} 에 옮겨 두었습니다.`);
    }

    // ⑸ 쓰기·지우기. `decide` 가 계획을 그대로 해제기에 건넨다 — 경로 판정은 해제기의 굳은 자리를
    //    그대로 지난다(우리가 손으로 `writeFile` 하면 그 방어가 통째로 빠진다).
    // 치운 뒤에는 **처분이 달라진다** — 치워 두기만 하고 서버 내용을 안 쓰면 그 경로가 통째로
    // 사라진다([applyAfterDiscard]).
    const todo = savedTo ? applyAfterDiscard(plan, incoming) : {writes: plan.writes, deletes: plan.deletes};
    // ③ **쓸 자리가 링크면 쓰기 전에 멈춘다.** 해제기도 마지막 조각을 검사하지만 그 검사는 그
    //    항목 차례에 걸리므로, 앞 항목들이 이미 내려앉은 뒤다 — 그리고 재실행해도 링크는 그대로라
    //    사람은 **반쯤 적용된 폴더에 갇힌다.**
    await requireNoLinkedTargets(root, todo.writes);
    // 🔴 **지우기가 먼저다.** 뒤에 두면 판이 파일이던 경로를 폴더로(또는 그 반대로) 바꿨을 때
    //    쓰기가 옛 실물에 걸려 죽는다 — 실측: `app`(파일) → `app/page.tsx`(폴더) 가 「경로가 파일과
    //    겹칩니다」로 막혔고, 재실행해도 같은 자리에서 막혔다. 지운 뒤에 쓰면 자리가 비어 있다.
    //    지우기가 먼저여도 멱등은 안 깨진다 — 지우는 것은 **서버가 이미 버린 경로**뿐이다.
    const moved = new Set(movedAway);
    const deleted =
        (await applyDeletes(root, todo.deletes)) + todo.deletes.filter((path) => moved.has(path)).length;
    const writes = new Set(todo.writes);
    await extractTar(untarred, root, {
        // 여기도 켠다 — 읽기 훑기가 이미 걸렀지만, 이 함수는 공개 API 라 두 경로가 같은 판정을
        // 지나야 한다. 실제로 걸리는 자리는 위쪽이다.
        rejectVendored: true,
        decide: (path) => (writes.has(path) ? "replace" : "skip"),
    });

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
    // 🔴 **소속 표식도 남긴다.** 장부(`sync.json`)가 이 폴더의 **유일한** 소속 기록이면, 장부를
    //    잊는 순간(발행이 새 매니페스트를 못 읽는 경우) 폴더가 **소속까지 잃어 모든 동사가 막힌다**
    //    — `--site` 를 손으로 붙이지 않으면 복구 동사(`baseline`)조차 못 돈다(실측).
    //    그리고 이 표식은 확장이 읽는 자리이기도 하다: 안 남기면 CLI 로 받은 폴더가 확장에서
    //    **소속 없는 폴더**로 보인다.
    await writeSourceMarkTo(root, {
        tenant: options.api.tenantCode(),
        revisionNo: tar.revisionNo,
        sha256: tar.sha256,
        fetchedAt: next.pulledAt,
    }).catch(() => undefined);

    return {
        revisionNo: tar.revisionNo,
        written: todo.writes.length,
        deleted,
        unchanged: plan.unchanged.length,
        untracked: plan.untracked.length,
        savedTo,
        serverExcluded: dropped,
        foreignLedger,
        deletionsUnknown,
        ledgerWritten,
    };
}

/**
 * 받을 매니페스트에 **대소문자만 다른 짝**이 있으면 거절한다 — **쓰기 전에**.
 *
 * macOS·Windows 에서 `App.tsx` 와 `app.tsx` 는 같은 파일이다. 해제기도 이것을 잡지만 그 차례에
 * 걸리므로 앞 항목이 이미 내려앉은 뒤다. 여기서 잡으면 폴더가 그대로 남는다.
 *
 * ⚠ 리눅스에서는 둘이 다른 파일이라 «정상»으로 보이지만, 정본 tar 에 그런 짝이 있으면 **다른
 *   기계에서 이 폴더가 안 선다.** 여기서 끊는 편이 정직하다.
 */
function requireNoFoldedCollision(
    incoming: Readonly<Record<string, unknown>>,
    local: Readonly<Record<string, unknown>>,
): void {
    const seen = new Map<string, string>();
    for (const path of Object.keys(incoming)) {
        const folded = path.toLowerCase();
        const first = seen.get(folded);
        if (first !== undefined) {
            throw new DevtoolsError(
                "SERVER_REJECTED",
                `사이트가 보낸 파일 중 이름이 대소문자만 다른 것이 있습니다: ${first} · ${path}`,
                "컴퓨터에 따라 같은 파일로 취급돼 한쪽이 사라집니다. 아무것도 받지 않았습니다 — 잘커라에 알려 주세요.",
            );
        }
        seen.set(folded, path);
    }
    // 🔴 **받을 목록 안에서만 보면 모자란다**(심의 지적). 로컬에 `readme.md` 가 있고 판이
    //    `README.md` 를 보내면, 계획은 둘을 **별개**로 보고 하나는 「신설」, 하나는 「무간섭」이라
    //    보고한다. 이름을 접는 파일시스템(APFS·NTFS)에서 그 둘은 같은 자리라 고객 파일이 사라진다.
    for (const path of Object.keys(local)) {
        const other = seen.get(path.toLowerCase());
        if (other === undefined || other === path) continue;
        throw new DevtoolsError(
            "PULL_WOULD_OVERWRITE",
            `이 폴더의 ${path} 와 사이트의 ${other} 는 이름이 대소문자만 다릅니다. 아무것도 받지 않았습니다.`,
            "컴퓨터에 따라 같은 파일로 취급돼 한쪽이 사라집니다. 이 폴더의 파일 이름을 바꾸거나 옮겨 두고 다시 실행해 주세요.",
        );
    }
}

/**
 * 쓸 자리로 가는 길에 **링크가 하나라도 있으면** 거절한다 — **쓰기 전에**.
 *
 * 🔴 해제기도 같은 것을 본다([descend]·[assertNotSymlink]). 그런데 그 검사는 **그 항목 차례에**
 *    걸린다 — 앞 항목들은 이미 디스크에 내려앉은 뒤다. 그리고 재실행해도 링크는 그대로라 사람은
 *    「아무것도 받지 않았습니다」라는 말과 반쯤 바뀐 폴더 사이에 갇힌다.
 *
 * ⚠ **잎만 보면 모자란다**(심의 실측). `lstat(root/a/b.ts)` 는 `a` 가 링크면 그것을 **따라간 뒤**
 *   `b.ts` 를 본다 — 부모가 링크인 형상이 그대로 통과한다. 그래서 조각마다 본다.
 */
async function requireNoLinkedTargets(root: string, paths: readonly string[]): Promise<void> {
    const checked = new Set<string>();
    for (const path of paths) {
        const segments = path.split("/").filter((s) => s !== "");
        let current = root;
        for (const part of segments) {
            current = join(current, part);
            if (checked.has(current)) continue;
            checked.add(current);
            const info = await lstat(current).catch(() => null);
            if (!info?.isSymbolicLink()) continue;
            throw new DevtoolsError(
                "PULL_WOULD_OVERWRITE",
                `이 폴더의 ${relative(root, current).split(sep).join("/")} 가 다른 곳을 가리키는 바로가기입니다. 아무것도 받지 않았습니다.`,
                "그 바로가기를 지우고 다시 실행해 주세요. 그대로 두면 이 폴더 밖의 것을 덮어쓰게 됩니다.",
            );
        }
    }
}

/**
 * 받을 매니페스트에서 **우리가 절대 안 만지는 경로**를 걷어낸다.
 *
 * 🔴 **없으면 고객 파일이 조용히 교체된다.** 실측(2026-08-27): 서버 tar 에 `.env` 가 들어 있으면
 *    ⑴ 받을 목록에는 있고 ⑵ 작업본 목록에는 [isExcludedEntry] 때문에 없다 → **신설**로 판정 →
 *    `decide` 가 `replace` 를 돌려 **고객의 진짜 `.env` 를 서버 내용으로 덮었다.** 「이미 있는 파일
 *    위에 안 쓴다」는 규칙은 `replace` 갈래를 안 지나므로 그 자리를 못 막는다.
 *
 * ⚠ **비대칭 자체가 병이다.** 받을 쪽과 작업본 쪽이 다른 목록을 쓰면, 걸러진 경로는 영원히
 *   「그대로 둔 것」이 못 되고 **매 pull 마다 다시 쓰인다.**
 *
 * ⚠ **조용히 빼지 않는다** — 뺀 건수를 돌려주고 부르는 쪽이 말한다(`zip.ts` 가 세운 원칙과 같다).
 *   정본 tar 에 이것들이 실려 오는 것 자체가 서버 쪽 결함 신호다.
 */
export function withoutExcluded(declared: Readonly<Record<string, {sha256: string; bytes: number}>>): {
    incoming: Record<string, {sha256: string; bytes: number}>;
    dropped: string[];
} {
    const incoming: Record<string, {sha256: string; bytes: number}> = {};
    const dropped: string[] = [];
    for (const [path, entry] of Object.entries(declared)) {
        if (isExcludedEntry(path)) dropped.push(path);
        else incoming[path] = entry;
    }
    return {incoming, dropped: dropped.sort()};
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
        // ⚠ **`mkdir(recursive)` + 맨 `writeFile` 을 쓰지 않는다.** `mkdir(recursive)` 는 이미 있으면
        //    무동작이고 「이미 있다」에 **심링크인 경우가 포함된다** — 그러면 장부가 폴더 밖에 씌고
        //    이 함수는 참을 돌려준다(심의 실측). 형제 `writeSourceMarkTo` 는 이미 이 문을 지난다.
        const dir = await ensureOwnDir(root, ...SYNC_LEDGER_PATH.split("/").slice(0, -1));
        await writeOwnFile(join(dir, basename(SYNC_LEDGER_PATH)), serializeSyncLedger(ledger));
    } catch {
        return false;
    }
    // `.gitignore` 는 **부가**다. 못 써도 장부는 이미 섰다 — 여기서 거짓을 돌려주면 다음 push 가
    // 멀쩡한 장부를 두고 거절한다.
    await ignoreLedger(root).catch(() => {});
    return true;
}

/**
 * git 이 장부를 안 나르게 한다(memo184 §2.1).
 *
 * ■ 목적은 **유출 방지가 아니라 거짓 상태 방지**다
 *   장부에는 비밀이 없다. 다른 기계의 `mine` 이 커밋을 타고 넘어오면 이 폴더는 자기가 안 올린 것을
 *   올렸다고 믿는다.
 *
 * ■ 🔴 왜 `.gitignore` 가 아니라 `.git/info/exclude` 인가 — 실측으로 갈렸다
 *   `.gitignore` 는 **판이 싣고 오는 파일**이다(고객이 올린 zip 에 대개 들어 있다). 거기 한 줄을
 *   붙이면 그 파일은 곧바로 「판과 다른」 상태가 되고, **두 번째 받기부터 영구히 충돌한다** —
 *   고객이 만진 적도 없는 파일 이름을 대면서. 거짓 경보를 습관으로 누르게 하면 진짜 경보도 눌러
 *   버린다는 것이 이 레포가 이미 적어 둔 문장이다.
 *
 *   `.git/info/exclude` 는 같은 효과를 내면서 **커밋되지 않고 판에도 안 실린다**(`.git` 은 배제
 *   목록에 있다). 도구가 자기 파일을 감추는 표준 자리가 여기다.
 *
 * ■ git 폴더가 없으면 **아무것도 안 한다**
 *   막으려는 것이 「커밋을 타고 넘어오는 것」이므로, git 이 없으면 막을 것도 없다. 없는 자리에
 *   파일을 만들어 두면 그 파일이 다음 판에 실려 나간다.
 */
async function ignoreLedger(root: string): Promise<void> {
    const info = join(root, ".git", "info");
    // `.git` 이 파일인 경우(워크트리·서브모듈)도 있다 — 그때 `mkdir` 은 실패하고, 실패하면 안 한다.
    const exists = await stat(join(root, ".git")).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) return;
    const path = join(info, "exclude");
    const current = await readFile(path, "utf8").catch(() => "");
    if (current.split(/\r?\n/).some((line) => line.trim() === SYNC_LEDGER_PATH)) return;
    await mkdir(info, {recursive: true});
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
async function setAside(root: string, plan: PullPlan): Promise<{folder: string; moved: string[]}> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // ⚠ **실경로로 편 뒤** 형제를 잡는다. 심링크로 열린 폴더는 `dirname` 이 **링크의 부모**라,
    //   그 부모가 다른 파일시스템이면 `rename` 이 `EXDEV` 로 죽고 「치워 뒀습니다」가 거짓이 된다.
    //   `replaceDir.ts` 가 이미 겪고 KDoc 에 적어 둔 함정이다.
    const real = await realpath(root).catch(() => root);
    const saved = join(dirname(real), `${basename(real)}${SAVED_SUFFIX}`, stamp);
    const moved: string[] = [];
    for (const conflict of plan.conflicts) {
        const from = await resolveExisting(root, conflict.path);
        if (!from) continue;
        const to = join(saved, conflict.path);
        await mkdir(dirname(to), {recursive: true});
        await rename(from, to);
        moved.push(conflict.path);
    }
    return {folder: saved, moved};
}

/**
 * 거절 문면(memo184 §2.9).
 *
 * ⚠ **경로를 전량 나열하지 않는다** — 건수 + 최대 [PATH_LIST_CAP] 경로 + 「외 N개」. 수백 줄이
 *   쏟아지면 사람은 맨 아래 「어떻게 하라」를 못 본다. 잘라 내는 판정은 [trimPaths] 한 벌이다.
 * ⚠ 사실만 적고 끊지 않는다 — **다음에 할 일을 문장 안에 둔다.**
 */
function conflictRefusal(plan: PullPlan, all: boolean): DevtoolsError {
    const paths = plan.conflicts.map((c) => c.path);
    const list = trimPaths(paths, PATH_LIST_CAP, all).map((p) => `  · ${p}`).join("\n");
    return new DevtoolsError(
        "PULL_WOULD_OVERWRITE",
        `이 폴더에서 고친 것이 ${paths.length}개 있어 아무것도 받지 않았습니다.\n${list}`,
        // ⚠ **없는 명령을 대지 않는다.** 여기 적힌 둘은 실제로 있는 동사다 — 없는 것을 대면 작업을
        //   지키는 쪽이 죽은 문이 되고, 남는 유일한 길이 「내 작업을 밖으로 옮기는 것」이 된다.
        "고친 내용을 먼저 사이트 쪽에 올리려면 `zalkera push`, 버리고 사이트 것으로 받으려면 `zalkera pull --discard-local` 을 실행하세요. 버리는 쪽을 골라도 고친 파일은 옆 폴더에 옮겨 둡니다.",
    );
}
