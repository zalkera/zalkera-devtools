import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SOURCE_MARK_PATH } from "./localMark.ts";
import { SYNC_LEDGER_PATH } from "./syncLedger.ts";
import { isOwnTmp } from "./zip.ts";

/**
 * 소스를 받을 폴더가 **비어 있는가**를 판정한다.
 *
 * ■ 왜 `readdir().length === 0` 이 아닌가 (실사용 신고 · 2026-08-10)
 *   폴더를 연 창에서 사이트를 고르면 VS Code 가 워크스페이스 설정을 쓰면서 **`.vscode/settings.json` 을
 *   만든다.** 그러면 방금 만든 빈 폴더가 "비어 있지 않음"이 되어 소스를 못 받는다 — **도구가 만든 파일
 *   때문에 도구가 막히는** 자물쇠다. 오너가 폴더를 지우고 다시 만들어도 같은 일이 반복됐다.
 *
 * ■ 같은 자물쇠가 우리 표식으로 한 번 더 났다 (실사용 신고 · 2026-09-24)
 *   「사이트 전환 → 로컬본 폴더 직접 고르기」·「사이트에 연결」이 빈 폴더에 소속 표식
 *   (`.zalkera/source.json`)을 쓴다. 그 파일 하나로 폴더가 「비어 있지 않음」이 되어 받기·zip 풀기가
 *   거절하고, 교체 둘은 `package.json` 이 없어 열리지 않는다 — **어느 단추도 앞으로 못 가는** 상태다.
 *   그래서 **우리 도구가 남기는 자기 상태 파일**([OWN_STATE_FILES])은 `.vscode` 와 같은 자리에서
 *   무시한다. 그 파일은 소스가 아니고, 받기가 성공하면 새 판으로 다시 쓰이는 것이다.
 *
 * ■ 무엇을 무시하고 무엇을 막는가
 *   무시하는 것은 **소스가 아닌 것**뿐이다 — 편집기 설정 · OS 부스러기 · 우리 자기 상태 파일.
 *   사람이 만든 파일이 하나라도 있으면 그대로 막는다. 이 가드의 목적은 **고치던 소스를 서버 버전으로
 *   조용히 밀어 버리지 않는 것**이고, 그 목적은 여기서도 그대로 선다.
 *
 *   ⚠ **`.zalkera` 를 통째로 무시하지 않는다.** 그 폴더에는 배송되는 소스 파일(`pack.json` ·
 *   `ASSETS-LICENSE.md`)과 손으로 푼 zip 이 남기는 `provenance.json` 이 올 수 있다 — 그것이 있으면
 *   사람의 것이다. 안에 **우리 파일만** 있을 때만 빈 것으로 본다([ownStateOnly]).
 *
 *   ⚠ **`.git` 은 무시하지 않는다.** 그 폴더가 이미 어떤 레포라는 뜻이고, 그 위에 남의 소스를 푸는 것은
 *   이력을 가진 작업물을 덮는 일이다. 무시 목록에 넣고 싶은 유혹이 있지만 그건 다른 종류의 손실이다.
 *
 *   ⚠ **무시는 이름이 아니라 종류로 정한다 — 심링크는 절대 무시하지 않는다.** 이름만 보면 `.vscode`
 *   라는 이름의 **링크**가 "빈 폴더"를 통과하고, 그 링크가 해제 대상 경로가 된다. 무시의 근거는
 *   *"편집기가 만든 파일"* 이지 *"그 이름"* 이 아니다 — 편집기는 링크를 만들지 않는다.
 */
// OS 가 폴더를 열어 보기만 해도 만드는 파일.
const OS_JUNK = new Set([
    ".DS_Store", // macOS
    "Thumbs.db", // Windows
    "desktop.ini", // Windows
]);
const IGNORED = new Set([
    ".vscode", // 편집기·확장이 만든다(우리가 만드는 쪽이다)
    ...OS_JUNK,
]);

/**
 * 우리 도구가 폴더에 남기는 **자기 상태 파일** — 소속 표식과 CLI 장부. 둘 다 정본에 안 실린다
 * (`zip.ts` 의 `EXCLUDED_PATHS` 가 같은 상수를 쓴다 — 시험이 그 일치를 문다).
 *
 * ⚠ **손으로 열거하지 않는다.** 경로 상수를 그대로 가져와 쓴다 — 표식 자리가 옮겨지는 날 여기가
 *   조용히 옛 이름을 보게 두지 않는다.
 */
export const OWN_STATE_FILES: readonly string[] = [SOURCE_MARK_PATH, SYNC_LEDGER_PATH];

/** 자기 상태 파일이 사는 폴더 이름. 두 상수가 같은 폴더를 가리킨다는 것을 아래 검사가 못 박는다. */
export const OWN_STATE_DIR = ((): string => {
    const dirs = new Set(OWN_STATE_FILES.map((p) => dirname(p)));
    if (dirs.size !== 1) throw new Error(`자기 상태 파일이 한 폴더에 있지 않다: ${[...dirs].join(", ")}`);
    return [...dirs][0] as string;
})();
const OWN_STATE_NAMES = new Set(OWN_STATE_FILES.map((p) => basename(p)));

/**
 * 그 폴더 안이 **우리 파일뿐인가.** 비어 있어도 참이다. 항목 하나라도 우리 것이 아니면(다른 이름 ·
 * 하위 폴더 · 심링크) 거짓 — 그때는 그 폴더 전체가 사람의 것이다.
 *
 * 원자 쓰기 잔재(`*.zalkera-<hex>.tmp`)도 우리 것이다 — 쓰다 죽은 흔적 하나로 폴더가 잠기지 않게.
 * OS 부스러기(`.DS_Store` 등 [IGNORED] 의 파일 이름)도 받는다 — 탐색기가 그 폴더를 한 번 열어 본 것만으로
 * 다시 잠기면 문면이 가리키는 `.zalkera` 안에서 사람이 원인을 못 찾는다.
 */
async function ownStateOnly(dir: string): Promise<boolean> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return false; // 못 읽는 폴더는 모르는 폴더다 — 모르는 것을 빈 것으로 치지 않는다
    }
    return entries.every(
        (e) =>
            e.isFile() &&
            !e.isSymbolicLink() &&
            (OWN_STATE_NAMES.has(e.name) || isOwnTmp(e.name) || OS_JUNK.has(e.name)),
    );
}

/** 이 이름이 지금 이 폴더에서 **통과 대상**인가 — 편집기 폴더거나, 우리 파일뿐인 `.zalkera` 다. */
async function passable(dir: string, e: { name: string; isSymbolicLink(): boolean; isDirectory(): boolean }): Promise<boolean> {
    if (e.isSymbolicLink()) return false;
    if (IGNORED.has(e.name)) return true;
    return e.name === OWN_STATE_DIR && e.isDirectory() && (await ownStateOnly(join(dir, e.name)));
}

/** 무시 대상을 뺀 실제 항목. 비어 있으면 받아도 안전하다. */
export async function meaningfulEntries(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
        if (!(await passable(dir, e))) out.push(e.name);
    }
    return out;
}

export async function isReceivable(dir: string): Promise<boolean> {
    return (await meaningfulEntries(dir)).length === 0;
}

/**
 * 해제 **전** 폴더의 모습. 실패했을 때 «우리가 쓴 것» 만 되감기 위한 기준선이다.
 *
 * ⚠ [meaningfulEntries] 가 **일부러 통과시키는 것**이 있다는 사실이 여기서 결정적이다.
 *   `.vscode` 는 「빈 폴더」 판정을 통과하고 배송 문서도 "있어도 괜찮습니다"라고 초대한다. 그런데
 *   롤백이 폴더를 통째로 지우면 **그 초대에 응한 고객의 파일이 사라진다**(실측: 손으로 만든
 *   `.vscode/launch.json` 이 지워졌다). 이 도구가 낼 수 있는 가장 큰 손해가 그것이다.
 *
 * ⚠ **통과시킨 폴더는 «안쪽»까지 기준선에 든다.** `.zalkera` 를 통과시키면 서버 tar 가 그 안에
 *   `provenance.json`·`pack.json` 을 쓰는데, 기준선이 한 층이면 되감기가 `.zalkera` 를 「원래 있던
 *   것」으로 보고 그 안에 새로 쓰인 파일을 남긴다 — 다음 시도가 「비어 있지 않음」으로 막히는,
 *   이 판정이 방금 푼 그 자물쇠가 실패 한 번으로 되살아난다(사본 실측).
 */
export interface Snapshot {
    /** 폴더 바로 아래 이름. */
    names: Set<string>;
    /** 통과시킨 하위 폴더별 안쪽 이름 — 그 폴더가 실재하는 실제 폴더일 때만. */
    inside: Map<string, Set<string>>;
}

export async function snapshotEntries(dir: string): Promise<Snapshot> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return { names: new Set(), inside: new Map() }; // 아직 없는 폴더 — 우리가 만들 것이므로 기준선은 비어 있다
    }
    const names = new Set(entries.map((e) => e.name));
    const inside = new Map<string, Set<string>>();
    for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        if (!(IGNORED.has(e.name) || e.name === OWN_STATE_DIR)) continue;
        try {
            inside.set(e.name, new Set(await readdir(join(dir, e.name))));
        } catch {
            // 못 읽으면 안쪽 기준선이 없다 — 그 폴더 안은 되감지 않는다(모르는 것을 지우지 않는다)
        }
    }
    return { names, inside };
}

/**
 * 기준선 이후에 **생긴 것만** 지운다. 폴더 자체는 남긴다 — 고객이 고른 자리다.
 * 통과시킨 하위 폴더는 **안쪽에서 생긴 것만** 지운다(위 KDoc).
 *
 * 지우다 실패해도 던지지 않는다. 이 함수는 이미 실패한 경로에서 불리고, 여기서 또 던지면
 * **원래 오류가 가려진다** — 사용자는 무엇이 잘못됐는지 못 듣게 된다.
 */
export async function removeAdded(dir: string, before: Snapshot): Promise<void> {
    let now: string[];
    try {
        now = await readdir(dir);
    } catch {
        return;
    }
    for (const name of now) {
        if (before.names.has(name)) continue;
        await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
    for (const [name, had] of before.inside) {
        let innerNow: string[];
        try {
            innerNow = await readdir(join(dir, name));
        } catch {
            continue;
        }
        for (const inner of innerNow) {
            if (had.has(inner)) continue;
            await rm(join(dir, name, inner), { recursive: true, force: true }).catch(() => {});
        }
    }
}
